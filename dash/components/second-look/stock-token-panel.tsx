'use client';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useT } from '../../lib/i18n';
import { shortAddress } from '../../lib/client/second-look';
import {
  parseStockTokenInput,
  stockTokenControl,
  stockTokenMultiplier,
  stockTokenResponse,
  STOCK_TOKEN_INPUT_ERROR,
  type StockTokenCard,
} from '../../lib/second-look/stock-token';
import {
  Busy,
  CopyButton,
  ErrorNotice,
  EvidenceLink,
  useSecondLookApi,
  type PanelProps,
} from './shared';

const mono: CSSProperties = {
  fontFamily: '"JetBrains Mono", monospace',
  overflowWrap: 'anywhere',
  minWidth: 0,
};
const limits =
  "Stock tokens are issuer products: no shareholder rights, and dividends follow the issuer's method. Who may hold it is set by the issuer's terms.";
/** Say only the powers this mint actually has: freezing (freeze authority or pause) and moving (permanent delegate). */
function powerLine(card: { freezeAuthority?: string | null; pause?: unknown; permanentDelegate?: unknown }, issuer: boolean) {
  const freeze = !!(card.freezeAuthority || card.pause);
  const move = !!card.permanentDelegate;
  if (issuer)
    return move
      ? 'Common for issuer-backed stock tokens. It means the issuer can freeze yours or take them.'
      : 'Common for issuer-backed stock tokens. It means the issuer can freeze or pause yours.';
  if (freeze && move) return "This token's controller can freeze or move holders' tokens.";
  if (move) return "This token's controller can move holders' tokens.";
  if (freeze) return "This token's controller can freeze holders' tokens.";
  return "This token's controller can change how transfers work.";
}
const noneLine =
  'No pause, permanent delegate, freeze authority or transfer hook found.';

