import { parseBrlToCents, type TargetError } from '../shared/money.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { BasisPoints, Cents } from '../shared/types.ts';

export const DEFAULT_MARGIN_BP: BasisPoints = 300;
export const MAX_MARGIN_BP: BasisPoints = 5000;

export type AlertField = 'target' | 'margin' | 'email';
export type FieldErrors = Partial<Record<AlertField, string>>;

const TARGET_MSG: Record<TargetError, string> = {
  vazio: 'Informe o preço-alvo.',
  formato_invalido: 'Preço-alvo inválido. Use o formato 379,99.',
  nao_positivo: 'O preço-alvo deve ser maior que zero.',
  casas_decimais: 'O preço-alvo aceita no máximo 2 casas decimais.',
  acima_do_maximo: 'O preço-alvo deve ser de no máximo R$ 99.999,99.',
};
const MARGIN_MSG = 'Margem inválida. Use um percentual de 0 a 50, com no máximo 2 casas decimais.';
const EMAIL_MSG = 'E-mail inválido.';

export function validateTarget(input: string): Result<Cents, string> {
  const r = parseBrlToCents(input);
  return r.ok ? r : err(TARGET_MSG[r.error]);
}

// Percentual ("3", "3,5", "0.25") -> pontos-base inteiros; vazio/ausente = padrão 3% (RF-05-AC1).
export function validateMargin(input: string | undefined): Result<BasisPoints, string> {
  const s = (input ?? '').trim();
  if (s === '') return ok(DEFAULT_MARGIN_BP);
  const m = s.match(/^(\d+)(?:[.,](\d{1,2}))?$/);
  if (!m) return err(MARGIN_MSG);
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp > MAX_MARGIN_BP ? err(MARGIN_MSG) : ok(bp);
}

// Só sintaxe (RF-08-AC9). Sem CR/LF/vírgula/espaço (injeção de cabeçalho/múltiplos destinatários), <=254.
// ponytail: sem espaço/controle/vírgula/;/<>; sintaxe prática, não RFC completa.
const EMAIL_RE = /^[^\s,;<>"@\x00-\x1f\x7f]+@[^\s,;<>"@\x00-\x1f\x7f]+\.[^\s,;<>"@\x00-\x1f\x7f.]+$/;
export function validateEmail(input: string): Result<string, string> {
  const s = input.trim();
  if (s === '') return err('Informe o e-mail.');
  if (s.length > 254 || !EMAIL_RE.test(s) || s.includes('..') || s.split('@')[0]!.length > 64) return err(EMAIL_MSG);
  return ok(s);
}

export interface AlertInput {
  target: string;
  margin?: string;
  email: string;
}
export interface ValidAlert {
  targetCents: Cents;
  marginBp: BasisPoints;
  email: string;
}

export function validateAlertInput(i: AlertInput): Result<ValidAlert, FieldErrors> {
  const t = validateTarget(i.target);
  const m = validateMargin(i.margin);
  const e = validateEmail(i.email);
  if (t.ok && m.ok && e.ok) return ok({ targetCents: t.value, marginBp: m.value, email: e.value });
  const errors: FieldErrors = {};
  if (!t.ok) errors.target = t.error;
  if (!m.ok) errors.margin = m.error;
  if (!e.ok) errors.email = e.error;
  return err(errors);
}
