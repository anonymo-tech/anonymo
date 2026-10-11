import {
  addFlag,
  parsedInfo,
  unsupported,
  type ExplainedInstruction,
  type ExplanationFlag,
} from './explain-shared.ts';
import {
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  address,
  amount,
  list,
  record,
  requireSolana,
  uint,
} from './validation.ts';

const baseAuthorities = [
  'mintTokens',
  'freezeAccount',
  'accountOwner',
  'closeAccount',
];
const mintAuthorities = [
  'mintTokens',
  'freezeAccount',
  'transferFeeConfig',
  'withheldWithdraw',
  'closeMint',
  'interestRate',
  'permanentDelegate',
  'confidentialTransferMint',
  'transferHookProgramId',
  'confidentialTransferFeeConfig',
  'metadataPointer',
  'groupPointer',
  'groupMemberPointer',
  'scaledUiAmount',
  'pause',
  'permissionedBurn',
];
const confidentialTypes = new Set([
  'initializeConfidentialTransferMint',
  'updateConfidentialTransferMint',
  'configureConfidentialTransferAccount',
  'approveConfidentialTransferAccount',
  'emptyConfidentialTransferAccount',
  'depositConfidentialTransfer',
  'withdrawConfidentialTransfer',
  'confidentialTransfer',
  'confidentialTransferWithFee',
  'applyPendingConfidentialTransferBalance',
  'enableConfidentialTransferConfidentialCredits',
  'disableConfidentialTransferConfidentialCredits',
  'enableConfidentialTransferNonConfidentialCredits',
  'disableConfidentialTransferNonConfidentialCredits',
  'configureConfidentialAccountWithRegistry',
  'initializeConfidentialTransferFeeConfig',
  'withdrawWithheldConfidentialTransferTokensFromMint',
  'withdrawWithheldConfidentialTransferTokensFromAccounts',
  'harvestWithheldConfidentialTransferTokensToMint',
  'enableConfidentialTransferFeeHarvestToMint',
  'disableConfidentialTransferFeeHarvestToMint',
]);
const configTypes = new Set([
  'initializeMint',
  'initializeMint2',
  'initializeMultisig',
  'initializeMultisig2',
  'initializeTransferFeeConfig',
  'setTransferFee',
  'initializeTransferHook',
  'updateTransferHook',
  'initializePermanentDelegate',
  'initializeMintCloseAuthority',
  'initializeNonTransferableMint',
  'initializeDefaultAccountState',
  'updateDefaultAccountState',
  'initializeScaledUiAmountConfig',
  'updateMultiplier',
  'initializePausableConfig',
  'pause',
  'resume',
  'initializeConfidentialTransferMint',
  'updateConfidentialTransferMint',
  'configureConfidentialTransferAccount',
  'approveConfidentialTransferAccount',
  'configureConfidentialAccountWithRegistry',
  'enableConfidentialTransferConfidentialCredits',
  'disableConfidentialTransferConfidentialCredits',
  'enableConfidentialTransferNonConfidentialCredits',
  'disableConfidentialTransferNonConfidentialCredits',
  'enableCpiGuard',
  'disableCpiGuard',
  'enableRequiredMemoTransfers',
  'disableRequiredMemoTransfers',
  // Known control changes remain critical even where field decoding is unsupported.
  'initializeConfidentialTransferFeeConfig',
  'enableConfidentialTransferFeeHarvestToMint',
  'disableConfidentialTransferFeeHarvestToMint',
  'initializeInterestBearingConfig',
  'updateInterestBearingConfigRate',
]);

