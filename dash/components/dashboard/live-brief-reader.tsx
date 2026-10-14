import { useT } from '@/lib/i18n';
import { BriefSynthesisResult } from './brief-synthesis-result';
import type { BriefDocument } from '../../lib/brief-document';
import { formatAccountUsd6 } from '../../lib/client/account-records';
import { featureOn } from './feature-switches';

export function LiveBriefReader({ document }: { document: BriefDocument }) {
  const t = useT();
  return (
    <div
      style={{
        display: 'grid',
        gap: 24,
        fontSize: 13,
        lineHeight: 1.7,
        overflowWrap: 'anywhere',
      }}
    >
      {featureOn('synthesis') && document.synthesis && (
        <section>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>
            {t('Selected generated analysis')}
          </h3>
          <p className="cp-fineprint">
            {document.synthesis.modelId} ·{' '}
            {document.synthesis.actualUsd6 === null
              ? t('Analysis charge not settled')
              : t('{amount} analysis charge', {
                  amount: `$${formatAccountUsd6(document.synthesis.actualUsd6)}`,
                })}
            {t('. This immutable analysis is separate from your assessment.')}
          </p>
          <BriefSynthesisResult
            analysis={document.synthesis.analysis}
            evidence={document.evidence}
          />
          <details>
            <summary>{t('Analysis provenance')}</summary>
            <dl className="ct-facts">
              <div>
                <dt>{t('Run')}</dt>
                <dd>{document.synthesis.runId}</dd>
              </div>
              <div>
                <dt>{t('Call')}</dt>
                <dd>{document.synthesis.callId}</dd>
              </div>
              <div>
                <dt>{t('Route')}</dt>
                <dd>{document.synthesis.routeVersionId}</dd>
              </div>
              <div>
                <dt>{t('Output SHA-256')}</dt>
                <dd>{document.synthesis.outputHash}</dd>
              </div>
            </dl>
          </details>
        </section>
      )}
      <section>
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>{t('Your decision')}</h3>
        <p style={{ whiteSpace: 'pre-wrap' }}>
          {document.analysis.decision ||
            t('Add your decision and notes with Edit assessment.')}
        </p>
      </section>
      {document.analysis.matrix.length > 0 && (
        <section>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>
            {t('Your agreement assessment')}
          </h3>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>{t('Topic')}</th>
                  {document.evidence.map((e) => (
                    <th key={e.callId}>{e.modelId}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {document.analysis.matrix.map((row, index) => (
                  <tr key={index}>
                    <th>{row.topic}</th>
                    {document.evidence.map((e) => (
                      <td key={e.callId} style={{ padding: '6px 10px' }}>
                        {t(
                          row.positions.find((p) => p.callId === e.callId)!
                            .position,
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {document.evidence.map((evidence) => (
        <section key={evidence.callId}>
          <h3 style={{ fontSize: 14, marginBottom: 4 }}>{evidence.modelId}</h3>
          <p className="cp-fineprint">
            {evidence.actualUsd6 === null
              ? t('Cost pending at save')
              : t('{amount} at save', {
                  amount: `$${formatAccountUsd6(evidence.actualUsd6)}`,
                })}
          </p>
          {document.analysis.notes.find((n) => n.callId === evidence.callId)
            ?.text && (
            <p style={{ whiteSpace: 'pre-wrap', margin: '12px 0' }}>
              {
                document.analysis.notes.find(
                  (n) => n.callId === evidence.callId,
                )!.text
              }
            </p>
          )}
          <details>
            <summary>{t('Original question and response')}</summary>
            <p style={{ whiteSpace: 'pre-wrap', margin: '12px 0' }}>
              {evidence.question}
            </p>
            <pre>{evidence.answer}</pre>
          </details>
        </section>
      ))}
      <details>
        <summary>{t('Provenance')}</summary>
        <p className="cp-fineprint">
          {t(
            'Saved {time}. Owner assessments are separate from the original responses. A snapshot hash is not an onchain proof.',
            { time: document.savedAt },
          )}
        </p>
        <dl className="ct-facts">
          <div>
            <dt>{t('Evidence SHA-256')}</dt>
            <dd>{document.evidenceHash}</dd>
          </div>
          {document.evidence.map((e) => (
            <div key={e.callId}>
              <dt>{e.modelId}</dt>
              <dd>
                {t('Call {id}', { id: e.callId })}
                <br />
                {t('Comparison {id}', { id: e.comparisonId })}
                <br />
                {t('Route {id}', { id: e.routeVersionId })}
                <br />
                {t('Response SHA-256 {hash}', { hash: e.answerHash })}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
