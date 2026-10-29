import { validateMargin, validateTarget } from '../../../alerts/validation.ts';
import { extractProductCode } from '../../../price-monitor/url.ts';
import { err, ok, type Result } from '../../../shared/result.ts';
import type { Response } from '../../messages.ts';
import { brl } from '../format.ts';

// Modelo de visão puro do popup (E22). Contrato esperado de `tab.inspect` (data):
// { code, name, variants: [{ variantCode, size, priceCents|null, available }],
//   monitored: [{ id, variantCode, targetCents, marginBp, state }] }

export interface InspectVariant { variantCode: string; size: string; priceCents: number | null; available: boolean }
export interface InspectMonitored { id: number; variantCode: string; targetCents: number; marginBp: number; state: string }
export interface Inspect { code: string; name: string; variants: InspectVariant[]; monitored: InspectMonitored[] }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCents = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const str = (x: unknown): x is string => typeof x === 'string' && x !== '';

/** Resposta fora do formato vira erro: preço ausente/inválido nunca vira 0 (falha nunca é preço). */
export function parseInspect(x: unknown): Result<Inspect, string> {
  const bad = err('Resposta inesperada da extensão.');
  if (!isObj(x) || !str(x.code) || !str(x.name) || !Array.isArray(x.variants)) return bad;
  const variants: InspectVariant[] = [];
  for (const v of x.variants) {
    if (!isObj(v) || !str(v.variantCode) || !str(v.size) || typeof v.available !== 'boolean') return bad;
    if (v.priceCents != null && !isCents(v.priceCents)) return bad;
    variants.push({ variantCode: v.variantCode, size: v.size, priceCents: (v.priceCents as number | null | undefined) ?? null, available: v.available });
  }
  const monitored: InspectMonitored[] = [];
  for (const m of Array.isArray(x.monitored) ? x.monitored : []) {
    if (!isObj(m) || !Number.isSafeInteger(m.id) || !str(m.variantCode) || !isCents(m.targetCents) || !isCents(m.marginBp) || !str(m.state)) return bad;
    monitored.push({ id: m.id as number, variantCode: m.variantCode, targetCents: m.targetCents, marginBp: m.marginBp, state: m.state });
  }
  return ok({ code: x.code, name: x.name, variants, monitored });
}

export type PopupState =
  | { kind: 'nao_produto'; message: string }
  | { kind: 'erro'; message: string }
  | { kind: 'circuito'; message: string }
  | { kind: 'produto'; inspect: Inspect };

/** URL da aba: só produto Vans segue para o SW; o resto nunca gera requisição. */
export function tabUrlToRequestUrl(url: string | undefined): Result<string, string> {
  if (!url) return err('Abra a página de um produto em vans.com.br e clique no ícone novamente.');
  const r = extractProductCode(url);
  return r.ok ? ok(url) : err('Esta aba não é a página de um produto da Vans. Abra um produto em vans.com.br (endereço terminado em /p/CÓDIGO) e tente de novo.');
}

export function popupState(url: string | undefined, resp: Response | null): PopupState {
  const u = tabUrlToRequestUrl(url);
  if (!u.ok) return { kind: 'nao_produto', message: u.error };
  if (!resp) return { kind: 'erro', message: 'Não foi possível ler o produto.' };
  if (!resp.ok) return { kind: resp.error.code === 'circuito_aberto' ? 'circuito' : 'erro', message: resp.error.message };
  const p = parseInspect(resp.data);
  return p.ok ? { kind: 'produto', inspect: p.value } : { kind: 'erro', message: p.error };
}

export interface SizeOption { variantCode: string; label: string; available: boolean; monitored: boolean }
/** Rótulo sempre com texto de disponibilidade (não só cor). Indisponível continua selecionável. */
export function sizeOptions(i: Inspect): SizeOption[] {
  const mon = new Set(i.monitored.map((m) => m.variantCode));
  return i.variants.map((v) => ({
    variantCode: v.variantCode,
    available: v.available,
    monitored: mon.has(v.variantCode),
    label: `${v.size} — ${brl(v.priceCents)} — ${v.available ? 'disponível' : 'indisponível'}${mon.has(v.variantCode) ? ' (já monitorado)' : ''}`,
  }));
}

/** Primeiro tamanho disponível ainda não monitorado; senão o primeiro não monitorado; senão ''. */
export function defaultVariant(i: Inspect): string {
  const o = sizeOptions(i);
  return (o.find((x) => x.available && !x.monitored) ?? o.find((x) => !x.monitored))?.variantCode ?? '';
}

export interface FormInput { variantCode: string; target: string; margin: string }
export interface FormResult {
  errors: Partial<Record<'variant' | 'target' | 'margin', string>>;
  warning?: string;
  request?: { type: 'alert.create'; variantCode: string; target: string; margin?: string };
}

/** Mesmas regras do SW (RF-04/05). Alvo >= preço atual = aviso, não erro. */
export function validateForm(i: Inspect, f: FormInput): FormResult {
  const errors: FormResult['errors'] = {};
  const v = i.variants.find((x) => x.variantCode === f.variantCode);
  if (!v) errors.variant = 'Escolha um tamanho.';
  else if (i.monitored.some((m) => m.variantCode === v.variantCode)) errors.variant = 'Este tamanho já está monitorado.';
  const t = validateTarget(f.target);
  if (!t.ok) errors.target = t.error;
  const m = validateMargin(f.margin);
  if (!m.ok) errors.margin = m.error;
  if (Object.keys(errors).length > 0 || !v || !t.ok) return { errors };
  const out: FormResult = { errors, request: { type: 'alert.create', variantCode: v.variantCode, target: f.target.trim() } };
  if (f.margin.trim() !== '') out.request!.margin = f.margin.trim();
  if (v.priceCents !== null && v.priceCents <= t.value) {
    out.warning = `O preço atual (${brl(v.priceCents)}) já está no alvo ou abaixo dele. O alerta só dispara após confirmação da leitura.`;
  }
  return out;
}
