import { send } from '../client.ts';
import { h, mount } from '../dom.ts';
import { buildHistory, type HistoryDto } from './history-model.ts';

interface AlertOpt { id: number; productName?: string; size?: string }

/** Aba Histórico: escolhe o alerta e mostra série (desc), mín/máx confirmadas e notificações. */
export async function renderHistoryView(panel: HTMLElement): Promise<void> {
  mount(panel, h('h2', null, 'Histórico'), h('p', { role: 'status' }, 'Carregando…'));
  const list = await send<AlertOpt[]>({ type: 'alerts.list' });
  if (!list.ok) return mount(panel, h('h2', null, 'Histórico'), h('p', { role: 'alert' }, list.error.message));
  if (list.data.length === 0) return mount(panel, h('h2', null, 'Histórico'), h('p', null, 'Nenhum monitoramento ainda.'));

  const out = h('div', { 'aria-live': 'polite' });
  const select = h('select', { id: 'hist-alert', on: { change: () => void load() } },
    list.data.map((a) => h('option', { value: a.id }, `${a.productName ?? 'Produto'}${a.size ? ` — tam. ${a.size}` : ''}`))) as HTMLSelectElement;
  let page = 0;
  async function load(p = 0): Promise<void> {
    page = p;
    mount(out, h('p', { role: 'status' }, 'Carregando…'));
    const r = await send<HistoryDto>({ type: 'history.get', alertId: Number(select.value), page });
    if (!r.ok) return mount(out, h('p', { role: 'alert' }, r.error.message));
    const v = buildHistory(r.data);
    if (v.empty) return mount(out, h('p', null, 'Sem leituras ainda.'));
    mount(out,
      h('p', null, `Menor preço confirmado: ${v.min} · Maior: ${v.max} (${v.confirmedCount} leituras confirmadas nesta página)`),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('caption', null, 'Leituras, da mais recente para a mais antiga'),
        h('thead', null, h('tr', null, ['Quando (Brasília)', 'De', 'Por', 'Desconto', 'Estoque', 'Fonte', 'Situação'].map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', null, v.rows.map((o) => h('tr', null,
          h('td', null, o.when), h('td', null, o.original), h('td', null, o.current), h('td', null, o.discount),
          h('td', null, o.available), h('td', null, o.source),
          h('td', null, o.confirmed ? 'Confirmada' : h('span', { class: 'badge warn' }, o.note))))))),
      h('div', { class: 'row' },
        h('button', { type: 'button', disabled: page === 0, on: { click: () => void load(page - 1) } }, 'Mais recentes'),
        h('button', { type: 'button', disabled: !r.data.hasMore, on: { click: () => void load(page + 1) } }, 'Mais antigas')),
      h('h3', null, 'Notificações'),
      v.notifs.length === 0 ? h('p', null, 'Nenhuma notificação para este monitoramento.')
        : h('ul', null, v.notifs.map((n) => h('li', null, `${n.when} — ${n.kind}: `,
          n.channels.map((c) => [h('span', { class: `badge ${c.tone}` }, c.label), ' '])))));
  }
  mount(panel, h('h2', null, 'Histórico'), h('label', { for: 'hist-alert' }, 'Monitoramento '), select, out);
  await load();
}
