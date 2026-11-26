'use client';

import { ArrowUpRight } from 'lucide-react';

const palacePrompt = 'One continuous wide shot of a playful stop-motion disco in a miniature palace ballroom. Three characters share the frame. Center: NYMO, a small cream plush with a plum sleep mask, taps a glowing sampler. On the left, the late British queen in her signature lavender hat and pearls spins a vinyl record. On the right, Spider-Man in his red-and-blue webbed suit slides into a disco pose. They turn toward each other on the beat. Warm chandeliers, magenta stage lights, handmade felt and clay, gentle camera push-in. No titles or dialogue.';
const shots = [
  { title: 'Through the redaction', move: 'Extreme close-up', art: '/image-studio/unredacted.webp',
    prompt: 'Hold on a halftone portrait. A black strip of paper tears slowly across the frame, revealing one eye. Rack focus from the torn edge to the eye.' },
  { title: 'Ink takes flight', move: 'Tilt up', art: '/image-studio/banned-pages.webp',
    prompt: 'Start low over an open book on a printing table. Ink birds lift off the pages. Tilt up to follow the flock into a cobalt sky.' },
];

export function VideoShotIdeas({ onPick }: { onPick: (prompt: string) => void }) {
  return <section className="video-ideas" aria-label="Shot ideas">
    <h2>Shot ideas</h2>
    <figure className="video-featured-shot">
      <video controls muted playsInline preload="metadata" aria-label="Palace after hours, a stop-motion ballroom scene"
        poster="/video-studio/palace-after-hours.jpg" src="/video-studio/palace-after-hours.mp4" />
      <figcaption>
        <div><strong>Palace after hours</strong><small>Generated with Veo 3.1 Lite · 4s</small></div>
        <button type="button" className="btn btn-small" aria-label="Use Palace after hours prompt" onClick={() => onPick(palacePrompt)}>Use prompt <ArrowUpRight size={15} aria-hidden="true" /></button>
      </figcaption>
    </figure>
    <div className="video-frames">{shots.map(shot => <button type="button" key={shot.title}
      aria-label={`Use ${shot.title} prompt`} onClick={() => onPick(shot.prompt)}>
      <img src={shot.art} alt="" />
      <span><small>{shot.move}</small><strong>{shot.title}</strong></span><ArrowUpRight size={18} />
    </button>)}</div>
  </section>;
}
