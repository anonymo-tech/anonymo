'use client';

import { useT } from '@/lib/i18n';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import './model-banner.css';

const MODELS_AND_STACK = [
  { name: 'Claude', mark: 'claude' },
  { name: 'GPT', mark: 'openai', family: 'OpenAI' },
  { name: 'Gemini', mark: 'gemini' },
  { name: 'DeepSeek', mark: 'deepseek' },
  { name: 'Qwen', mark: 'qwen' },
  { name: 'Llama', mark: 'meta', family: 'Meta' },
  { name: 'Solana', mark: 'solana' },
] as const;

export function ModelBanner({ paused = false }: { paused?: boolean }) {
  const t = useT();
  const host = useRef<HTMLElement>(null);
  const outlineId = `provider-outline-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [active, setActive] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let inView = false;
    const sync = () => setActive(inView && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      sync();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', sync);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  return (
    <section
      ref={host}
      className="model-banner"
      aria-label={t('Model families in the workspace preview, and Solana')}
      data-running={active && !paused}
      style={{ '--provider-outline': `url(#${outlineId})` } as CSSProperties}
    >
      <svg
        className="model-banner-definitions"
        aria-hidden="true"
        width="0"
        height="0"
      >
        <defs>
          <filter
            id={outlineId}
            x="-10%"
            y="-10%"
            width="120%"
            height="120%"
            colorInterpolationFilters="sRGB"
          >
            <feMorphology
              in="SourceAlpha"
              operator="dilate"
              radius="1.2"
              result="outline"
            />
            <feFlood floodColor="#171713" result="ink" />
            <feComposite
              in="ink"
              in2="outline"
              operator="in"
              result="blackOutline"
            />
            <feMerge>
              <feMergeNode in="blackOutline" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      </svg>
      <div className="model-banner-track">
        {[0, 1].map((copy) => (
          <ul
            className="model-banner-set"
            key={copy}
            aria-hidden={copy === 1 ? true : undefined}
          >
            {MODELS_AND_STACK.map((model) => (
              <li
                className={`model-banner-item model-banner-${model.mark}`}
                key={model.mark}
              >
                <span
                  className="model-banner-logo"
                  style={
                    {
                      '--provider-logo': `url('/brand/providers/${model.mark}.svg')`,
                    } as CSSProperties
                  }
                  aria-hidden="true"
                />
                <span className="model-banner-name">
                  {model.name}
                  {'family' in model && <small>{model.family}</small>}
                </span>
                <span className="model-banner-divider" aria-hidden="true">
                  ✦
                </span>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </section>
  );
}
