'use client';

// The ticket printer (update "tickets"): the mascot leans over a slot and the ticket feeds out of it, in the manner of
// the landing page's receipt printer. The ticket is one canvas, drawn by lib/anonymo/ticket-art.ts, so what is on
// screen is exactly what "Save picture" saves.

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { encodeQr } from '@/lib/anonymo/qr';
import { drawTicket, TICKET_ART, ticketAlt } from '@/lib/anonymo/ticket-art';
import type { MicroUsd } from '@/lib/anonymo/types';
import './tickets.css';

const FONT = "'Space Grotesk Variable', ui-sans-serif, system-ui, sans-serif";

export type PrintedTicket = {
  amountMusd: MicroUsd;
  expiresAt: string | null;
  /** The ticket link to print as a QR code. Null prints the preview, with the place where the code will go. */
  link: string | null;
  /** With no link: a stamp where the code would be, for the page a ticket opens. */
  stamp?: string;
};

/**
 * `feed` names the sheet of paper: when it changes, a new sheet feeds out of the slot. Redrawing the same sheet (the
 * amount changing in the preview) does not feed again.
 */
export function TicketPrinter({ ticket, feed, canvasRef }: { ticket: PrintedTicket | null; feed: string; canvasRef?: RefObject<HTMLCanvasElement | null> }) {
  const own = useRef<HTMLCanvasElement>(null);
  const canvas = canvasRef ?? own;
  const link = ticket?.link ?? null;
  const qr = useMemo(() => {
    if (!link) return null;
    try {
      return encodeQr(link);
    } catch {
      return null; // a link too long for a code: the ticket still prints, without one
    }
  }, [link]);
  const amountMusd = ticket?.amountMusd ?? null;
  const expiresAt = ticket?.expiresAt ?? null;
  const stamp = ticket?.stamp;

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || amountMusd === null) return;
    let live = true;
    const draw = () => live && drawTicket(ctx, { amountMusd, expiresAt, qr, stamp }, FONT);
    draw();
    // The first drawing may land before the font does; draw again once it is ready.
    const fonts = document.fonts;
    if (fonts?.load) void Promise.all([fonts.load(`600 84px ${FONT}`), fonts.load(`500 38px ${FONT}`)]).then(draw, () => undefined);
    return () => {
      live = false;
    };
  }, [canvas, feed, amountMusd, expiresAt, qr, stamp]); // `feed`: a new sheet is a new canvas, and it starts blank

  return (
    <div className="tk-printer">
      <div className="tk-mascot" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/mascot/peek-1.jpg" alt="" width={520} height={470} decoding="async" />
      </div>
      <div className="tk-slot" aria-hidden="true" />
      <div className="tk-window">
        {/* No ticket: the slot stays empty. */}
        {ticket && (
          <div className="tk-paper" key={feed}>
            <canvas ref={canvas} width={TICKET_ART.width} height={TICKET_ART.height} role="img" aria-label={ticketAlt({ ...ticket, qr })} />
          </div>
        )}
      </div>
    </div>
  );
}
