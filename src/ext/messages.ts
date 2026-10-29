import { validateEmail, validateMargin, validateTarget } from '../alerts/validation.ts';
import { err, ok, type Result } from '../shared/result.ts';

// Contrato UI -> service worker (extension-architecture.md seção 11). Sem `chrome`: só tipos e guardas puras.
// O SW valida `sender` separadamente (api.ts); aqui só forma e limites do payload.

export type Request =
  | { type: 'tab.inspect'; url: string }
  | { type: 'alert.create'; variantCode: string; target: string; margin?: string }
  | { type: 'alert.update'; id: number; target?: string; margin?: string }
  | { type: 'alert.pause' | 'alert.resume' | 'alert.delete'; id: number }
  | { type: 'alerts.list' | 'health.get' | 'monitor.runNow' | 'catalog.refresh' | 'settings.get' | 'email.test' }
  | { type: 'history.get'; alertId: number; page: number }
  | { type: 'product.resume'; code: string }
  | { type: 'catalog.search'; q: string }
  | { type: 'settings.set'; settings: SettingsInput }
  | { type: 'notification.resend'; key: string };
export type RequestType = Request['type'];

/** apiKey: ausente = manter; null = remover; string = trocar. A UI nunca recebe a chave (só apiKeySet). */
export interface SettingsInput {
  intervalHours: number;
  email: { mode: 'teste' | 'real'; enabled: boolean; to: string; from: string; apiKey?: string | null };
}

export type ErrorCode =
  | 'requisicao_invalida' | 'remetente_invalido' | 'nao_encontrado' | 'duplicado' | 'circuito_aberto'
  | 'permissao_ausente' | 'somente_leitura' | 'falha_externa' | 'interno';
export interface ApiError { code: ErrorCode; message: string }
export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: ApiError };

export const okResponse = <T>(data: T): Response<T> => ({ ok: true, data });
export const errResponse = (code: ErrorCode, message: string): Response<never> => ({ ok: false, error: { code, message } });

const ERROR_CODES: readonly string[] = [
  'requisicao_invalida', 'remetente_invalido', 'nao_encontrado', 'duplicado', 'circuito_aberto',
  'permissao_ausente', 'somente_leitura', 'falha_externa', 'interno',
];
/** Guarda do lado da UI: resposta fora do formato vira erro, nunca dado. */
export function parseResponse(x: unknown): Response {
  if (isObj(x)) {
    if (x.ok === true && 'data' in x) return { ok: true, data: x.data };
    if (x.ok === false && isObj(x.error) && ERROR_CODES.includes(x.error.code as string) && typeof x.error.message === 'string')
      return { ok: false, error: { code: x.error.code as ErrorCode, message: x.error.message } };
  }
  return errResponse('interno', 'Resposta inesperada da extensão.');
}

const BAD = 'Requisição inválida.';
const NO_ARG: readonly string[] = ['alerts.list', 'health.get', 'monitor.runNow', 'catalog.refresh', 'settings.get', 'email.test'];
const ID_ONLY: readonly string[] = ['alert.pause', 'alert.resume', 'alert.delete'];
const CODE_RE = /^[A-Za-z0-9]{8,20}$/;
const VARIANT_RE = /^[A-Za-z0-9]{8,20}-[A-Za-z0-9]{1,12}$/;
const KEY_RE = /^[A-Za-z0-9|_-]{1,80}$/;
const CTRL_RE = /[\x00-\x1f\x7f]/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const isStr = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;
const bad = (m: string = BAD) => err(m);

/** Valida e estreita uma mensagem desconhecida. Campos extras são descartados (copia só o que conhece). */
export function parseRequest(x: unknown): Result<Request, string> {
  if (!isObj(x) || typeof x.type !== 'string') return bad();
  const t = x.type;
  if (NO_ARG.includes(t)) return ok({ type: t } as Request);
  if (ID_ONLY.includes(t)) return isId(x.id) ? ok({ type: t, id: x.id } as Request) : bad();
  switch (t) {
    case 'tab.inspect':
      return isStr(x.url, 2048) && x.url !== '' ? ok({ type: t, url: x.url }) : bad();
    case 'alert.create': {
      if (typeof x.variantCode !== 'string' || !VARIANT_RE.test(x.variantCode)) return bad();
      const f = fields(x);
      if (!f.ok) return f;
      if (f.value.target === undefined) return bad('Informe o preço-alvo.');
      return ok({ type: t, variantCode: x.variantCode, target: f.value.target, margin: f.value.margin });
    }
    case 'alert.update': {
      if (!isId(x.id)) return bad();
      const f = fields(x);
      return f.ok ? ok({ type: t, id: x.id, ...f.value }) : f;
    }
    case 'history.get':
      return isId(x.alertId) && Number.isSafeInteger(x.page) && (x.page as number) >= 0 && (x.page as number) <= 10_000
        ? ok({ type: t, alertId: x.alertId, page: x.page as number })
        : bad();
    case 'product.resume':
      return typeof x.code === 'string' && CODE_RE.test(x.code) ? ok({ type: t, code: x.code }) : bad();
    case 'catalog.search':
      return isStr(x.q, 100) ? ok({ type: t, q: x.q }) : bad();
    case 'notification.resend':
      return typeof x.key === 'string' && KEY_RE.test(x.key) ? ok({ type: t, key: x.key }) : bad();
    case 'settings.set':
      return parseSettings(x.settings);
    default:
      return bad('Tipo de requisição desconhecido.');
  }
}

// Alvo/margem em texto, validados pelas mesmas regras do formulário (RF-04/05). Ausente = não informado.
function fields(x: Record<string, unknown>): Result<{ target?: string; margin?: string }, string> {
  const out: { target?: string; margin?: string } = {};
  if (x.target !== undefined) {
    if (!isStr(x.target, 32)) return bad();
    const r = validateTarget(x.target);
    if (!r.ok) return r;
    out.target = x.target;
  }
  if (x.margin !== undefined) {
    if (!isStr(x.margin, 16)) return bad();
    const r = validateMargin(x.margin);
    if (!r.ok) return r;
    out.margin = x.margin;
  }
  return ok(out);
}

function parseSettings(s: unknown): Result<Request, string> {
  if (!isObj(s) || !isObj(s.email)) return bad();
  const e = s.email;
  if (!Number.isInteger(s.intervalHours) || (s.intervalHours as number) < 2 || (s.intervalHours as number) > 6)
    return bad('O intervalo deve ficar entre 2 e 6 horas.');
  if ((e.mode !== 'teste' && e.mode !== 'real') || typeof e.enabled !== 'boolean') return bad();
  if (!isStr(e.to, 254) || !isStr(e.from, 254) || CTRL_RE.test(e.from)) return bad();
  if (e.enabled) {
    const to = validateEmail(e.to);
    if (!to.ok) return to;
    if (e.from.trim() === '') return bad('Informe o remetente.');
  } else if (e.to !== '' && !validateEmail(e.to).ok) return bad('E-mail inválido.');
  let apiKey: string | null | undefined;
  if (e.apiKey !== undefined && e.apiKey !== null) {
    if (!isStr(e.apiKey, 256) || CTRL_RE.test(e.apiKey) || e.apiKey.trim() === '') return bad('Chave inválida.');
    apiKey = e.apiKey;
  } else apiKey = e.apiKey as null | undefined;
  const email: SettingsInput['email'] = { mode: e.mode, enabled: e.enabled, to: e.to.trim(), from: e.from.trim() };
  if (apiKey !== undefined) email.apiKey = apiKey;
  return ok({ type: 'settings.set', settings: { intervalHours: s.intervalHours as number, email } });
}
