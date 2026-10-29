// Trecho puro (sem node:*) da validação de saída; usado por SafeHttpClient e FetchHttpClient (S2, S5).

export const ALLOWED_HOSTS: readonly string[] = Object.freeze(['www.vans.com.br']); // S5: lista exata; mudança exige ADR
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function validateOutboundUrl(u: URL): boolean {
  return (
    u.protocol === 'https:' &&
    (u.port === '' || u.port === '443') &&
    u.username === '' &&
    u.password === '' &&
    ALLOWED_HOSTS.includes(u.hostname)
  );
}

const OCC_PRODUCT = /^\/arezzocoocc\/v2\/vans\/products\/[A-Za-z0-9]{8,20}$/;
const OCC_SEARCH = '/arezzocoocc/v2/vans/products/search';
const PRODUCT_PAGE = /^\/(?:[a-z0-9-]+\/)?p\/[A-Za-z0-9]{8,20}$/;

// Host + caminho: só os três recursos que o produto consome (OCC por code, listagem SAPATOS, página de produto).
export function validateOutboundRequest(u: URL): boolean {
  if (!validateOutboundUrl(u)) return false;
  if (u.pathname === OCC_SEARCH) return u.searchParams.get('category') === 'SAPATOS';
  return OCC_PRODUCT.test(u.pathname) || PRODUCT_PAGE.test(u.pathname);
}

export function parseRetryAfter(v: string | string[] | null | undefined, nowMs: number): number | undefined {
  if (typeof v !== 'string') return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - nowMs);
}
