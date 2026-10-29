import { h, mount, type Child } from '../dom.ts';
import { send } from '../client.ts';
import { badge, brl } from '../format.ts';
import { defaultVariant, popupState, sizeOptions, tabUrlToRequestUrl, validateForm, type Inspect } from './model.ts';

const root = document.getElementById('app');

const openDashboard = (): void => void chrome.runtime.openOptionsPage();
const dashButton = (label = 'Abrir painel'): HTMLElement => h('button', { type: 'button', on: { click: openDashboard } }, label);
const note = (text: string, extra: Child = null): HTMLElement => h('div', { class: 'note' }, h('p', null, text), extra);

async function init(): Promise<void> {
  if (!root) return;
  mount(root, h('p', { class: 'muted' }, 'Lendo o produto…'));
  let url: string | undefined;
  try {
    url = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url;
  } catch {
    url = undefined;
  }
  const u = tabUrlToRequestUrl(url);
  const resp = u.ok ? await send({ type: 'tab.inspect', url: u.value }) : null;
  const s = popupState(url, resp);
  const title = h('h1', null, 'Vans Price Watcher');
  switch (s.kind) {
    case 'nao_produto':
      return mount(root, title, note(s.message, dashButton()));
    case 'circuito':
      return mount(root, title, h('p', null, h('span', { class: 'badge bad' }, badge('aberto').text)), note(s.message, dashButton('Ver saúde no painel')));
    case 'erro':
      return mount(root, title, h('div', { class: 'banner', role: 'alert' }, s.message), h('p', null, h('button', { type: 'button', on: { click: () => void init() } }, 'Tentar de novo'), ' ', dashButton()));
    case 'produto':
      return renderProduct(root, title, s.inspect);
  }
}

function renderProduct(host: HTMLElement, title: HTMLElement, i: Inspect): void {
  const opts = sizeOptions(i);
  const monitored = i.monitored.length > 0
    ? h('div', { class: 'card' }, h('h2', null, 'Já monitorado'),
        h('ul', { class: 'plain' }, i.monitored.map((m) => {
          const v = i.variants.find((x) => x.variantCode === m.variantCode);
          return h('li', null, `Tam. ${v?.size ?? '?'}: alvo ${brl(m.targetCents)} `, h('span', { class: `badge ${badge(m.state).tone}` }, badge(m.state).text));
        })),
        dashButton('Gerenciar no painel'))
    : null;

  const msg = h('div', { id: 'msg', role: 'status' });
  const sel = h('select', { id: 'variant', 'aria-describedby': 'variant-err' }, opts.map((o) => h('option', { value: o.variantCode }, o.label))) as HTMLSelectElement;
  const target = h('input', { id: 'target', inputmode: 'decimal', autocomplete: 'off', placeholder: '379,99', 'aria-describedby': 'target-err' }) as HTMLInputElement;
  const margin = h('input', { id: 'margin', inputmode: 'decimal', autocomplete: 'off', placeholder: '3', 'aria-describedby': 'margin-hint margin-err' }) as HTMLInputElement;
  const errEls = { variant: h('p', { id: 'variant-err', class: 'field-error' }), target: h('p', { id: 'target-err', class: 'field-error' }), margin: h('p', { id: 'margin-err', class: 'field-error' }) };
  const inputs = { variant: sel, target, margin };
  const save = h('button', { type: 'submit', class: 'primary' }, 'Monitorar') as HTMLButtonElement;
  sel.value = defaultVariant(i);
  if (opts.every((o) => o.monitored)) save.disabled = true;

  const form = h('form', { novalidate: true, on: { submit: (e) => { e.preventDefault(); void submit(); } } },
    h('label', { for: 'variant' }, 'Tamanho'), sel, errEls.variant,
    h('label', { for: 'target' }, 'Preço-alvo (R$)'), target, errEls.target,
    h('label', { for: 'margin' }, 'Margem (%)'), margin,
    h('p', { id: 'margin-hint', class: 'muted' }, 'Vazio = 3%. Evita alertas por variações pequenas.'), errEls.margin,
    h('p', null, save));

  async function submit(): Promise<void> {
    const r = validateForm(i, { variantCode: sel.value, target: target.value, margin: margin.value });
    for (const k of ['variant', 'target', 'margin'] as const) {
      const e = r.errors[k];
      errEls[k].textContent = e ?? '';
      if (e) inputs[k].setAttribute('aria-invalid', 'true'); else inputs[k].removeAttribute('aria-invalid');
    }
    const first = (['variant', 'target', 'margin'] as const).find((k) => r.errors[k]);
    if (first) { inputs[first].focus(); return; }
    if (!r.request) return;
    save.disabled = true;
    const resp = await send(r.request);
    if (resp.ok) {
      mount(msg, h('div', { class: 'banner ok' }, 'Monitoramento criado.', r.warning ? ` ${r.warning}` : ''), h('p', null, dashButton()));
      return;
    }
    save.disabled = false;
    mount(msg, h('div', { class: 'banner', role: 'alert' }, resp.error.message));
  }

  mount(host, title,
    h('h2', { class: 'name' }, i.name),
    h('p', { class: 'muted' }, 'Preço atual por tamanho (lido da loja):'),
    h('ul', { class: 'plain sizes' }, opts.map((o, n) => h('li', null,
      h('span', null, `Tam. ${i.variants[n]!.size} — ${brl(i.variants[n]!.priceCents)} `),
      h('span', { class: `badge ${o.available ? 'ok' : 'warn'}` }, o.available ? 'Disponível' : 'Indisponível')))),
    monitored, form, msg);
}

void init();
