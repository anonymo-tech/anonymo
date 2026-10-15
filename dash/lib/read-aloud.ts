/** Short utterances avoid platform limits without truncating a long answer. */
export function speechChunks(text: string): string[] {
  const words = text.trim().split(/\s+/u);
  if (!text.trim()) return [];
  const result: string[] = [];
  let chunk = '';
  for (const word of words) {
    if (chunk.length + word.length + 1 > 220 && chunk) {
      result.push(chunk);
      chunk = '';
    }
    if (word.length > 220) {
      if (chunk) {
        result.push(chunk);
        chunk = '';
      }
      for (let i = 0; i < word.length; i += 220)
        result.push(word.slice(i, i + 220));
    } else chunk += (chunk ? ' ' : '') + word;
  }
  if (chunk) result.push(chunk);
  return result;
}
