import { domainToASCII, domainToUnicode } from 'node:url';
import bs58 from 'bs58';
import { scanPrompt } from '../../lib/guards/index.ts';
import type {
  SignatureInput,
  SignatureReport,
  SignatureFinding,
  SignerBalance,
  SignatureCapability,
} from '../../lib/second-look/signature.ts';
import {
  readPreSignInspection,
  type PreSignReadRpc,
} from '../solana/pre-sign.ts';
import { parseSerializedTransaction } from '../solana/serialized.ts';
import {
  address,
  record,
  uint,
  U64_MAX,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  type SolanaCluster,
} from '../solana/validation.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { serviceConfig } from '../core/config.ts';
import {
  signatureReferences,
  readDomainAge,
  type SignatureReferences,
} from './signature-reputation.ts';
import {
  actionEndpoint,
  resolveSignatureAction,
  signatureActionEndpoints,
  type ReviewedActionEndpoint,
} from './signature-actions.ts';

const references = [
  'fomo.family',
  'pump.fun',
  'jup.ag',
  'raydium.io',
  'orca.so',
  'phantom.com',
] as const;
const labels = {
  looks_like_a_drainer: 'Looks like a drainer',
  caution: 'Caution',
  no_known_patterns: 'No known drainer patterns found',
} as const;
const invalid = () =>
  new ServiceError(
    400,
    'INVALID_SIGNATURE_INPUT',
    'The inspection input is invalid.',
  );
