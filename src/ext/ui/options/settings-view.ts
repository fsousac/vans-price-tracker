import { send } from '../client.ts';
import { h, mount } from '../dom.ts';
import {
  buildSettings, HELP_TEXT, permissionText, removeKeyInput, RESEND_ORIGIN, type EmailErrors, type EmailLoaded,
} from './settings-model.ts';

interface Pub {
  intervalHours: number;
  email: { mode: 'teste' | 'real'; enabled: boolean; to: string; from: string; apiKeySet: boolean };
}
type Draft = { mode?: 'teste' | 'real'; enabled?: boolean; to?: string; from?: string };

const hasPerm = async (): Promise<boolean> => {
  try {
    return await chrome.permissions.contains({ origins: [RESEND_ORIGIN] });
  } catch {
    return false;
  }
};

export async function renderSettingsView(panel: HTMLElement): Promise<void> {
  const res = await send<Pub>({ type: 'settings.get' });
  if (!res.ok) {
    mount(panel, h('h2', null, 'E-mail'), h('p', { role: 'alert' }, res.error.message));
    return;
  }
  let pub = res.data;
  let granted = await hasPerm();
  let status = '';
  let errors: EmailErrors = {};
  let draft: Draft = {};

  const val = (id: string): string => (panel.querySelector(`#${id}`) as HTMLInputElement).value;
  const read = (): Required<Draft> => ({
    mode: val('em-mode') === 'real' ? 'real' : 'teste',
    enabled: (panel.querySelector('#em-on') as HTMLInputElement).checked,
    to: val('em-to'),
    from: val('em-from'),
  });
  const keep = (): void => void (draft = read());
  const state = (): EmailLoaded => ({ intervalHours: pub.intervalHours, apiKeySet: pub.email.apiKeySet, granted });
  const refresh = async (): Promise<void> => {
    const r = await send<Pub>({ type: 'settings.get' });
    if (r.ok) pub = r.data;
  };

  const field = (id: string, label: string, props: Record<string, unknown>, err?: string) => [
    h('label', { for: id }, label),
    h('input', { id, ...props, 'aria-invalid': err ? 'true' : false, 'aria-describedby': err ? `${id}-err` : false }),
    err && h('p', { id: `${id}-err`, class: 'error' }, err),
  ];

  async function onSave(ev: Event): Promise<void> {
    ev.preventDefault();
    const f = { ...read(), apiKey: val('em-key') };
    draft = read();
    const built = buildSettings(f, state());
    if (!built.ok) {
      errors = built.error;
      status = 'Corrija os campos destacados.';
      return draw();
    }
    errors = {};
    const r = await send({ type: 'settings.set', settings: built.value });
    if (r.ok) {
      draft = {};
      await refresh();
      status = 'Configuração salva.';
    } else status = r.error.message;
    draw();
  }
  // chrome.permissions.request exige gesto do usuário: chamado direto no clique, antes de qualquer await.
  function onGrant(): void {
    keep();
    chrome.permissions.request({ origins: [RESEND_ORIGIN] }).then(
      (okay) => {
        granted = okay;
        status = okay ? permissionText(true) : 'Permissão negada.';
        draw();
      },
      () => {
        status = 'Não foi possível pedir a permissão.';
        draw();
      },
    );
  }
  async function onTest(): Promise<void> {
    keep();
    const r = await send<{ simulated?: boolean }>({ type: 'email.test' });
    status = !r.ok ? r.error.message
      : r.data?.simulated ? 'Teste simulado: nada foi enviado (modo teste).'
      : 'Teste aceito pelo provedor (isso não garante a entrega).';
    draw();
  }
  async function onRemove(): Promise<void> {
    const r = await send({ type: 'settings.set', settings: removeKeyInput(pub.intervalHours, pub.email) });
    if (r.ok) {
      draft = {};
      await refresh();
      status = 'Chave removida e envio de e-mail desligado.';
    } else status = r.error.message;
    draw();
  }

  function draw(): void {
    const e = pub.email;
    const mode = draft.mode ?? e.mode;
    mount(
      panel,
      h('h2', null, 'E-mail (opcional)'),
      h('p', null, HELP_TEXT),
      h('form', { on: { submit: (ev) => void onSave(ev) } },
        h('label', { for: 'em-mode' }, 'Modo'),
        h('select', { id: 'em-mode', on: { change: keep } },
          h('option', { value: 'teste', selected: mode === 'teste' }, 'Teste (não envia)'),
          h('option', { value: 'real', selected: mode === 'real' }, 'Real (Resend)')),
        h('label', { for: 'em-on' },
          h('input', { id: 'em-on', type: 'checkbox', checked: draft.enabled ?? e.enabled, on: { change: keep } }),
          ' Enviar alertas por e-mail'),
        ...field('em-to', 'Destinatário', { type: 'email', value: draft.to ?? e.to, autocomplete: 'email', maxlength: 254 }, errors.to),
        ...field('em-from', 'Remetente (domínio verificado)', { type: 'text', value: draft.from ?? e.from, maxlength: 254 }, errors.from),
        ...field('em-key', e.apiKeySet ? 'Chave de API (guardada; preencha só para trocar)' : 'Chave de API (somente envio)',
          { type: 'password', value: '', autocomplete: 'off', maxlength: 256 }, errors.apiKey),
        h('p', null, permissionText(granted), ' ',
          h('button', { type: 'button', on: { click: onGrant }, disabled: granted }, 'Conceder permissão')),
        errors.permission && h('p', { class: 'error' }, errors.permission),
        h('div', { class: 'actions' },
          h('button', { type: 'submit' }, 'Salvar'),
          h('button', { type: 'button', on: { click: () => void onTest() } }, 'Enviar e-mail de teste'),
          h('button', { type: 'button', disabled: !e.apiKeySet, on: { click: () => void onRemove() } }, 'Remover chave'))),
      h('p', { role: 'status', 'aria-live': 'polite' }, status),
    );
  }
  draw();
}
