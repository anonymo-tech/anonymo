'use client';

import Link from 'next/link';
import { X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  availableFeatureTips,
  type FeatureTip,
} from '@/lib/anonymo/feature-tips';

const INTERVAL = 3 * 60 * 1000;

export function useMascotTips(confirmed: boolean, demo: boolean) {
  const tips = useMemo(() => availableFeatureTips(demo), [demo]);
  const [enabled, setEnabled] = useState(true);
  const [tip, setTip] = useState<FeatureTip | null>(null);
  const next = useRef(0);
  const dismiss = useCallback(() => setTip(null), []);

  useEffect(() => {
    if (!confirmed || !enabled) return;
    let remaining = INTERVAL;
    let started = 0;
    let timer: number | undefined;
    function resume() {
      if (document.hidden || timer !== undefined) return;
      started = performance.now();
      timer = window.setTimeout(() => {
        timer = undefined;
        if (!document.hidden) {
          setTip(tips[next.current % tips.length]);
          next.current++;
        }
        remaining = INTERVAL;
        resume();
      }, remaining);
    }
    function visibilityChanged() {
      if (document.hidden && timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
        remaining = Math.max(0, remaining - (performance.now() - started));
      } else resume();
    }
    resume();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [confirmed, enabled, tips]);

  return {
    tips,
    tip: confirmed && enabled && tip && tips.includes(tip) ? tip : null,
    enabled,
    setEnabled,
    dismiss,
  };
}

export function FeatureGuide({
  tips,
  enabled,
  onToggle,
  onFollow,
}: {
  tips: FeatureTip[];
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onFollow: () => void;
}) {
  return (
    <section className="mascot-guide" aria-label="Feature guide">
      <label className="mascot-reminders-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onToggle(event.target.checked)}
        />
        Show a tip every 3 minutes in this tab
      </label>
      <ul>
        {tips.map((tip) => (
          <li key={tip.title}>
            <Link href={tip.href} onClick={onFollow}>
              {tip.title}
            </Link>
            <p>{tip.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MascotTip({
  tip,
  anchor,
  onDismiss,
  onGuide,
}: {
  tip: FeatureTip;
  anchor?: RefObject<HTMLButtonElement | null>;
  onDismiss: () => void;
  onGuide: () => void;
}) {
  const card = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = card.current;
    const mascot = anchor?.current;
    if (!element || !mascot) return;
    function place() {
      if (!element || !mascot) return;
      const box = mascot.getBoundingClientRect();
      const width = element.offsetWidth,
        height = element.offsetHeight;
      const left = Math.min(
        innerWidth - width - 8,
        Math.max(8, box.left + box.width / 2 - width / 2),
      );
      const top =
        box.top >= height + 12 ? box.top - height - 4 : box.bottom + 4;
      element.style.left = left + 'px';
      element.style.top =
        Math.max(8, Math.min(innerHeight - height - 8, top)) + 'px';
    }
    place();
    const resize = new ResizeObserver(place);
    resize.observe(element);
    resize.observe(mascot);
    window.addEventListener('resize', place);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor]);

  return (
    <aside
      ref={card}
      className={anchor ? 'mascot-tip mascot-tip-floating' : 'mascot-tip'}
      aria-label="Mascot feature tip"
    >
      <div className="mascot-tip-top">
        <Link href={tip.href} onClick={onDismiss}>
          {tip.title}
        </Link>
        <button
          className="icon-btn"
          type="button"
          aria-label="Dismiss tip"
          onClick={onDismiss}
        >
          <X size={16} />
        </button>
      </div>
      <p>{tip.text}</p>
      <button className="mascot-all-tips" type="button" onClick={onGuide}>
        All feature tips
      </button>
    </aside>
  );
}
