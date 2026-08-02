export async function digestText(purpose: string, value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`conclave:${purpose}:v1:${value}`));
  return Buffer.from(bytes).toString('hex');
}
