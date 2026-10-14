'use client';

import { setLocale, useT } from '@/lib/i18n';
import './language-toggle.css';

/** EN / 中文 switch for each page's top bar. It inherits the bar's colour and type. */
export function LanguageToggle({ className }: { className?: string }) {
  const t = useT();
  return (
    <fieldset
      className={className ? `language-toggle ${className}` : 'language-toggle'}
      aria-label={t('Language')}
    >
      <button
        type="button"
        lang="en"
        aria-pressed={t.locale === 'en'}
        onClick={() => setLocale('en')}
      >
        EN
      </button>
      <span aria-hidden="true">/</span>
      <button
        type="button"
        lang="zh-CN"
        aria-pressed={t.locale === 'zh'}
        onClick={() => setLocale('zh')}
      >
        中文
      </button>
    </fieldset>
  );
}
