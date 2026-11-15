import type { ImgHTMLAttributes } from 'react';

/**
 * A static brand photo from /public (the mascot). The files are already sized and compressed, and next/image crashes
 * inside client components under vinext's dev server, so this is a plain lazy image.
 */
export function Photo({ alt, ...props }: ImgHTMLAttributes<HTMLImageElement> & { src: string; alt: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img loading="lazy" decoding="async" alt={alt} {...props} />;
}
