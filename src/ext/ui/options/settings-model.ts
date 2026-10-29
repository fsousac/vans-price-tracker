import { validateEmail } from '../../../alerts/validation.ts';
import { err, ok, type Result } from '../../../shared/result.ts';
import type { SettingsInput } from '../../messages.ts';

// Lógica pura da aba E-mail (RF-08, opcional). Sem DOM nem chrome: testável em node.

export const RESEND_ORIGIN = 'https://api.resend.com/*';

export interface EmailForm {
  mode: 'teste' | 'real';
  enabled: boolean;
  to: string;
  from: string;
  /** Campo senha; vazio = manter a chave já guardada. */
  apiKey: string;
}
/** Estado lido de settings.get (sem a chave) e de chrome.permissions.contains. */
export interface EmailLoaded {
  intervalHours: number;
  apiKeySet: boolean;
  granted: boolean;
}
export type EmailErrors = Partial<Record<'to' | 'from' | 'apiKey' | 'permission', string>>;

export function buildSettings(f: EmailForm, l: EmailLoaded): Result<SettingsInput, EmailErrors> {
  const e: EmailErrors = {};
  const key = f.apiKey.trim();
  const to = f.to.trim();
  if (to !== '' || f.enabled) {
    const v = validateEmail(to);
    if (!v.ok) e.to = v.error;
  }
  if (f.enabled && f.from.trim() === '') e.from = 'Informe o remetente.';
  if (f.mode === 'real') {
    if (!l.granted) e.permission = 'Conceda a permissão para api.resend.com antes de salvar o modo real.';
    if (key === '' && !l.apiKeySet) e.apiKey = 'Informe a chave de API (somente envio).';
  }
  if (Object.keys(e).length > 0) return err(e);
  const email: SettingsInput['email'] = { mode: f.mode, enabled: f.enabled, to, from: f.from.trim() };
  if (key !== '') email.apiKey = key;
  return ok({ intervalHours: l.intervalHours, email });
}

/** Remover chave: mantém o resto, desliga o envio e manda apiKey = null. */
export function removeKeyInput(intervalHours: number, c: { mode: 'teste' | 'real'; to: string; from: string }): SettingsInput {
  return { intervalHours, email: { mode: c.mode, enabled: false, to: c.to, from: c.from, apiKey: null } };
}

export function permissionText(granted: boolean): string {
  return granted ? 'Permissão concedida para api.resend.com.' : 'Permissão não concedida: o modo real não envia.';
}

export const HELP_TEXT =
  'Opcional. Os alertas sempre aparecem como notificação do navegador. Para também receber e-mail, use sua conta no Resend: ' +
  'o remetente precisa estar em um domínio verificado lá (onboarding@resend.dev só entrega ao e-mail da sua própria conta). ' +
  'Crie uma chave restrita a envio (sending access). A chave fica só neste navegador, nunca é exibida de novo, e o resultado ' +
  'significa aceito pelo provedor, não entregue. No modo teste nada é enviado.';