const exact = (
  body: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) => {
  if (
    !required.every((key) => Object.hasOwn(body, key)) ||
    Object.keys(body).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw invalid();
};
function text(value: unknown, maximum: number) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > maximum ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
    })
  )
    throw invalid();
  return value;
}
function guard(value: string) {
  if (
    scanPrompt(value).findings.some((finding) => finding.severity === 'block')
  )
    throw new ServiceError(
      400,
      'SENSITIVE_INPUT',
      'Remove private keys, recovery phrases, and credentials before inspection.',
    );
}
export function parseSignatureInput(
  body: Record<string, unknown>,
): SignatureInput {
  if (body.kind === 'action') {
    exact(
      body,
      ['kind', 'url', 'account'],
      ['actionHref', 'intent', 'expectedRecipients'],
    );
    const url = text(body.url, 2048);
    guard(url);
    actionEndpoint(url);
    if (body.actionHref !== undefined) {
      text(body.actionHref, 2048);
      guard(body.actionHref as string);
    }
    if (body.intent !== undefined && body.intent !== 'swap') throw invalid();
    if (
      body.expectedRecipients !== undefined &&
      (body.intent !== 'swap' ||
        !Array.isArray(body.expectedRecipients) ||
        !body.expectedRecipients.length ||
        body.expectedRecipients.length > 16)
    )
      throw invalid();
    const recipients = (body.expectedRecipients as unknown[] | undefined)?.map(
      (v) => address(v),
    );
    if (recipients && new Set(recipients).size !== recipients.length)
      throw invalid();
    return {
      kind: 'action',
      url,
      account: address(body.account),
      ...(body.actionHref === undefined
        ? {}
        : { actionHref: body.actionHref as string }),
      ...(body.intent === 'swap' ? { intent: 'swap' } : {}),
      ...(recipients ? { expectedRecipients: recipients } : {}),
    };
  }
  if (body.kind === 'transaction') {
    exact(
      body,
      ['kind', 'transaction', 'encoding'],
      ['intent', 'expectedRecipients'],
    );
    if (body.encoding !== 'base64' && body.encoding !== 'base58')
      throw invalid();
    if (body.intent !== undefined && body.intent !== 'swap') throw invalid();
    if (
      body.expectedRecipients !== undefined &&
      (!Array.isArray(body.expectedRecipients) ||
        body.expectedRecipients.length > 16 ||
        !body.expectedRecipients.length ||
        body.intent !== 'swap')
    )
      throw invalid();
    const recipients = (body.expectedRecipients as unknown[] | undefined)?.map(
      (item) => address(item),
    );
    if (recipients && new Set(recipients).size !== recipients.length)
      throw invalid();
    const input: SignatureInput = {
      kind: 'transaction',
      transaction: text(body.transaction, 1800),
      encoding: body.encoding,
      ...(body.intent === undefined ? {} : { intent: 'swap' }),
      ...(recipients ? { expectedRecipients: recipients } : {}),
    };
    // Validate wire syntax and decoded instruction content before any network use.
    const parsed = parseSerializedTransaction(
      transactionBase64(input.transaction, input.encoding),
    );
    parsed.instructions.forEach((instruction) =>
      guard(new TextDecoder().decode(instruction.data)),
    );
    return input;
  }
  if (body.kind === 'message') {
    exact(body, ['kind', 'message', 'pageOrigin']);
    const message = text(body.message, 8192),
      pageOrigin =
        body.pageOrigin === null ? null : text(body.pageOrigin, 2048);
    guard(message);
    if (pageOrigin !== null && safeUrl(pageOrigin).origin !== pageOrigin)
      throw invalid();
    return { kind: 'message', message, pageOrigin };
  }
  if (body.kind === 'domain') {
    exact(body, ['kind', 'url']);
    const url = text(body.url, 2048);
    guard(url);
    safeUrl(url);
    return { kind: 'domain', url };
  }
  if (body.kind === 'app') {
    exact(body, ['kind', 'packageName'], ['certificateSha256']);
    const supplied = text(body.packageName, 2048);
    guard(supplied);
    let packageName = supplied;
    if (supplied.includes('://')) {
      const listing = safeUrl(supplied);
      if (
        listing.protocol !== 'https:' ||
        listing.hostname !== 'play.google.com' ||
        listing.pathname !== '/store/apps/details' ||
        listing.hash ||
        listing.searchParams.getAll('id').length !== 1
      )
        throw invalid();
      packageName = listing.searchParams.get('id')!;
    }
    if (
      packageName.length > 200 ||
      !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){1,15}$/.test(
        packageName,
      )
    )
      throw invalid();
    if (
      body.certificateSha256 !== undefined &&
      (typeof body.certificateSha256 !== 'string' ||
        !/^[0-9a-fA-F]{64}$/.test(body.certificateSha256))
    )
      throw invalid();
    return {
      kind: 'app',
      packageName,
      ...(body.certificateSha256 === undefined
        ? {}
        : {
            certificateSha256: (body.certificateSha256 as string).toLowerCase(),
          }),
    };
  }
  throw invalid();
}
export function transactionBase64(
  value: string,
  encoding: 'base64' | 'base58',
) {
  if (encoding === 'base64') return value;
  try {
    const bytes = bs58.decode(value);
    if (bytes.length > 1232 || bs58.encode(bytes) !== value) throw invalid();
    return Buffer.from(bytes).toString('base64');
  } catch {
    throw invalid();
  }
}
function isTransactionMessage(input: string) {
  for (const encoding of ['base64', 'base58'] as const) {
    try {
      const canonical = transactionBase64(input, encoding);
      try {
        parseSerializedTransaction(canonical);
        return true;
      } catch {
        /* Inspect an unsigned message preimage too. */
      }
      const bytes = Buffer.from(canonical, 'base64');
      if (!bytes.length || bytes.toString('base64') !== canonical) continue;
      const required = bytes[0] === 128 ? bytes[1] : bytes[0];
      if (!required || required > 12) continue;
      const wire = Buffer.concat([
        Buffer.from([required]),
        Buffer.alloc(required * 64),
        bytes,
      ]);
      if (wire.length > 1232) continue;
      parseSerializedTransaction(wire.toString('base64'));
      return true;
    } catch {
      /* Ordinary text is neither a transaction nor a supported message preimage. */
    }
  }
  return false;
}
function safeUrl(input: string) {
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.hostname ||
      url.hostname.length > 253 ||
      url.port ||
      !url.hostname.includes('.') ||
      /^[\d.]+$/.test(url.hostname) ||
      url.hostname.includes(':') ||
      url.hostname.endsWith('.localhost') ||
      url.hostname.endsWith('.local')
    )
      throw invalid();
    return url;
  } catch {
    throw invalid();
  }
}
function skeleton(host: string) {
  const map: Record<string, string> = {
    а: 'a',
    е: 'e',
    о: 'o',
    р: 'p',
    с: 'c',
    х: 'x',
    у: 'y',
    і: 'i',
    ј: 'j',
    ѕ: 's',
    ο: 'o',
    ρ: 'p',
    ν: 'v',
    ɑ: 'a',
    ӏ: 'l',
    '0': 'o',
    '1': 'l',
  };
  return [...host.normalize('NFKD').toLowerCase()]
    .map((c) => map[c] ?? c)
    .join('')
    .replace(/[\u0300-\u036f]/g, '');
}
function distance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(
        Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)),
      );
    row = next;
  }
  return row[b.length];
}
function finding(
  report: SignatureReport,
  code: string,
  severity: SignatureFinding['severity'],
  message: string,
  instruction: string | null = null,
) {
  if (
    !report.findings.some(
      (f) => f.code === code && f.instruction === instruction,
    )
  )
    report.findings.push({ code, severity, message, instruction });
}
function domainInspection(report: SignatureReport, value: string) {
  const url = safeUrl(value),
    asciiHost = domainToASCII(url.hostname).toLowerCase().replace(/\.$/, ''),
    unicodeHost = domainToUnicode(asciiHost);
  const exactMatch = references.find(
    (known) => asciiHost === known || asciiHost.endsWith(`.${known}`),
  );
  const candidate = skeleton(unicodeHost.replace(/^www\./, ''));
  const suspicious = exactMatch
    ? undefined
    : references.find((known) => {
        const brand = known.split('.')[0];
        return (
          distance(candidate, known) <= 2 ||
          distance(candidate.split('.')[0], brand) <= 2 ||
          candidate.includes(brand)
        );
      });
  report.domain = {
    asciiHost,
    unicodeHost,
    matchedReference: exactMatch ?? suspicious ?? null,
    lookalike: Boolean(suspicious),
    rdap: 'unknown',
    registeredAt: null,
    ageDays: null,
    blocklist: 'unknown',
    certificate: 'unknown',
    sources:
      exactMatch || suspicious
        ? [
            {
              label: 'Reviewed reference domain for comparison only',
              url: `https://${exactMatch ?? suspicious}/`,
              observedAt: '2026-10-12T00:00:00.000Z',
              expiresAt: null,
            },
          ]
        : [],
  };
  if (suspicious)
    finding(
      report,
      'DOMAIN_LOOKALIKE',
      'critical',
      'The submitted host resembles a reviewed trading-app domain but is not that domain.',
    );
  if (url.protocol !== 'https:')
    finding(
      report,
      'INSECURE_ORIGIN',
      'warning',
      'The submitted address does not use HTTPS.',
    );
  finding(
    report,
    'DOMAIN_REPUTATION_UNKNOWN',
    'warning',
    'Certificate ownership and website behavior are not authenticated. Domain age and blocklist coverage are reported separately; a familiar name is not a safety result.',
  );
  report.coverage.unknowns.push(
    'domain-age',
    'blocklist-license-and-coverage',
    'certificate-ownership',
  );
}
function exactU64(value: unknown) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
      throw invalid();
    return String(value);
  }
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) > U64_MAX
  )
    throw invalid();
  return value;
}
/** Both sides originate from one validated simulation response; no bank-to-bank subtraction. */
export function signerBalances(
  inspection: NonNullable<SignatureReport['transaction']>,
  raw: unknown,
): SignatureReport['balances'] {
  const signers: SignerBalance[] = inspection.accounts
    .filter((a) => a.signer)
    .map((a) => ({ signer: a.address, sol: null, tokens: [] }));
  const result: SignatureReport['balances'] = {
    status: 'unavailable',
    contextSlot: null,
    signers,
    tokenCoverage: 'unavailable',
    allWalletHoldings: false,
  };
  if (
    !['succeeded', 'failed'].includes(inspection.simulation.status) ||
    inspection.lookups.simulationBinding === 'unverified'
  )
    return result;
  try {
    const envelope = record(raw),
      value = record(envelope.value);
    if (
      uint(record(envelope.context).slot) !== inspection.simulation.contextSlot
    )
      throw invalid();
    const before = value.preBalances,
      after = value.postBalances;
    if (
      !Array.isArray(before) ||
      !Array.isArray(after) ||
      before.length !== inspection.accounts.length ||
      after.length !== before.length
    )
      throw invalid();
    const pre = before.map(exactU64),
      post = after.map(exactU64);
    signers.forEach((signer) => {
      const index = inspection.accounts.findIndex(
        (a) => a.address === signer.signer,
      );
      signer.sol = {
        beforeLamports: pre[index],
        afterLamports: post[index],
        deltaLamports: (BigInt(post[index]) - BigInt(pre[index])).toString(),
      };
    });
    result.contextSlot = inspection.simulation.contextSlot;
    result.status = 'partial';
    const tokenRows = (rows: unknown) => {
      if (!Array.isArray(rows) || rows.length > inspection.accounts.length)
        throw invalid();
      const mapped = new Map<
        number,
        { mint: string; owner: string; decimals: number; amount: string }
      >();
      for (const rawRow of rows) {
        const row = record(rawRow),
          index = uint(row.accountIndex, inspection.accounts.length - 1),
          token = record(row.uiTokenAmount);
        if (
          mapped.has(index) ||
          (row.programId !== undefined &&
            ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(
              row.programId as string,
            ))
        )
          throw invalid();
        mapped.set(index, {
          mint: address(row.mint),
          owner: address(row.owner),
          decimals: uint(token.decimals, 255),
          amount: exactU64(token.amount),
        });
      }
      return mapped;
    };
    const tokenPre = tokenRows(value.preTokenBalances),
      tokenPost = tokenRows(value.postTokenBalances);
    const rows: {
      signer: SignerBalance;
      value: SignerBalance['tokens'][number];
    }[] = [];
    for (const index of new Set([...tokenPre.keys(), ...tokenPost.keys()])) {
      const a = tokenPre.get(index),
        b = tokenPost.get(index),
        common = a ?? b!;
      if (a && b && (a.mint !== b.mint || a.decimals !== b.decimals))
        throw invalid();
      for (const signer of signers) {
        if (a?.owner !== signer.signer && b?.owner !== signer.signer) continue;
        const beforeAmount = a?.owner === signer.signer ? a.amount : '0',
          afterAmount = b?.owner === signer.signer ? b.amount : '0';
        rows.push({
          signer,
          value: {
            account: inspection.accounts[index].address,
            mint: common.mint,
            decimals: common.decimals,
            beforeAmount,
            afterAmount,
            deltaAmount: (
              BigInt(afterAmount) - BigInt(beforeAmount)
            ).toString(),
          },
        });
      }
    }
    rows.forEach((row) => row.signer.tokens.push(row.value));
    result.tokenCoverage = 'reported-transaction-accounts';
    result.status = 'complete';
  } catch {
    /* Exact SOL deltas remain useful when token metadata is unavailable. */
  }
  return result;
}

