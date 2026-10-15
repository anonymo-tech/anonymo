'use client';
import { useState } from 'react';
import type { TokenDeep } from '../../lib/second-look/token';
import { shortAddress } from '../../lib/client/second-look';
import { EvidenceLink } from './shared';

type Launch = NonNullable<TokenDeep['launch']>;
const slotNumber = (value: string | number) => BigInt(value);

export function LaunchReplay({ launch }: { launch: Launch }) {
  const [selected, setSelected] = useState<number | null>(null);
  const start = slotNumber(launch.createSlot);
  const slots = Array.from({ length: 100 }, (_, offset) => ({
    offset,
    events: launch.events.filter(
      (event) => slotNumber(event.slot) === start + slotNumber(offset),
    ),
  }));
  const peak = Math.max(1, ...slots.map((slot) => slot.events.length));
  const events = selected === null ? launch.events : slots[selected].events;
  return (
    <section className="sl-launch" aria-label="Launch replay">
      <div className="sl-section-heading">
        <h3>First 100 launch slots</h3>
        <span>{launch.events.length} observed events</span>
      </div>
      <p className="sl-muted">
        Select a slot to inspect its recorded activity.
      </p>
      <div
        className="sl-launch-chart"
        aria-label="Observed events by launch slot"
      >
        {slots.map(({ offset, events: slotEvents }) => (
          <button
            key={offset}
            className={selected === offset ? 'is-selected' : ''}
            aria-pressed={selected === offset}
            aria-label={`Slot +${offset}: ${slotEvents.length} observed events`}
            title={`+${offset} · ${slotEvents.length} events`}
            onClick={() => setSelected(selected === offset ? null : offset)}
          >
            <span
              style={{
                height: `${Math.max(3, (slotEvents.length / peak) * 100)}%`,
              }}
            />
          </button>
        ))}
      </div>
      <div className="sl-launch-scale">
        <span>Launch · {launch.createSlot}</span>
        <span>+99 slots</span>
      </div>
      <div className="sl-section-heading sl-launch-filter">
        <span>
          {selected === null ? 'All recorded events' : `Slot +${selected}`}
        </span>
        {selected !== null && (
          <button className="sl-text-button" onClick={() => setSelected(null)}>
            Show all
          </button>
        )}
      </div>
      <div className="sl-table-scroll">
        <table className="sl-launch-table">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Event</th>
              <th>Wallet</th>
              <th>Linked group</th>
              <th>Still held¹</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event, i) => (
              <tr key={`${event.signature}-${event.slot}-${i}`}>
                <td>+{(slotNumber(event.slot) - start).toString()}</td>
                <td>{event.kind}</td>
                <td>
                  {event.wallet ? (
                    <EvidenceLink
                      href={`https://solscan.io/account/${event.wallet}`}
                    >
                      {shortAddress(event.wallet)}
                    </EvidenceLink>
                  ) : (
                    'Unknown'
                  )}
                </td>
                <td>{event.clusterId ?? 'Unknown'}</td>
                <td>{event.stillHoldingRaw ?? 'Unknown'}</td>
                <td>
                  <EvidenceLink
                    href={`https://solscan.io/tx/${encodeURIComponent(event.signature)}`}
                  >
                    {shortAddress(event.signature)}
                  </EvidenceLink>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!events.length && (
        <p className="sl-muted">No recorded events in this selection.</p>
      )}
      <p className="sl-muted">
        ¹ Raw token units at the report observation time. Linked groups are
        indications, not proof of shared ownership.
      </p>
      {launch.truncated && (
        <p className="sl-notice">
          This replay is a bounded excerpt. Missing activity is not evidence
          that no activity occurred.
        </p>
      )}
    </section>
  );
}
