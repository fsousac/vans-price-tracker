// Remove de um corpo bruto (HTML/JSON/cabeçalhos) o que identifica a pessoa ou a campanha:
// cookies, tokens, UTM e fbclid (RNF-PRIV-02, S12). Texto sem esses campos sai idêntico.
const QUERY = /\?(?:[^\s"'<>\\]|\\u0026)+/g; // "?a=1&amp;b=2" (também "&" de JSON)
const SEPARATOR = /(&amp;|\\u0026|&)/;
const TRACKING = /^(?:utm_[A-Za-z0-9_]*|fbclid|gclid|msclkid)=/i;
const COOKIE_LINE = /^[ \t]*(?:set-cookie|cookie|authorization|proxy-authorization)[ \t]*:.*(?:\r?\n|$)/gim;
const SESSION_ID = /\b(?:JSESSIONID|PHPSESSID|sessionid)=[^;\s"'<>\\]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

function stripTracking(query: string): string {
  const parts = query.slice(1).split(SEPARATOR); // pares nos índices pares, separadores nos ímpares
  const pairs = parts.filter((_, i) => i % 2 === 0);
  const kept = pairs.filter((p) => !TRACKING.test(p));
  if (kept.length === pairs.length) return query;
  return kept.length ? `?${kept.join(parts[1] ?? '&')}` : '';
}

export function sanitizeBody(body: string): string {
  return body
    .replace(COOKIE_LINE, '')
    .replace(QUERY, stripTracking)
    .replace(SESSION_ID, '')
    .replace(BEARER, 'Bearer [redacted]');
}
