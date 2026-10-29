import { validateEmail } from '../alerts/validation.ts';
import { err, ok, type Result } from '../shared/result.ts';

export const MIN_INTERVAL_H = 2;
export const MAX_INTERVAL_H = 6;
export const DEFAULT_INTERVAL_H = 4;

export type EmailMode = 'teste' | 'real';
export interface EmailSettings { mode: EmailMode; enabled: boolean; to: string; from: string; apiKey: string }
export interface Settings { v: 1; intervalHours: number; email: EmailSettings }
export interface PublicSettings { v: 1; intervalHours: number; email: Omit<EmailSettings, 'apiKey'> & { apiKeySet: boolean } }
export type SettingsField = 'intervalHours' | 'to' | 'from' | 'apiKey' | 'mode';
export type SettingsErrors = Partial<Record<SettingsField, string>>;
export interface SettingsPatch {
  intervalHours?: number;
  email?: Partial<Omit<EmailSettings, 'apiKey'>> & { apiKey?: string };
}

export const publicSettings = (s: Settings): PublicSettings => {
  const { apiKey, ...rest } = s.email;
  return { v: 1, intervalHours: s.intervalHours, email: { ...rest, apiKeySet: apiKey !== '' } };
};

// toJSON redigido (log/JSON.stringify nunca vê a chave); não enumerável, então structured clone
// e toStored() preservam apiKey. Nunca persistir com JSON.stringify.
function withRedaction(s: Settings): Settings {
  Object.defineProperty(s, 'toJSON', { value: () => publicSettings(s), enumerable: false });
  return s;
}

export const defaultSettings = (): Settings =>
  withRedaction({ v: 1, intervalHours: DEFAULT_INTERVAL_H, email: { mode: 'teste', enabled: false, to: '', from: '', apiKey: '' } });

// Cópia simples para persistir (com apiKey, sem toJSON).
export const toStored = (s: Settings): Settings => ({ v: 1, intervalHours: s.intervalHours, email: { ...s.email } });

const validInterval = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= MIN_INTERVAL_H && (n as number) <= MAX_INTERVAL_H;
// ponytail: chave opaca; só recusa controle/espaço e tamanho absurdo.
const validKey = (s: string) => s.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(s);
const str = (x: unknown) => (typeof x === 'string' ? x : '');

// Leitura tolerante: campo ausente/inválido/corrompido vira padrão; nunca lança (campo novo = default).
export function parseSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return defaultSettings();
  const r = raw as Record<string, unknown>;
  const e = (typeof r.email === 'object' && r.email !== null ? r.email : {}) as Record<string, unknown>;
  const to = validateEmail(str(e.to));
  const from = validateEmail(str(e.from));
  const key = str(e.apiKey).trim();
  return withRedaction({
    v: 1,
    intervalHours: validInterval(r.intervalHours) ? r.intervalHours : DEFAULT_INTERVAL_H,
    email: {
      mode: e.mode === 'real' ? 'real' : 'teste',
      enabled: e.enabled === true,
      to: to.ok ? to.value : '',
      from: from.ok ? from.value : '',
      apiKey: validKey(key) ? key : '',
    },
  });
}

// settings.set: aplica o patch (apiKey ausente mantém, '' remove) e valida. Mensagens pt-BR.
export function applySettings(cur: Settings, patch: SettingsPatch): Result<Settings, SettingsErrors> {
  const errors: SettingsErrors = {};
  const p = patch.email ?? {};
  const next: Settings = { v: 1, intervalHours: cur.intervalHours, email: { ...cur.email } };

  if (patch.intervalHours !== undefined) {
    if (validInterval(patch.intervalHours)) next.intervalHours = patch.intervalHours;
    else errors.intervalHours = `O intervalo deve ser um número inteiro de ${MIN_INTERVAL_H} a ${MAX_INTERVAL_H} horas.`;
  }
  if (p.mode !== undefined) {
    if (p.mode === 'teste' || p.mode === 'real') next.email.mode = p.mode;
    else errors.mode = 'Modo inválido.';
  }
  if (p.enabled !== undefined) next.email.enabled = p.enabled === true;
  for (const f of ['to', 'from'] as const) {
    const v = p[f];
    if (v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') { next.email[f] = ''; continue; }
    const r = validateEmail(typeof v === 'string' ? v : '\0');
    if (r.ok) next.email[f] = r.value;
    else errors[f] = f === 'from' ? 'Remetente inválido.' : r.error;
  }
  if (p.apiKey !== undefined) {
    const k = typeof p.apiKey === 'string' ? p.apiKey.trim() : '\0';
    if (validKey(k)) next.email.apiKey = k;
    else errors.apiKey = 'Chave inválida.';
  }
  // Ativar exige destinatário, remetente e (modo real) chave.
  if (next.email.enabled) {
    if (!next.email.to && !errors.to) errors.to = 'Informe o e-mail de destino.';
    if (!next.email.from && !errors.from) errors.from = 'Informe o remetente.';
    if (next.email.mode === 'real' && !next.email.apiKey && !errors.apiKey) errors.apiKey = 'Informe a chave do provedor.';
  }
  return Object.keys(errors).length ? err(errors) : ok(withRedaction(next));
}
