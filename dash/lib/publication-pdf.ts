import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Give each edition its own cache key while keeping the download's filename. */
export function publicationPdfUrl(filename: string): string {
  const bytes = readFileSync(join(process.cwd(), 'public', 'publications', filename));
  const version = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  return '/publications/' + filename + '?v=' + version;
}
