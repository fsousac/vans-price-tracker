// Modelo puro da aba Catálogo (sem DOM/chrome). Formatos de dados do SW lidos de forma defensiva.
import { extractProductCode } from '../../../price-monitor/url.ts';

export const REFRESH_MS = 24 * 3_600_000;
const SLUG = /^[a-z0-9-]{1,120}$/;
const CODE = /^[A-Za-z0-9]{8,20}$/;

export interface CatalogRow { code: string; name: string; slug: string | null; priceCents: number | null }
export interface VariantOption { code: string; size: string; available: boolean }
export interface Inspected { code: string; name: string; variants: VariantOption[] }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Link da loja montado só do code (e do slug, se seguro): nunca usa texto livre como URL. */
export function storeUrl(code: string, slug?: string | null): string | null {
  if (!CODE.test(code)) return null;
  return `https://www.vans.com.br/${slug && SLUG.test(slug) ? `${slug}/` : ''}p/${code}`;
}

/** Resposta de catalog.search -> linhas válidas (descarta item sem code/nome) + data da última atualização. */
export function parseSearch(data: unknown): { rows: CatalogRow[]; refreshedAt: string | null } {
  const d = isObj(data) ? data : {};
  const rows = (Array.isArray(d.items) ? d.items : []).flatMap((i): CatalogRow[] =>
    isObj(i) && typeof i.code === 'string' && CODE.test(i.code) && typeof i.name === 'string' && i.name !== ''
      ? [{
          code: i.code, name: i.name,
          slug: typeof i.lastSlug === 'string' ? i.lastSlug : typeof i.slug === 'string' ? i.slug : null,
          priceCents: Number.isSafeInteger(i.priceCents) && (i.priceCents as number) >= 0 ? (i.priceCents as number) : null,
        }]
      : []);
  const at = typeof d.refreshedAt === 'string' && !Number.isNaN(Date.parse(d.refreshedAt)) ? d.refreshedAt : null;
  return { rows, refreshedAt: at };
}

/** Atualização liberada se nunca feita ou há >= 24 h. `nextAt` = quando libera. */
export function refreshState(refreshedAt: string | null, nowMs: number): { allowed: boolean; nextAt: string | null } {
  const t = refreshedAt === null ? NaN : Date.parse(refreshedAt);
  if (Number.isNaN(t) || nowMs - t >= REFRESH_MS) return { allowed: true, nextAt: null };
  return { allowed: false, nextAt: new Date(t + REFRESH_MS).toISOString() };
}

/** Valida a URL colada. Hostil/inválida: mensagem e nada é enviado (zero rede). */
export function checkUrl(input: string): { ok: true; code: string } | { ok: false; message: string } {
  const r = extractProductCode(input);
  return r.ok ? { ok: true, code: r.value } : { ok: false, message: r.error.message };
}

export const UNSUPPORTED = 'Este formato de página da Vans ainda não é suportado; o produto não pode ser monitorado por enquanto.';

/** Resposta de tab.inspect -> produto + tamanhos (só disponível/indisponível) ou mensagem. */
export function parseInspect(data: unknown): { ok: true; value: Inspected } | { ok: false; message: string } {
  const d = isObj(data) ? data : {};
  if (d.state === 'formato_desconhecido' || (isObj(d.product) && d.product.state === 'formato_desconhecido'))
    return { ok: false, message: UNSUPPORTED };
  const p = isObj(d.product) ? d.product : d;
  const raw = Array.isArray(d.variants) ? d.variants : Array.isArray(p.variants) ? p.variants : [];
  const variants = raw.flatMap((v): VariantOption[] =>
    isObj(v) && typeof v.code === 'string' && typeof v.size === 'string'
      ? [{ code: v.code, size: v.size, available: v.available === true }]
      : []);
  if (typeof p.code !== 'string' || typeof p.name !== 'string' || variants.length === 0)
    return { ok: false, message: 'Não foi possível ler os tamanhos deste produto agora.' };
  return { ok: true, value: { code: p.code, name: p.name, variants } };
}

/** Erro do SW: falha de formato vira "ainda não suportado"; o resto mantém a mensagem pt-BR. */
export const errorText = (e: { code: string; message: string }): string =>
  /formato_desconhecido/.test(e.message) ? UNSUPPORTED : e.message;
