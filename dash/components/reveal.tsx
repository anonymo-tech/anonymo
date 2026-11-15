'use client';

// Fades sections marked `data-reveal` in as they scroll into view. It only hides them once it is running (the
// `reveal-ready` class), so nothing stays hidden without JavaScript, and the CSS skips it all for reduced motion.

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

export function RevealOnScroll() {
  const pathname = usePathname();
  useEffect(() => {
    if (!('IntersectionObserver' in window)) return;
    document.documentElement.classList.add('reveal-ready');
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    document.querySelectorAll('[data-reveal]:not(.is-in)').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pathname]);
  return null;
}
