import type { BriefDocument } from '../../lib/brief-document';
import type {
  BriefSynthesisAnalysis,
  BriefSourceQuote,
} from '../../lib/brief-synthesis';

function SourceQuote({ quote }: { quote: BriefSourceQuote }) {
  return (
    <blockquote
      style={{
        whiteSpace: 'pre-wrap',
        margin: '8px 0',
        paddingLeft: 12,
        borderLeft: '2px solid currentColor',
      }}
    >
      {quote.text}
    </blockquote>
  );
}

export function BriefSynthesisResult({
  analysis,
  evidence,
}: {
  analysis: BriefSynthesisAnalysis;
  evidence: BriefDocument['evidence'];
}) {
  const sourceLabel = (callId: string) =>
    `Response ${evidence.findIndex((source) => source.callId === callId) + 1} · ${evidence.find((source) => source.callId === callId)?.modelId ?? 'Source'}`;
  return (
    <div
      style={{
        display: 'grid',
        gap: 16,
        fontSize: 13,
        lineHeight: 1.7,
        overflowWrap: 'anywhere',
      }}
    >
      <p className="cp-fineprint">
        One model’s interpretation of the saved responses. Supporting quotes
        match the original text; they do not verify the interpretation or
        establish external consensus.
      </p>
      {analysis.summaries.map((summary) => (
        <section key={summary.callId}>
          <h4>{sourceLabel(summary.callId)}</h4>
          <p style={{ whiteSpace: 'pre-wrap' }}>{summary.text}</p>
          <details>
            <summary>Supporting quotes</summary>
            {summary.quotes.map((quote) => (
              <SourceQuote key={`${quote.start}:${quote.end}`} quote={quote} />
            ))}
            <p className="cp-fineprint">Source call {summary.callId}</p>
          </details>
        </section>
      ))}
      <section>
        <h4>Generated agreement matrix</h4>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Topic</th>
                {evidence.map((source) => (
                  <th scope="col" key={source.callId}>
                    {sourceLabel(source.callId)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {analysis.matrix.map((row) => (
                <tr key={row.topic}>
                  <th scope="row">{row.topic}</th>
                  {evidence.map((source) => {
                    const position = row.positions.find(
                      (item) => item.callId === source.callId,
                    )!;
                    return (
                      <td
                        key={source.callId}
                        style={{ padding: '8px 10px', verticalAlign: 'top' }}
                      >
                        {position.position === 'unclear'
                          ? 'Unclear / not addressed'
                          : position.position === 'agrees'
                            ? 'Agrees'
                            : 'Disagrees'}
                        {position.quote && (
                          <details>
                            <summary>Source quote</summary>
                            <SourceQuote quote={position.quote} />
                          </details>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