/** Stock-token Second Look panel. Mounted only when the stockToken switch is on. */
export function StockTokenPanel({
  accountId,
  controlRef,
  onComposer,
  onDraft,
  onSignIn,
  onToast,
}: PanelProps) {
  const t = useT();
  const api = useSecondLookApi(accountId),
    run = api.run;
  const [card, setCard] = useState<StockTokenCard | null>(null);
  const [inputError, setInputError] = useState('');
  const inspect = useCallback(
    async (value: string) => {
      const mint = (() => {
        try {
          return parseStockTokenInput(value);
        } catch {
          return null;
        }
      })();
      if (!mint) {
        setInputError(STOCK_TOKEN_INPUT_ERROR);
        return;
      }
      if (!accountId) {
        onSignIn();
        return;
      }
      setInputError('');
      setCard(null);
      await run(async (request) => {
        const result = await request('second-look/stock-tokens/check', {
          method: 'POST',
          body: { mint },
          validate: stockTokenResponse,
        });
        setCard(result.card);
        onDraft('');
      });
    },
    [accountId, onSignIn, onDraft, run],
  );
  useImperativeHandle(controlRef, () => ({ submit: inspect }), [inspect]);
  useEffect(
    () =>
      onComposer({
        placeholder: t('Paste a Solana mint or token link…'),
        label: t('Check stock token'),
        busy: api.busy,
      }),
    [onComposer, api.busy, t],
  );
  const control = card ? stockTokenControl(card) : null;
  const scale = card
    ? stockTokenMultiplier(card, Date.parse(card.observedAt))
    : null;
  const address = (value: string | null | undefined) =>
    value ? <span style={mono}>{value}</span> : t('None found');
  const row = (label: string, value: ReactNode) => (
    <tr>
      <th
        scope="row"
        style={{
          textAlign: 'left',
          verticalAlign: 'top',
          width: '35%',
          padding: '12px 10px 12px 0',
          fontWeight: 500,
        }}
      >
        {t(label)}
      </th>
      <td style={{ padding: '12px 0', overflowWrap: 'anywhere', minWidth: 0 }}>
        {value}
      </td>
    </tr>
  );
  const at = (seconds: string) => {
    const ms = Number(seconds) * 1000;
    return Number.isSafeInteger(ms) && Math.abs(ms) <= 8.64e15
      ? new Date(ms).toISOString()
      : t('Unix seconds: {timestamp}', { timestamp: seconds });
  };
  return (
    <section
      className="sl-workspace"
      aria-label={t('Stock tokens')}
      style={
        {
          maxWidth: 850,
          minWidth: 0,
          padding: '24px 16px 40px',
          background: '#fff',
          fontFamily: 'Geist, Arial, sans-serif',
          '--sl-accent': '#EA2A22',
        } as CSSProperties
      }
    >
      <header className="sl-page-heading">
        <h1>{t('Stock tokens')}</h1>
      </header>
      <p>
        {t(
          'Inspect a mint’s on-chain controls. Names and symbols are supplied by the token and can be copied.',
        )}
      </p>
      <ErrorNotice message={t(inputError || api.error)} />
      {api.busy && <Busy label={t('Reading finalized Solana mint state…')} />}
      {!card && !api.busy && (
        <p>{t('Paste a Solana token mint into the composer to begin.')}</p>
      )}
      {card && (
        <article
          style={{
            border: '1px solid #e8e9e7',
            borderTop: '3px solid #EA2A22',
            padding: 'clamp(12px, 3vw, 24px)',
            borderRadius: 8,
            marginTop: 20,
            minWidth: 0,
          }}
        >
          <header>
            <p>{t('Name and symbol as stated by the token')}</p>
            <h2 style={{ overflowWrap: 'anywhere' }}>
              {card.metadata?.name || t('Name unavailable')}{' '}
              {card.metadata?.symbol && (
                <span style={mono}>({card.metadata.symbol})</span>
              )}
            </h2>
            <div
              className="sl-address"
              style={{ flexWrap: 'wrap', gap: 8, marginTop: 12 }}
            >
              <span style={mono}>{shortAddress(card.mint)}</span>
              <CopyButton
                value={card.mint}
                label={t('Copy mint address')}
                onToast={(message) => onToast(t(message))}
              />
              <span>{card.program}</span>
            </div>
            <EvidenceLink
              href={'https://explorer.solana.com/address/' + card.mint}
            >
              {t('View mint on Solana Explorer')}
            </EvidenceLink>
          </header>
          <div
            style={{ marginTop: 20 }}
            className={
              control?.kind === 'controller'
                ? 'sl-notice sl-error'
                : 'sl-notice'
            }
          >
            {control?.kind === 'issuer' && (
              <strong>{t('Issuer-controlled')}</strong>
            )}
            {control?.kind === 'controller' && (
              <strong style={{ color: '#EA2A22' }}>
                {t('Controller powers found')}
              </strong>
            )}
            <p>
              {t(
                control?.kind === 'issuer' || control?.kind === 'controller'
                  ? powerLine(card, control.kind === 'issuer')
                  : noneLine,
              )}
            </p>
          </div>
          {control?.issuer && (
            <p>
              {t('Issuer: {issuer} · Programme: {programme}', {
                issuer: control.issuer.issuer,
                programme: control.issuer.programme,
              })}
              <br />
              {t('Who it is not for: {restriction}', {
                restriction: t(control.issuer.notFor),
              })}{' '}
              <EvidenceLink href={control.issuer.termsUrl}>
                {t('Issuer terms')}
              </EvidenceLink>
              <br />
              {t("This mint's authorities match the issuer's keys. Confirm the mint on the issuer's own list before relying on it.")}
            </p>
          )}
          {!control?.issuer && (
            <p>
              {t(
                'No verified issuer authority match. This check does not establish that this is a stock token.',
              )}
            </p>
          )}
          <table
            style={{
              width: '100%',
              tableLayout: 'fixed',
              borderCollapse: 'collapse',
            }}
            aria-label={t('Mint powers and supply')}
          >
            <tbody>
              {row(
                'Pause',
                card.pause ? (
                  <>
                    {t(
                      card.pause.paused
                        ? 'Paused at this snapshot'
                        : 'Not paused at this snapshot',
                    )}
                    <br />
                    {t('Authority')}: {address(card.pause.authority)}
                  </>
                ) : (
                  t('None found')
                ),
              )}
              {row(
                'Permanent delegate',
                address(card.permanentDelegate?.delegate),
              )}
              {row(
                'Transfer hook',
                card.transferHook ? (
                  <>
                    {t('Authority')}: {address(card.transferHook.authority)}
                    <br />
                    {t('Program')}: {address(card.transferHook.programId)}
                  </>
                ) : (
                  t('None found')
                ),
              )}
              {row('Freeze authority', address(card.freezeAuthority))}
              {row('Mint authority', address(card.mintAuthority))}
              {row(
                'Multiplier',
                scale ? (
                  <>
                    <span style={mono}>
                      {t('1 token = {multiplier} shares', {
                        multiplier: scale.current,
                      })}
                    </span>
                    <p>
                      {t(
                        'Token UI multiplier only; share backing is not verified.',
                      )}
                    </p>
                    {t('Authority')}: {address(card.scaledUiAmount?.authority)}
                    {scale.pending && (
                      <p>
                        {t('Pending: {multiplier}, effective {time}', {
                          multiplier: scale.pending.multiplier,
                          time: at(scale.pending.timestamp),
                        })}
                      </p>
                    )}
                  </>
                ) : (
                  t(
                    'No scaled UI multiplier found; share conversion is unknown.',
                  )
                ),
              )}
              {row('Decimals', <span style={mono}>{card.decimals}</span>)}
              {row(
                'Supply (raw base units)',
                <span style={mono}>{card.supply}</span>,
              )}
              {row(
                'Metadata update authority',
                address(card.metadata?.updateAuthority),
              )}
              {row(
                'Metadata URI (not fetched)',
                card.metadata?.uri ? (
                  <span style={mono}>{card.metadata.uri}</span>
                ) : (
                  t('None found')
                ),
              )}
            </tbody>
          </table>
          {card.unknownExtensions.length > 0 && (
            <p>
              {t(
                'Extensions listed by name only; their behavior is not checked: {extensions}',
                { extensions: card.unknownExtensions.join(', ') },
              )}
            </p>
          )}
          <p>
            {t(
              'Source: configured Solana mainnet RPC, finalized slot {slot}. Retrieved {time}.',
              { slot: card.slot, time: card.observedAt },
            )}
          </p>
          <p>
            {t(
              'This is a snapshot. RPC parser coverage may vary; hook code, future authority actions, backing and issuer eligibility are not verified.',
            )}
          </p>
          <p>{t(limits)}</p>
          <p>{t("Liquidity and value aren't checked here.")}</p>
          <p>{t('Not investment advice.')}</p>
        </article>
      )}
      {!card && (
        <p>
          {t('Not investment advice.')}{' '}
          {t("Liquidity and value aren't checked here.")}
        </p>
      )}
    </section>
  );
}
