// WS11 · Scout: the never-list (Ventures Backend spec, PART 4: "Never: sign-up, login, form submission beyond public
// search/filter, captcha, paywall").
//
// URL and label guards run BEFORE a request is made, so a guarded URL is noted and never fetched. Content guards run on
// a fetched page and stop that branch: its links are not followed and its body is not kept.

export type GuardKind = "login" | "signup" | "account" | "checkout" | "logout";

const PATH_GUARDS: [GuardKind, RegExp][] = [
  ["logout", /\/(log-?out|sign-?out)(\/|$|\.|\?)/i],
  ["login", /\/(log-?in|sign-?in|signon|auth|oauth2?|sso|saml|session|sessions|password|forgot|reset-password|2fa|mfa|verify)(\/|$|\.|\?)/i],
  ["signup", /\/(sign-?up|register|registration|join|create-account|onboarding|invite|trial|start-trial)(\/|$|\.|\?)/i],
  ["account", /\/(account|accounts|my-account|profile|dashboard|admin|me|user|users\/me|app\/settings)(\/|$|\.|\?)/i],
  ["checkout", /\/(checkout|cart|basket|billing|payment|payments|pay|purchase|order|orders|subscribe|subscription)(\/|$|\.|\?)/i],
];

const HOST_GUARDS: [GuardKind, RegExp][] = [
  ["login", /^(login|signin|auth|id|sso|accounts?)\./i],
  ["checkout", /^(checkout|billing|pay|payments?)\./i],
];

const LABEL_GUARDS: [GuardKind, RegExp][] = [
  ["logout", /^(log|sign) ?out$/i],
  ["login", /^(log ?in|sign ?in|member login|customer login)$/i],
  ["signup", /^(sign ?up|register|create (an )?account|join( now| free)?|start (your )?free trial)$/i],
  ["checkout", /^(checkout|check out|buy now|add to cart|pay now)$/i],
  ["account", /^(my account|account|dashboard)$/i],
];

/** A guard reason for a URL (and, optionally, the link label pointing at it), or null when it is safe to request. */
export function guardUrl(url: string, label = ""): GuardKind | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return "account";
  for (const [kind, re] of HOST_GUARDS) if (re.test(u.hostname)) return kind;
  const path = u.pathname + (u.pathname.endsWith("/") ? "" : "/");
  for (const [kind, re] of PATH_GUARDS) if (re.test(path)) return kind;
  const q = u.search.toLowerCase();
  if (/[?&](redirect|return_?to|next|continue)=/.test(q) && /log-?in|sign-?in|auth/.test(q)) return "login";
  const l = label.replace(/\s+/g, " ").trim();
  for (const [kind, re] of LABEL_GUARDS) if (re.test(l)) return kind;
  return null;
}

const CAPTCHA_MARKERS: [string, RegExp][] = [
  ["recaptcha", /g-recaptcha|google\.com\/recaptcha|recaptcha\/api\.js|grecaptcha/i],
  ["hcaptcha", /h-captcha|hcaptcha\.com/i],
  ["turnstile", /cf-turnstile|challenges\.cloudflare\.com\/turnstile/i],
  ["cloudflare-challenge", /cf-chl-|cf_chl_opt|__cf_chl_/i],
  ["captcha", /\bcaptcha\b/i],
];

export function detectCaptcha(body: string): string | null {
  for (const [kind, re] of CAPTCHA_MARKERS) if (re.test(body)) return kind;
  return null;
}

const PAYWALL_MARKERS = [
  /subscribe to (continue|read|keep reading|unlock)/i,
  /(log ?in|sign ?in) to (continue|keep) reading/i,
  /this (content|article|page) is (only )?(available )?(for|to) (subscribers|members|paying)/i,
  /members[- ]only content/i,
  /"isAccessibleForFree"\s*:\s*(false|"false")/i,
  /class="[^"]*\bpaywall\b/i,
];

export function detectPaywall(status: number, body: string): string | null {
  if (status === 402) return "402";
  return PAYWALL_MARKERS.some((re) => re.test(body)) ? "marker" : null;
}

/** A password input on the page: it is a login or sign-up surface, never filled or submitted. */
export const hasPasswordField = (html: string) => /<input\b[^>]*type\s*=\s*["']?password/i.test(html);
