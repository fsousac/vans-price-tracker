import { h, mount } from '../dom.ts';
import { send } from '../client.ts';
import type { Request } from '../../messages.ts';
import { BROWSER_BANNER, EMPTY, confirmDelete, parseAlertsList, toCards, type AlertCard, type Chip } from './alerts-model.ts';

const chip = (c: Chip, label: string) => h('span', { class: `badge ${c.tone}` }, h('span', { class: 'sr-only' }, `${label}: `), c.text);

export async function renderAlertsView(panel: HTMLElement): Promise<void> {
  const status = h('p', { role: 'status', 'aria-live': 'polite' });
  const act = async (req: Request) => {
    const r = await send(req);
    if (r.ok) return renderAlertsView(panel);
    status.textContent = r.error.message;
  };

  const r = await send({ type: 'alerts.list' });
  const list = r.ok ? parseAlertsList(r.data) : null;
  const head = [h('h2', null, 'Monitoramentos'), h('p', { class: 'banner', role: 'note' }, BROWSER_BANNER)];
  if (!list) {
    mount(panel, head, h('p', { role: 'alert' }, r.ok ? 'Resposta inesperada da extensão.' : r.error.message));
    return;
  }
  const cards = toCards(list, new Date());
  mount(panel, head, status,
    cards.length === 0
      ? h('div', { class: 'empty' }, h('h3', null, EMPTY.title), h('p', null, EMPTY.body))
      : h('ul', { class: 'cards' }, cards.map((c) => card(c, act))));
}

function card(c: AlertCard, act: (r: Request) => Promise<void>): HTMLElement {
  const tid = h('input', { id: `t${c.id}`, type: 'text', inputmode: 'decimal', value: c.editTarget, autocomplete: 'off' }) as HTMLInputElement;
  const mid = h('input', { id: `m${c.id}`, type: 'text', inputmode: 'decimal', value: c.editMargin, autocomplete: 'off' }) as HTMLInputElement;
  const form = h('form', {
    hidden: true, class: 'edit',
    on: { submit: (e) => { e.preventDefault(); void act({ type: 'alert.update', id: c.id, target: tid.value, margin: mid.value }); } },
  },
  h('label', { for: tid.id }, 'Preço-alvo (R$)'), tid,
  h('label', { for: mid.id }, 'Margem (%)'), mid,
  h('button', { type: 'submit' }, 'Salvar'),
  h('button', { type: 'button', on: { click: () => { form.hidden = true; } } }, 'Cancelar'));
  return h('li', { class: 'card' },
    h('h3', null, c.title, ' ', h('small', null, `tamanho ${c.size}`)),
    h('p', { class: 'chips' }, chip(c.state, 'Estado'), chip(c.band, 'Faixa'), chip(c.fresh, 'Frescor'), chip(c.availability, 'Disponibilidade')),
    h('dl', null,
      h('dt', null, 'Preço atual'), h('dd', null, c.price),
      h('dt', null, 'Alvo'), h('dd', null, c.target),
      h('dt', null, 'Margem'), h('dd', null, c.margin),
      h('dt', null, 'Última leitura'), h('dd', null, c.lastRead)),
    h('div', { class: 'actions' },
      h('button', { type: 'button', on: { click: () => void act({ type: c.toggle.action, id: c.id }) } }, c.toggle.label),
      h('button', { type: 'button', on: { click: () => { form.hidden = !form.hidden; } } }, 'Editar'),
      h('button', { type: 'button', class: 'danger', on: { click: () => { if (confirm(confirmDelete(c))) void act({ type: 'alert.delete', id: c.id }); } } }, 'Excluir')),
    form);
}