export async function inspectSignature(
  input: SignatureInput,
  options: {
    cluster?: SolanaCluster;
    rpc?: PreSignReadRpc;
    signal?: AbortSignal;
    now?: () => number;
    references?: SignatureReferences;
    rdapEnabled?: boolean;
    fetcher?: typeof fetch;
    actionEndpoints?: ReviewedActionEndpoint[];
  } = {},
): Promise<SignatureReport> {
  input = parseSignatureInput(input as unknown as Record<string, unknown>);
  const now = (options.now ?? Date.now)(),
    reputation = options.references ?? signatureReferences(process.env, now);
  if (input.kind === 'action') {
    requireCondition(
      options.cluster && options.rpc,
      503,
      'RPC_UNAVAILABLE',
      'A configured Solana reader is required for Action inspection.',
    );
    const resolved = await resolveSignatureAction(input, {
      cluster: options.cluster,
      endpoints: options.actionEndpoints,
      fetcher: options.fetcher,
      signal: options.signal,
      now: options.now,
    });
    const report = await inspectSignature(
      {
        kind: 'transaction',
        transaction: resolved.transaction,
        encoding: 'base64',
        ...(input.intent ? { intent: input.intent } : {}),
        ...(input.expectedRecipients
          ? { expectedRecipients: input.expectedRecipients }
          : {}),
      },
      options,
    );
    report.kind = 'action';
    report.action = resolved.provenance;
    finding(
      report,
      'ACTION_IDENTITY_UNVERIFIED',
      'warning',
      'The reviewed endpoint received the supplied public wallet address and returned these transaction bytes. Review permission and balance effects; endpoint metadata is not a safety guarantee.',
    );
    report.coverage.unknowns.push('action-application-intent');
    if (report.verdict === 'no_known_patterns') {
      report.verdict = 'caution';
      report.verdictLabel = labels.caution;
    }
    return report;
  }
  const report: SignatureReport = {
    version: 1,
    inspectedAt: new Date(now).toISOString(),
    kind: input.kind,
    verdict: 'caution',
    verdictLabel: labels.caution,
    findings: [],
    permissions: [],
    balances: {
      status: 'not-applicable',
      contextSlot: null,
      signers: [],
      tokenCoverage: 'unavailable',
      allWalletHoldings: false,
    },
    transaction: null,
    action: null,
    domain: null,
    app: null,
    coverage: {
      signsOrSubmits: false,
      arbitraryUrlFetch: false,
      innerInstructions: 'not-applicable',
      unknowns: [],
    },
  };
  if (input.kind === 'transaction') {
    requireCondition(
      options.cluster && options.rpc,
      503,
      'RPC_UNAVAILABLE',
      'A configured Solana reader is required for transaction inspection.',
    );
    let raw: unknown;
    const inspection = await readPreSignInspection(
      options.cluster,
      async (method, params, signal) => {
        const value = await options.rpc!(method, params, signal);
        if (method === 'simulateTransaction') raw = value;
        return value;
      },
      transactionBase64(input.transaction, input.encoding),
      options.signal,
      { now: options.now },
    );
    report.transaction = inspection;
    report.balances = signerBalances(inspection, raw);
    report.coverage.innerInstructions = 'uninspected';
    for (const instruction of inspection.instructions) {
      for (const flag of instruction.flags)
        if (flag.severity !== 'info')
          finding(
            report,
            flag.code,
            flag.severity,
            flag.message,
            instruction.location,
          );
      if (
        instruction.kind === 'setAuthority' &&
        instruction.fields.authorityType === 'accountOwner'
      )
        finding(
          report,
          'TOKEN_ACCOUNT_TAKEOVER',
          'critical',
          'This changes the owner authority of a token account. The new authority can control its tokens.',
          instruction.location,
        );
      if (['systemAssign', 'systemAssignWithSeed'].includes(instruction.kind))
        finding(
          report,
          'SYSTEM_ASSIGN',
          'critical',
          'This assigns an account to a different owner program.',
          instruction.location,
        );
      if (['approve', 'approveChecked'].includes(instruction.kind))
        finding(
          report,
          instruction.programId === TOKEN_2022_PROGRAM
            ? 'TOKEN_2022_DELEGATE'
            : 'TOKEN_DELEGATE',
          'critical',
          'This grants a delegate permission to transfer or burn tokens up to the approved allowance.',
          instruction.location,
        );
      if (instruction.flags.some((flag) => flag.severity === 'critical'))
        report.permissions.push({
          instruction: instruction.location,
          kind: instruction.kind,
          programId: instruction.programId,
          fields: { ...instruction.fields },
        });
      if (
        input.intent === 'swap' &&
        instruction.fields.destination &&
        instruction.flags.some(
          (f) => f.code === 'SOL_TRANSFER' || f.code === 'TOKEN_TRANSFER',
        ) &&
        (!input.expectedRecipients ||
          !input.expectedRecipients.includes(instruction.fields.destination))
      )
        finding(
          report,
          'SWAP_EXTRA_TRANSFER',
          'critical',
          'The submitted swap also contains a direct transfer to an address outside the recipients you supplied. No swap label proves that recipient is intended.',
          instruction.location,
        );
    }
    if (inspection.input.nonce !== 'none')
      finding(
        report,
        'DURABLE_NONCE',
        'warning',
        'This transaction uses, or may use, a durable nonce. Its signing lifetime and authority require separate review.',
      );
    if (
      reputation.blocklist &&
      inspection.accounts.some((account) =>
        reputation.blocklist!.wallets.includes(account.address),
      )
    )
      finding(
        report,
        'WALLET_BLOCKLISTED',
        'critical',
        'A transaction account appears in the configured licensed and reviewed wallet blocklist.',
      );
    else if (!reputation.blocklist) {
      finding(
        report,
        'WALLET_BLOCKLIST_UNKNOWN',
        'warning',
        'No fresh licensed wallet blocklist is configured. Absence of a match is not established.',
      );
      report.coverage.unknowns.push('wallet-blocklist');
    }
    if (report.balances.status !== 'complete')
      finding(
        report,
        'SIGNER_BALANCES_UNKNOWN',
        'warning',
        'Exact same-simulation balance changes for every signer were not fully returned or validated. Missing changes are not zero.',
      );
    for (const warning of inspection.warnings)
      if (warning.severity === 'warning')
        finding(report, warning.code, 'warning', warning.message);
    report.coverage.unknowns.push(
      'inner-instruction-effects',
      'runtime-program-intent',
      'all-wallet-holdings',
    );
  } else if (input.kind === 'domain') {
    domainInspection(report, input.url);
    if (reputation.blocklist) {
      report.domain!.sources.push({
        label: 'Reviewed licensed blocklist',
        url: reputation.blocklist.source,
        observedAt: reputation.blocklist.reviewedAt,
        expiresAt: reputation.blocklist.expiresAt,
      });
      report.domain!.blocklist = reputation.blocklist.domains.includes(
        report.domain!.asciiHost,
      )
        ? 'listed'
        : 'not-listed';
      if (report.domain!.blocklist === 'listed')
        finding(
          report,
          'DOMAIN_BLOCKLISTED',
          'critical',
          'This exact domain appears in the configured licensed and reviewed blocklist.',
        );
      report.coverage.unknowns = report.coverage.unknowns.filter(
        (v) => v !== 'blocklist-license-and-coverage',
      );
    }
    if (
      options.rdapEnabled ??
      process.env.CONCLAVE_SIGNATURE_RDAP_ENABLED === 'true'
    ) {
      const age = await readDomainAge(report.domain!.asciiHost, {
        now,
        fetcher: options.fetcher,
        signal: options.signal,
      });
      if (age) {
        report.domain!.sources.push({
          label: 'Registry registration record',
          url: age.source,
          observedAt: new Date(now).toISOString(),
          expiresAt: null,
        });
        report.domain!.rdap = 'known';
        report.domain!.registeredAt = age.registeredAt;
        report.domain!.ageDays = age.ageDays;
        report.coverage.unknowns = report.coverage.unknowns.filter(
          (v) => v !== 'domain-age',
        );
        if (age.ageDays < 30)
          finding(
            report,
            'DOMAIN_RECENT',
            'warning',
            'RDAP reports that this domain was registered less than 30 days ago. Registration age does not establish ownership or safety.',
          );
      }
    }
  } else if (input.kind === 'app') {
    const known = input.packageName === 'family.fomo.app';
    const pin = reputation.apps.find(
      (app) => app.packageName === input.packageName,
    );
    const certificate =
      !pin || !input.certificateSha256
        ? 'unknown'
        : pin.certificateSha256.includes(input.certificateSha256)
          ? 'match'
          : 'mismatch';
    report.app = {
      packageName: input.packageName,
      listing:
        pin?.listing ??
        (known
          ? 'https://play.google.com/store/apps/details?id=family.fomo.app'
          : null),
      packageMatch: Boolean(pin) || known,
      certificate,
      sources: pin
        ? [
            {
              label: 'Reviewed application listing and certificate pins',
              url: pin.listing,
              observedAt: pin.reviewedAt,
              expiresAt: pin.expiresAt,
            },
          ]
        : known
          ? [
              {
                label: 'Known application listing; signing identity unverified',
                url: 'https://play.google.com/store/apps/details?id=family.fomo.app',
                observedAt: '2026-10-12T00:00:00.000Z',
                expiresAt: null,
              },
            ]
          : [],
    };
    finding(
      report,
      certificate === 'mismatch'
        ? 'APP_CERTIFICATE_MISMATCH'
        : certificate === 'match'
          ? 'APP_CERTIFICATE_MATCH'
          : 'APP_CERTIFICATE_UNKNOWN',
      certificate === 'mismatch'
        ? 'critical'
        : certificate === 'match'
          ? 'info'
          : 'warning',
      certificate === 'mismatch'
        ? 'The supplied certificate digest differs from the configured official listing pins.'
        : certificate === 'match'
          ? 'The supplied certificate digest matches a reviewed listing pin. The APK itself was not uploaded or authenticated.'
          : 'A package name can be copied. A reviewed certificate pin and supplied digest are required to compare signing identity.',
    );
    report.coverage.unknowns.push(
      ...(certificate === 'unknown' ? ['app-signing-certificate'] : []),
      'apk-content',
    );
  } else {
    const isTransaction = isTransactionMessage(input.message.trim());
    if (isTransaction)
      finding(
        report,
        'MESSAGE_IS_TRANSACTION',
        'critical',
        'The proposed message decodes as a serialized Solana transaction. Do not treat transaction bytes as ordinary sign-in text.',
      );
    const first = input.message.split(/\r?\n/, 1)[0],
      match = /^([^\s]+) wants you to sign in with your Solana account:$/.exec(
        first,
      );
    if (match && input.pageOrigin === null)
      finding(
        report,
        'SIWS_PAGE_UNKNOWN',
        'warning',
        'The actual page origin was not supplied, so the sign-in domain cannot be compared.',
      );
    else if (match && input.pageOrigin !== null) {
      const page = safeUrl(input.pageOrigin);
      const uris = [...input.message.matchAll(/^URI: (.+)$/gm)];
      let same = false;
      try {
        const signed = safeUrl(match[1]);
        same =
          signed.host === page.host &&
          !signed.search &&
          !signed.hash &&
          signed.pathname === '/' &&
          uris.length === 1 &&
          safeUrl(uris[0]?.[1] ?? '').origin === page.origin;
      } catch {
        /* Malformed claimed origins are mismatches, not an authenticated sign-in. */
      }
      finding(
        report,
        same ? 'SIWS_DOMAIN_MATCH' : 'SIWS_DOMAIN_MISMATCH',
        same ? 'info' : 'critical',
        same
          ? 'The sign-in domain and URI match the page origin you supplied. Ownership and message validity are not authenticated by this inspection.'
          : 'The sign-in domain or URI does not match the page origin you supplied.',
      );
    } else
      finding(
        report,
        'MESSAGE_PURPOSE_UNKNOWN',
        'warning',
        'This is not a recognized sign-in message. A signature can still grant application-level authority.',
      );
    if (
      /\b(permission|authorize|approval|delegate|terms|unlimited|grant)\b/i.test(
        input.message,
      )
    )
      finding(
        report,
        'MESSAGE_PERMISSION_TERMS',
        'warning',
        'The message contains permission or agreement language. Embedded data can bind additional terms that are not decoded.',
      );
    if (/[A-Za-z0-9+/=_-]{64,}|0x[0-9a-f]{40,}/i.test(input.message))
      finding(
        report,
        'MESSAGE_EMBEDDED_DATA',
        'warning',
        'The message contains a long encoded value; its application meaning is not verified.',
      );
    finding(
      report,
      'MESSAGE_AUTHENTICITY_UNKNOWN',
      'warning',
      'This inspection does not authenticate the page, message author, nonce, or any requested signature.',
    );
    report.coverage.unknowns.push('message-author', 'application-permissions');
  }
  report.verdict = report.findings.some((f) =>
    [
      'TOKEN_ACCOUNT_TAKEOVER',
      'SYSTEM_ASSIGN',
      'TOKEN_DELEGATE',
      'TOKEN_2022_DELEGATE',
      'SWAP_EXTRA_TRANSFER',
      'MESSAGE_IS_TRANSACTION',
      'SIWS_DOMAIN_MISMATCH',
      'DOMAIN_LOOKALIKE',
      'DOMAIN_BLOCKLISTED',
      'WALLET_BLOCKLISTED',
      'APP_CERTIFICATE_MISMATCH',
    ].includes(f.code),
  )
    ? 'looks_like_a_drainer'
    : report.findings.some((f) => f.severity !== 'info') ||
        report.coverage.unknowns.length
      ? 'caution'
      : 'no_known_patterns';
  report.verdictLabel = labels[report.verdict];
  return report;
}
export function signatureCapability(): SignatureCapability {
  let available = false;
  let actionsAvailable = false;
  try {
    const config = serviceConfig();
    available = Boolean(config.rpcUrl && config.cluster);
    actionsAvailable = Boolean(
      config.rpcUrl &&
      config.cluster &&
      signatureActionEndpoints().some((r) => r.cluster === config.cluster),
    );
  } catch {
    /* Local checks remain available. */
  }
  const reputation = signatureReferences();
  return {
    available: true,
    transactionSimulation: available,
    transactionEncodings: ['base64', 'base58'],
    domainLookalikes: true,
    rdap: process.env.CONCLAVE_SIGNATURE_RDAP_ENABLED === 'true',
    blocklists: Boolean(reputation.blocklist),
    appCertificateRegistry: reputation.apps.length > 0,
    actionUrlResolution: actionsAvailable,
    signsOrSubmits: false,
  };
}
