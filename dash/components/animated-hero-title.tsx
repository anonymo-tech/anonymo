'use client';

import { useEffect, useMemo, useState } from 'react';

import { useT } from '@/lib/i18n';

type HeroPhrase = readonly string[];

const PHRASES = [
  'MANY{line}GREAT MINDS.{line}ONE{line}COMMON{line}GROUND.',
  'YOUR{line}NEXT QUESTION.{line}MORE{line}THAN ONE{line}ANSWER.',
  'SEE{line}WHAT ONE{line}MODEL{line}ALONE{line}MISSES.',
] as const;

const SCRAMBLE_CHARACTERS = 'CONCLAVE+-*#=';
const CYCLE_DURATION = 5000;
const SCRAMBLE_DURATION = 700;
const CHARACTER_STEP_DURATION = 64;

function scrambleWord(
  source: string,
  target: string,
  wordIndex: number,
  progress: number,
) {
  const length = Math.max(source.length, target.length);
  let result = '';

  for (let characterIndex = 0; characterIndex < length; characterIndex += 1) {
    const sourceCharacter = source[characterIndex] ?? '';
    const targetCharacter = target[characterIndex] ?? '';

    if (targetCharacter === ' ') {
      result += ' ';
      continue;
    }

    const order = ((characterIndex * 7 + wordIndex * 11) % 17) / 16;
    const settlesAt = 0.18 + order * 0.66;

    if (progress >= settlesAt) {
      result += targetCharacter;
    } else if (progress < 0.08 && sourceCharacter) {
      result += sourceCharacter;
    } else {
      const randomIndex = Math.floor(
        Math.random() * SCRAMBLE_CHARACTERS.length,
      );
      result += SCRAMBLE_CHARACTERS[randomIndex];
    }
  }

  return result.trimEnd();
}

export function AnimatedHeroTitle() {
  const t = useT();
  // Five deliberate phrase segments preserve the four-line composition in both languages.
  const phrases = useMemo(
    () => PHRASES.map((phrase) => t(phrase, { line: '\n' }).split('\n')),
    [t],
  );
  const [frame, setFrame] = useState(() => ({
    locale: t.locale,
    words: [...phrases[0]],
  }));
  const words = frame.locale === t.locale ? frame.words : phrases[0];

  useEffect(() => {
    const setWords = (words: string[]) => setFrame({ locale: t.locale, words });
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let sourceWords: string[] = [...phrases[0]];
    let phraseIndex = 0;
    let animationFrame = 0;
    let interval = 0;

    const stop = () => {
      cancelAnimationFrame(animationFrame);
      window.clearInterval(interval);
      animationFrame = 0;
      interval = 0;
    };

    const transitionTo = (target: HeroPhrase) => {
      cancelAnimationFrame(animationFrame);
      const startedAt = performance.now();
      let lastCharacterStep = startedAt - CHARACTER_STEP_DURATION;

      const animate = (now: number) => {
        const progress = Math.min((now - startedAt) / SCRAMBLE_DURATION, 1);
        const shouldUpdateCharacters =
          now - lastCharacterStep >= CHARACTER_STEP_DURATION || progress >= 1;

        if (shouldUpdateCharacters) {
          lastCharacterStep = now;
          setWords(
            target.map((word, index) =>
              scrambleWord(sourceWords[index] ?? '', word, index, progress),
            ),
          );
        }

        if (progress < 1) {
          animationFrame = requestAnimationFrame(animate);
        } else {
          sourceWords = [...target];
          setWords([...target]);
          animationFrame = 0;
        }
      };

      animationFrame = requestAnimationFrame(animate);
    };

    const configure = () => {
      stop();
      phraseIndex = 0;
      sourceWords = [...phrases[0]];
      setWords([...phrases[0]]);

      if (reducedMotion.matches) return;

      interval = window.setInterval(() => {
        if (document.hidden || window.scrollY > window.innerHeight) return;
        phraseIndex = (phraseIndex + 1) % phrases.length;
        transitionTo(phrases[phraseIndex]);
      }, CYCLE_DURATION);
    };

    configure();
    reducedMotion.addEventListener('change', configure);

    return () => {
      reducedMotion.removeEventListener('change', configure);
      stop();
    };
  }, [phrases, t.locale]);

  return (
    <h1
      className="hero-title"
      data-scroll-drift
      data-drift-y="76"
      aria-label={t('Many great minds. One common ground.')}
    >
      <span className="hero-title__visual" aria-hidden="true">
        <span className="hero-title__line">{words[0]}</span>
        <span className="hero-title__line hero-title__line--vision">
          {words[1]}
        </span>
        <span
          className="hero-title__line hero-title__line--split"
          style={t.locale === 'zh' ? { columnGap: '0.25em' } : undefined}
        >
          <span>{words[2]}</span>
          <span className="hero-title__timeless">{words[3]}</span>
        </span>
        <span className="hero-title__line">{words[4]}</span>
      </span>
    </h1>
  );
}
