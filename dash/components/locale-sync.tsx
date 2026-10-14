'use client';

import { useEffect, useRef } from 'react';
import { useLocale, useT } from '@/lib/i18n';

/** Keeps the document's language and title in step with the EN / 中文 choice. */
export function LocaleSync() {
  const locale = useLocale();
  const t = useT();
  const title = useRef<string | null>(null);
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    title.current ??= document.title;
    document.title = t(title.current);
  }, [locale, t]);
  return null;
}