function signed(value: unknown, min: bigint, max: bigint) {
  requireSolana(
    (typeof value === 'string' && /^(0|-?[1-9][0-9]{0,19})$/.test(value)) ||
      (typeof value === 'number' && Number.isSafeInteger(value)),
    'invalid_response',
  );
  const parsed = BigInt(value as string | number);
  requireSolana(parsed >= min && parsed <= max, 'invalid_response');
  return parsed.toString();
}
function exactU64(value: unknown) {
  return typeof value === 'number'
    ? String(uint(value))
    : amount(value).toString();
}
function opaque(value: unknown) {
  requireSolana(
    typeof value === 'string' &&
      value.length >= 16 &&
      value.length <= 256 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(value),
    'invalid_response',
  );
  requireSolana(
    Buffer.from(value, 'base64').toString('base64') === value,
    'invalid_response',
  );
}
function multiplier(value: unknown) {
  requireSolana(
    typeof value === 'string' &&
      value.length <= 128 &&
      /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i.test(value) &&
      Number.isFinite(Number(value)) &&
      Number(value) > 0,
    'invalid_response',
  );
  return value;
}

/** Decodes supported RPC-parsed shapes; it does not read mint state or verify proofs. */
export function decodeTokenInstruction(
  raw: Record<string, unknown>,
  result: ExplainedInstruction,
): boolean {
  if (raw.programId !== TOKEN_PROGRAM && raw.programId !== TOKEN_2022_PROGRAM)
    return false;
  const extended = raw.programId === TOKEN_2022_PROGRAM;
  const flag = (
    code: ExplanationFlag['code'],
    severity: ExplanationFlag['severity'],
    message: string,
  ) => addFlag(result, code, severity, message);
  if (extended)
    flag(
      'TOKEN_2022_STATE_UNINSPECTED',
      'warning',
      'Active mint and account extension state was not inspected. Transfer fees, hooks, delegates, confidential balances, scaling or pause controls may affect this instruction.',
    );
  if (raw.parsed === undefined) {
    unsupported(
      result,
      'The RPC did not provide a supported parsed token instruction.',
    );
    return true;
  }
  // Classify known critical effects before validating info, preserving warnings
  // when the outer decoder clears malformed fields.
  const type = record(raw.parsed).type;
  if (typeof type === 'string') {
    if (type === 'approve' || type === 'approveChecked')
      flag(
        'TOKEN_APPROVAL',
        'critical',
        'Approves a delegate to transfer or burn tokens later, up to the requested allowance.',
      );
    if (type === 'setAuthority')
      flag(
        'AUTHORITY_CHANGE',
        'critical',
        'Changes or removes control of a mint or token account. Some authority removals cannot be reversed.',
      );
    if (type === 'closeAccount')
      flag(
        'ACCOUNT_CLOSURE',
        'critical',
        'Requests token-account closure and sends its remaining SOL, including wrapped SOL where applicable, to the destination.',
      );
    if (type === 'burn' || type === 'burnChecked')
      flag(
        'TOKEN_BURN',
        'critical',
        'Requests token destruction and a reduction of mint supply.',
      );
    if (type === 'mintTo' || type === 'mintToChecked')
      flag(
        'TOKEN_MINT',
        'critical',
        'Requests creation of additional tokens under the mint authority.',
      );
    if (type === 'freezeAccount' || type === 'thawAccount')
      flag(
        'TOKEN_FREEZE',
        'critical',
        'Changes whether this token account can move tokens.',
      );
    if (configTypes.has(type))
      flag(
        'TOKEN_CONFIG_CHANGE',
        'critical',
        'Requests token configuration or control changes; this instruction does not establish the current configuration.',
      );
    if (type === 'initializePermanentDelegate')
      flag(
        'TOKEN_PERMANENT_DELEGATE',
        'critical',
        'Configures a mint-level delegate that can transfer or burn tokens from accounts for this mint without per-account approval.',
      );
    if (type === 'initializeTransferHook' || type === 'updateTransferHook')
      flag(
        'TOKEN_TRANSFER_HOOK',
        'critical',
        'Configures an external transfer-hook program. Its code and additional effects are not inspected here.',
      );
    if (
      type === 'initializePausableConfig' ||
      type === 'pause' ||
      type === 'resume'
    )
      flag(
        'TOKEN_PAUSE',
        'critical',
        'Configures or changes mint pause controls affecting minting, burning and transfers.',
      );
    if (
      type === 'initializeScaledUiAmountConfig' ||
      type === 'updateMultiplier'
    )
      flag(
        'TOKEN_SCALED_AMOUNT',
        'warning',
        'Changes display scaling. Displayed token amounts can change without changing raw token units.',
      );
    if (confidentialTypes.has(type))
      flag(
        'TOKEN_CONFIDENTIAL',
        'warning',
        'Confidential balances or proofs are involved. Encrypted amounts and cryptographic proof validity are not verified by this explanation.',
      );
  }
  const { type: kind, info } = parsedInfo(raw),
    fields = result.fields;
  const put = (name: string, value: string) => {
    requireSolana(
      value.length <= 256 &&
        !Array.from(value).some((character) => {
          const code = character.charCodeAt(0);
          return (
            (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
            (code >= 127 && code <= 159)
          );
        }) &&
        Object.keys(fields).length < 16,
      'invalid_response',
    );
    fields[name] = value;
  };
  const key = (name: string) => put(name, address(info[name]));
  const optionalKey = (name: string) =>
    put(
      name,
      info[name] === undefined || info[name] === null
        ? 'none'
        : address(info[name]),
    );
  const schema = (required: string[], optional: string[] = []) => {
    requireSolana(
      required.every((n) => Object.hasOwn(info, n)) &&
        Object.keys(info).every(
          (n) => required.includes(n) || optional.includes(n),
        ),
      'unsupported_instruction',
    );
  };
  const signerFields = (
    single: string,
    multi = `multisig${single[0].toUpperCase()}${single.slice(1)}`,
  ) => [single, multi, 'signers'];
  const signers = (
    single: string,
    multi = `multisig${single[0].toUpperCase()}${single.slice(1)}`,
  ) => {
    const one = Object.hasOwn(info, single),
      many = Object.hasOwn(info, multi);
    requireSolana(one !== many, 'invalid_response');
    if (one) {
      requireSolana(!Object.hasOwn(info, 'signers'), 'invalid_response');
      key(single);
    } else {
      key(multi);
      const values = list(info.signers, 11).map(address);
      requireSolana(
        values.length >= 1 && new Set(values).size === values.length,
        'invalid_response',
      );
      put('signerCount', String(values.length));
      for (let i = 0; i < values.length; i += 5)
        put(
          `signers${i + 1}to${Math.min(i + 5, values.length)}`,
          values.slice(i, i + 5).join(', '),
        );
    }
  };
  const tokenAmount = (checked: boolean) => {
    if (checked) {
      const value = record(info.tokenAmount);
      put('amountRaw', amount(value.amount).toString());
      put('decimals', String(uint(value.decimals, 255)));
    } else put('amountRaw', amount(info.amount).toString());
  };
  const sourceAccounts = () => {
    const accounts = list(info.sourceAccounts, 256).map(address);
    put('sourceAccountCount', String(accounts.length));
    if (accounts.length)
      put('sourceAccountsPreview', accounts.slice(0, 5).join(', '));
    if (accounts.length > 5) {
      put('additionalSourceAccounts', String(accounts.length - 5));
      flag(
        'INCOMPLETE_METADATA',
        'warning',
        'Only the first five source accounts are displayed; the remaining source-account count is shown.',
      );
    }
  };
  const finish = (description: string) => {
    result.kind = kind;
    result.description = description;
    return true;
  };
  const confProofs = (names: string[]) => {
    const allowed: string[] = [];
    let sysvar = false;
    for (const name of names) {
      const rawOffset = info[`${name}InstructionOffset`];
      requireSolana(typeof rawOffset === 'number', 'invalid_response');
      const offset = signed(rawOffset, -128n, 127n),
        context = `${name}ContextStateAccount`;
      allowed.push(`${name}InstructionOffset`, context);
      if (offset === '0') address(info[context]);
      else sysvar = true;
    }
    if (sysvar) address(info.instructionsSysvar);
    else
      requireSolana(info.instructionsSysvar === undefined, 'invalid_response');
    for (const name of names) {
      const offset = info[`${name}InstructionOffset`],
        context = `${name}ContextStateAccount`;
      if (offset !== 0)
        requireSolana(info[context] === undefined, 'invalid_response');
    }
    return [...allowed, 'instructionsSysvar'];
  };

  if (
    [
      'transfer',
      'transferChecked',
      'approve',
      'approveChecked',
      'mintTo',
      'mintToChecked',
      'burn',
      'burnChecked',
    ].includes(kind)
  ) {
    const checked = kind.endsWith('Checked'),
      transfer = kind.startsWith('transfer'),
      approval = kind.startsWith('approve'),
      minting = kind.startsWith('mintTo');
    const accountNames = transfer
      ? ['source', 'destination']
      : approval
        ? ['source', 'delegate']
        : ['mint', 'account'];
    if (checked && !accountNames.includes('mint')) accountNames.push('mint');
    const authority = approval
      ? 'owner'
      : minting
        ? 'mintAuthority'
        : 'authority';
    schema(
      [...accountNames, checked ? 'tokenAmount' : 'amount'],
      signerFields(authority),
    );
    accountNames.forEach(key);
    signers(authority);
    tokenAmount(checked);
    if (transfer)
      flag(
        'TOKEN_TRANSFER',
        'info',
        'Requests a token transfer. The signing authority may be an owner or previously approved delegate.',
      );
    return finish(
      transfer
        ? 'Transfers tokens between token accounts.'
        : approval
          ? 'Grants a delegate allowance over tokens in this account.'
          : minting
            ? 'Mints tokens into the destination token account.'
            : 'Burns tokens from the account.',
    );
  }
  if (kind === 'revoke') {
    schema(['source'], signerFields('owner'));
    key('source');
    signers('owner');
    flag(
      'TOKEN_REVOKE',
      'info',
      'Revokes this account’s ordinary token delegate; mint-level Token-2022 delegates are separate.',
    );
    return finish('Revokes an ordinary token-account delegate allowance.');
  }
  if (kind === 'setAuthority') {
    requireSolana(
      typeof info.authorityType === 'string' &&
        (extended
          ? [...mintAuthorities, 'accountOwner', 'closeAccount']
          : baseAuthorities
        ).includes(info.authorityType),
      'unsupported_instruction',
    );
    const target = mintAuthorities.includes(info.authorityType)
      ? 'mint'
      : 'account';
    schema(
      [target, 'authorityType', 'newAuthority'],
      signerFields('authority'),
    );
    if (info.authorityType === 'permanentDelegate')
      flag(
        'TOKEN_PERMANENT_DELEGATE',
        'critical',
        'Changes a mint-level authority able to transfer or burn tokens from all accounts for this mint.',
      );
    if (info.authorityType === 'transferHookProgramId')
      flag(
        'TOKEN_TRANSFER_HOOK',
        'critical',
        'Changes authority over the mint’s external transfer-hook configuration.',
      );
    if (info.authorityType === 'pause')
      flag(
        'TOKEN_PAUSE',
        'critical',
        'Changes the authority that can pause token activity.',
      );
    key(target);
    signers('authority');
    put('authorityType', info.authorityType);
    optionalKey('newAuthority');
    return finish('Changes or removes a token-account or mint authority.');
  }
  if (kind === 'closeAccount') {
    schema(['account', 'destination'], signerFields('owner'));
    key('account');
    key('destination');
    signers('owner');
    return finish(
      'Closes a token account and returns its remaining SOL to the destination.',
    );
  }
  if (kind === 'freezeAccount' || kind === 'thawAccount') {
    schema(['account', 'mint'], signerFields('freezeAuthority'));
    key('account');
    key('mint');
    signers('freezeAuthority');
    return finish(
      kind === 'freezeAccount'
        ? 'Requests freezing a token account.'
        : 'Requests thawing a frozen token account.',
    );
  }
  if (kind === 'initializeMint' || kind === 'initializeMint2') {
    schema(
      [
        'mint',
        'decimals',
        'mintAuthority',
        ...(kind === 'initializeMint' ? ['rentSysvar'] : []),
      ],
      ['freezeAuthority'],
    );
    key('mint');
    key('mintAuthority');
    optionalKey('freezeAuthority');
    put('decimals', String(uint(info.decimals, 255)));
    if (kind === 'initializeMint') key('rentSysvar');
    return finish(
      'Initializes a token mint with the specified mint and optional freeze authorities.',
    );
  }
  if (
    ['initializeAccount', 'initializeAccount2', 'initializeAccount3'].includes(
      kind,
    )
  ) {
    schema([
      'account',
      'mint',
      'owner',
      ...(kind === 'initializeAccount3' ? [] : ['rentSysvar']),
    ]);
    ['account', 'mint', 'owner'].forEach(key);
    if (kind !== 'initializeAccount3') key('rentSysvar');
    return finish(
      'Initializes a token account for the specified mint and owner.',
    );
  }
  if (kind === 'initializeMultisig' || kind === 'initializeMultisig2') {
    schema([
      'multisig',
      'm',
      'signers',
      ...(kind === 'initializeMultisig' ? ['rentSysvar'] : []),
    ]);
    key('multisig');
    const values = list(info.signers, 11).map(address),
      m = uint(info.m, 11);
    requireSolana(
      m >= 1 && m <= values.length && new Set(values).size === values.length,
      'invalid_response',
    );
    put('requiredSignatures', String(m));
    put('signerCount', String(values.length));
    for (let i = 0; i < values.length; i += 5)
      put(
        `signers${i + 1}to${Math.min(i + 5, values.length)}`,
        values.slice(i, i + 5).join(', '),
      );
    if (kind === 'initializeMultisig') key('rentSysvar');
    return finish(
      'Initializes a token-program multisignature authority and its signer threshold.',
    );
  }
  if (kind === 'syncNative') {
    schema(['account']);
    key('account');
    return finish(
      'Updates a wrapped-SOL token balance to reflect SOL already in this account; this instruction alone does not transfer SOL.',
    );
  }
  if (!extended) {
    unsupported(result);
    return true;
  }

  if (kind === 'transferCheckedWithFee') {
    flag(
      'TOKEN_TRANSFER_FEE',
      'warning',
      'The instruction specifies an expected withheld transfer fee; current mint fee settings were not inspected.',
    );
    schema(
      ['source', 'mint', 'destination', 'tokenAmount', 'feeAmount'],
      signerFields('authority'),
    );
    ['source', 'mint', 'destination'].forEach(key);
    signers('authority');
    tokenAmount(true);
    const fee = record(info.feeAmount);
    requireSolana(
      uint(fee.decimals, 255) === Number(fields.decimals),
      'invalid_response',
    );
    put('feeAmountRaw', amount(fee.amount).toString());
    requireSolana(
      BigInt(fields.feeAmountRaw) <= BigInt(fields.amountRaw),
      'invalid_amount',
    );
    flag(
      'TOKEN_TRANSFER',
      'info',
      'Requests a token transfer with an explicitly expected fee.',
    );
    return finish(
      'Transfers tokens while checking the specified withheld fee.',
    );
  }
  if (kind === 'initializeTransferFeeConfig' || kind === 'setTransferFee') {
    flag(
      'TOKEN_TRANSFER_FEE',
      'warning',
      'Configures basis-point transfer fees and a maximum withheld amount; the effective current fee was not inspected.',
    );
    const authorityFields =
      kind === 'setTransferFee'
        ? signerFields(
            'transferFeeConfigAuthority',
            'multisigtransferFeeConfigAuthority',
          )
        : ['transferFeeConfigAuthority', 'withdrawWithheldAuthority'];
    schema(['mint', 'transferFeeBasisPoints', 'maximumFee'], authorityFields);
    key('mint');
    put(
      'transferFeeBasisPoints',
      String(uint(info.transferFeeBasisPoints, 10000)),
    );
    put('maximumFeeRaw', exactU64(info.maximumFee));
    if (kind === 'setTransferFee')
      signers(
        'transferFeeConfigAuthority',
        'multisigtransferFeeConfigAuthority',
      );
    else {
      optionalKey('transferFeeConfigAuthority');
      optionalKey('withdrawWithheldAuthority');
    }
    return finish('Configures transfer-fee parameters for this mint.');
  }
  if (
    [
      'withdrawWithheldTokensFromMint',
      'withdrawWithheldTokensFromAccounts',
      'harvestWithheldTokensToMint',
    ].includes(kind)
  ) {
    flag(
      'TOKEN_TRANSFER_FEE',
      'warning',
      'Moves previously withheld fees; the actual balances were not inspected.',
    );
    const harvest = kind === 'harvestWithheldTokensToMint',
      sources = kind !== 'withdrawWithheldTokensFromMint';
    schema(
      [
        'mint',
        ...(harvest ? [] : ['feeRecipient']),
        ...(sources ? ['sourceAccounts'] : []),
      ],
      harvest ? [] : signerFields('withdrawWithheldAuthority'),
    );
    key('mint');
    if (!harvest) {
      key('feeRecipient');
      signers('withdrawWithheldAuthority');
    }
    if (sources) sourceAccounts();
    return finish(
      harvest
        ? 'Harvests withheld transfer fees from token accounts into the mint.'
        : 'Withdraws withheld transfer fees to the specified token account.',
    );
  }
  if (kind === 'initializeTransferHook' || kind === 'updateTransferHook') {
    schema(
      ['mint'],
      kind === 'initializeTransferHook'
        ? ['authority', 'programId']
        : [...signerFields('authority'), 'programId'],
    );
    key('mint');
    optionalKey('programId');
    if (kind === 'initializeTransferHook') optionalKey('authority');
    else signers('authority');
    return finish(
      'Initializes, replaces or removes a transfer-hook program reference.',
    );
  }
  if (kind === 'initializePermanentDelegate') {
    schema(['mint', 'delegate']);
    key('mint');
    key('delegate');
    return finish('Initializes a mint-level permanent delegate.');
  }
  if (kind === 'initializeMintCloseAuthority') {
    schema(['mint', 'newAuthority']);
    key('mint');
    optionalKey('newAuthority');
    return finish(
      'Sets the optional authority allowed to close this mint when program conditions permit.',
    );
  }
  if (kind === 'initializeNonTransferableMint') {
    schema(['mint']);
    key('mint');
    return finish('Initializes the non-transferable mint extension.');
  }
  if (kind === 'initializeImmutableOwner') {
    schema(['account']);
    key('account');
    return finish(
      'Initializes Token-2022 immutable ownership for this token account.',
    );
  }
  if (
    kind === 'initializeDefaultAccountState' ||
    kind === 'updateDefaultAccountState'
  ) {
    schema(
      ['mint', 'accountState'],
      kind === 'updateDefaultAccountState'
        ? signerFields('freezeAuthority')
        : [],
    );
    key('mint');
    requireSolana(
      typeof info.accountState === 'string' &&
        ['initialized', 'frozen'].includes(info.accountState),
      'unsupported_instruction',
    );
    put('accountState', info.accountState);
    if (kind === 'updateDefaultAccountState') signers('freezeAuthority');
    flag(
      'TOKEN_FREEZE',
      'critical',
      'Changes whether newly created token accounts begin frozen.',
    );
    return finish('Configures the default state for new token accounts.');
  }
  if (
    [
      'enableCpiGuard',
      'disableCpiGuard',
      'enableRequiredMemoTransfers',
      'disableRequiredMemoTransfers',
    ].includes(kind)
  ) {
    schema(['account'], signerFields('owner'));
    key('account');
    signers('owner');
    return finish(
      kind.includes('CpiGuard')
        ? 'Changes account restrictions on privileged token operations invoked by other programs.'
        : 'Changes whether incoming transfers require an accompanying memo.',
    );
  }
  if (
    kind === 'initializeScaledUiAmountConfig' ||
    kind === 'updateMultiplier'
  ) {
    schema(
      kind === 'updateMultiplier'
        ? ['mint', 'newMultiplier', 'newMultiplierTimestamp']
        : ['mint', 'authority', 'multiplier'],
      kind === 'updateMultiplier' ? signerFields('authority') : [],
    );
    key('mint');
    if (kind === 'updateMultiplier') {
      signers('authority');
      put('newMultiplier', multiplier(info.newMultiplier));
      put(
        'newMultiplierTimestamp',
        signed(info.newMultiplierTimestamp, -(1n << 63n), (1n << 63n) - 1n),
      );
    } else {
      optionalKey('authority');
      put('multiplier', multiplier(info.multiplier));
    }
    return finish(
      'Configures a multiplier for UI display amounts, without converting or asserting current raw balances.',
    );
  }
  if (
    kind === 'initializePausableConfig' ||
    kind === 'pause' ||
    kind === 'resume'
  ) {
    schema(
      kind === 'initializePausableConfig' ? ['mint', 'authority'] : ['mint'],
      kind === 'initializePausableConfig' ? [] : signerFields('authority'),
    );
    key('mint');
    if (kind === 'initializePausableConfig') optionalKey('authority');
    else signers('authority');
    return finish(
      kind === 'initializePausableConfig'
        ? 'Initializes the mint pause authority.'
        : kind === 'pause'
          ? 'Requests pausing minting, burning and token transfers.'
          : 'Requests resuming minting, burning and token transfers.',
    );
  }

  if (
    kind === 'initializeConfidentialTransferMint' ||
    kind === 'updateConfidentialTransferMint'
  ) {
    const updating = kind === 'updateConfidentialTransferMint';
    schema(
      [
        'mint',
        'autoApproveNewAccounts',
        'auditorElGamalPubkey',
        ...(updating ? ['confidentialTransferMintAuthority'] : []),
      ],
      updating ? [] : ['authority'],
    );
    key('mint');
    if (updating) key('confidentialTransferMintAuthority');
    else optionalKey('authority');
    requireSolana(
      typeof info.autoApproveNewAccounts === 'boolean',
      'invalid_response',
    );
    put('autoApproveNewAccounts', String(info.autoApproveNewAccounts));
    if (info.auditorElGamalPubkey !== null) opaque(info.auditorElGamalPubkey);
    put(
      'auditorKeyConfigured',
      info.auditorElGamalPubkey === null ? 'no' : 'yes',
    );
    return finish(
      'Configures confidential-account approval and optional auditor settings.',
    );
  }
  if (kind === 'approveConfidentialTransferAccount') {
    schema(['account', 'mint', 'confidentialTransferAuditorAuthority']);
    ['account', 'mint', 'confidentialTransferAuditorAuthority'].forEach(key);
    return finish(
      'Approves a token account for confidential-transfer use; this is not an ordinary delegate allowance.',
    );
  }
  if (kind === 'configureConfidentialAccountWithRegistry') {
    schema(['account', 'mint', 'registry']);
    ['account', 'mint', 'registry'].forEach(key);
    return finish(
      'Configures confidential account data using a registry reference that is not inspected here.',
    );
  }
  if (
    kind === 'configureConfidentialTransferAccount' ||
    kind === 'emptyConfidentialTransferAccount'
  ) {
    const configure = kind === 'configureConfidentialTransferAccount',
      proof = confProofs(['proof']);
    schema(
      [
        'account',
        'proofInstructionOffset',
        ...(configure
          ? [
              'mint',
              'decryptableZeroBalance',
              'maximumPendingBalanceCreditCounter',
            ]
          : []),
      ],
      [...proof, ...signerFields('owner')],
    );
    key('account');
    signers('owner');
    if (configure) {
      key('mint');
      opaque(info.decryptableZeroBalance);
      put(
        'maximumPendingBalanceCreditCounter',
        exactU64(info.maximumPendingBalanceCreditCounter),
      );
    }
    return finish(
      configure
        ? 'Configures confidential balances with referenced proofs that were not verified.'
        : 'Requests clearing an empty confidential account balance using a referenced proof.',
    );
  }
  if (
    kind === 'depositConfidentialTransfer' ||
    kind === 'withdrawConfidentialTransfer'
  ) {
    const withdrawing = kind === 'withdrawConfidentialTransfer',
      proof = withdrawing ? confProofs(['equalityProof', 'rangeProof']) : [];
    schema(
      [
        'account',
        'mint',
        'amount',
        'decimals',
        ...(withdrawing
          ? [
              'newDecryptableAvailableBalance',
              'equalityProofInstructionOffset',
              'rangeProofInstructionOffset',
            ]
          : []),
      ],
      [...proof, ...signerFields('owner')],
    );
    key('account');
    key('mint');
    signers('owner');
    put('amountRaw', exactU64(info.amount));
    put('decimals', String(uint(info.decimals, 255)));
    if (withdrawing) opaque(info.newDecryptableAvailableBalance);
    return finish(
      withdrawing
        ? 'Moves confidential balance into the public balance of the same token account.'
        : 'Moves public token balance into the pending confidential balance of the same token account.',
    );
  }
  if (
    kind === 'confidentialTransfer' ||
    kind === 'confidentialTransferWithFee'
  ) {
    const fee = kind === 'confidentialTransferWithFee',
      names = fee
        ? [
            'equalityProof',
            'transferAmountCiphertextValidityProof',
            'feeSigmaProof',
            'feeCiphertextValidityProof',
            'rangeProof',
          ]
        : ['equalityProof', 'ciphertextValidityProof', 'rangeProof'],
      proof = confProofs(names);
    schema(
      [
        'source',
        'mint',
        'destination',
        'newSourceDecryptableAvailableBalance',
        ...names.map((n) => `${n}InstructionOffset`),
      ],
      [...proof, ...signerFields('owner')],
    );
    ['source', 'mint', 'destination'].forEach(key);
    signers('owner');
    opaque(info.newSourceDecryptableAvailableBalance);
    put('amount', 'confidential; not decoded');
    if (fee)
      flag(
        'TOKEN_TRANSFER_FEE',
        'warning',
        'A confidential transfer fee is involved; its amount is not decoded.',
      );
    return finish(
      'Requests a confidential token transfer; encrypted amounts and proof validity are not established here.',
    );
  }
  if (kind === 'applyPendingConfidentialTransferBalance') {
    schema(
      [
        'account',
        'newDecryptableAvailableBalance',
        'expectedPendingBalanceCreditCounter',
      ],
      signerFields('owner'),
    );
    key('account');
    signers('owner');
    opaque(info.newDecryptableAvailableBalance);
    put(
      'expectedPendingBalanceCreditCounter',
      exactU64(info.expectedPendingBalanceCreditCounter),
    );
    return finish(
      'Applies pending confidential credits to this account’s available confidential balance.',
    );
  }
  if (
    [
      'enableConfidentialTransferConfidentialCredits',
      'disableConfidentialTransferConfidentialCredits',
      'enableConfidentialTransferNonConfidentialCredits',
      'disableConfidentialTransferNonConfidentialCredits',
    ].includes(kind)
  ) {
    schema(['account'], signerFields('owner'));
    key('account');
    signers('owner');
    return finish(
      'Changes whether this account accepts the specified class of incoming token credits.',
    );
  }
  unsupported(result);
  return true;
}
