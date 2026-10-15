/** One public origin keeps wallet challenges, passkeys and secure cookies aligned. */
export function middleware(request: Request) {
  const url = new URL(request.url);
  if (url.hostname !== 'www.conclavemodels.com') return;
  url.hostname = 'conclavemodels.com';
  url.protocol = 'https:';
  url.port = '';
  return Response.redirect(url, 308);
}
