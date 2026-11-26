'use client';

import { ArrowUpRight } from 'lucide-react';

const shots = [
  { title: 'Palace after hours', move: 'Stop-motion ensemble', art: '/mascot/headphones.jpg',
    prompt: 'One continuous wide shot in a miniature palace ballroom. NYMO, a cream plush mascot in a plum sleep mask, taps a glowing sampler. The late British queen in a lavender hat drops the needle on a vinyl record. Spider-Man slides into a disco pose and Frankenstein’s monster claps on the beat. Keep all four in frame. Playful stop-motion puppetry, warm chandeliers, purple stage lights, a gentle camera push-in.' },
  { title: 'Through the redaction', move: 'Extreme close-up', art: '/image-studio/unredacted.webp',
    prompt: 'Hold on a halftone portrait. A black strip of paper tears slowly across the frame, revealing one eye. Rack focus from the torn edge to the eye.' },
  { title: 'Ink takes flight', move: 'Tilt up', art: '/image-studio/banned-pages.webp',
    prompt: 'Start low over an open book on a printing table. Ink birds lift off the pages. Tilt up to follow the flock into a cobalt sky.' },
];

export function VideoShotIdeas({ onPick }: { onPick: (prompt: string) => void }) {
  return <section className="video-ideas" aria-label="Shot ideas">
    <h2>Shot ideas</h2>
    <div className="video-frames">{shots.map(shot => <button type="button" key={shot.title}
      aria-label={`Use ${shot.title} prompt`} onClick={() => onPick(shot.prompt)}>
      <img src={shot.art} alt="" />
      <span><small>{shot.move}</small><strong>{shot.title}</strong></span><ArrowUpRight size={18} />
    </button>)}</div>
  </section>;
}
