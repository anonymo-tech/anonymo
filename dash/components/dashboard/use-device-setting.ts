'use client';
import { useEffect, useState } from 'react';

/** Preferences are separated by account; unavailable storage never discards a session edit. */
export function useDeviceSetting<T>(key: string, initial: T, valid: (value: unknown) => value is T, enabled = true) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (valid(saved)) setValue(saved);
    } catch { setError('Device storage is unavailable. Changes last for this session.'); }
    setLoaded(true);
  }, [key, valid, enabled]);
  function save(next: T) {
    if (!enabled || !loaded || !valid(next)) return;
    setValue(next);
    try { localStorage.setItem(key, JSON.stringify(next)); setError(''); }
    catch { setError('Device storage is unavailable. Changes last for this session.'); }
  }
  return { value, save, loaded, error };
}

export const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every(item => typeof item === 'string' && item.length <= 160);
