import { send } from '../client.ts';
import { h, mount, type Child } from '../dom.ts';
import { buildHealth, type HealthDto } from './health-model.ts';

/** Aba Saúde: última rodada, circuito, frescor, orçamento 24 h, eventos abertos. */
export async function renderHealthView(panel: HTMLElement): Promise<void> {
  mount(panel, h('h2', null, 'Saúde'), h('p', { role: 'status' }, 'Carregando…'));
  const r = await send<HealthDto>({ type: 'health.get' });
  if (!r.ok) return mount(panel, h('h2', null, 'Saúde'), h('p', { role: 'alert' }, r.error.message));
  const v = buildHealth(r.data, new Date());
  const row = (k: string, ...val: Child[]) => h('div', { class: 'kv' }, h('dt', null, k), h('dd', null, ...val));
  const circuitTone = v.circuit.state === 'aberto' ? 'bad' : v.circuit.state === 'fechado' ? 'ok' : 'warn';
  mount(panel,
    h('h2', null, 'Saúde'),
    h('p', { class: 'banner' }, v.banner),
    h('dl', null,
      row('Última rodada', v.run
        ? [h('span', { class: `badge ${v.run.tone}` }, v.run.label), ` iniciada ${v.run.started}, fim ${v.run.finished}. ${v.run.counts}. ${v.run.note}`]
        : 'Nenhuma ainda'),
      row('Circuito', h('span', { class: `badge ${circuitTone}` }, v.circuit.text), ` ${v.circuit.reason}`),
      row('Frescor', `${v.fresh.fresco} atualizados, ${v.fresh.defasado} defasados, ${v.fresh.sem_dados} sem dados${v.stale ? ' (atenção)' : ''}`),
      row('Orçamento (24 h)', h('progress', { max: 100, value: v.budget.percent, 'aria-label': 'Orçamento usado' }), ` ${v.budget.text}${v.budget.exhausted ? ' (esgotado)' : ''}`),
      row('E-mail', v.email)),
    h('h3', null, 'Eventos abertos'),
    v.events.length === 0 ? h('p', null, 'Nenhum.') : h('ul', null, v.events.map((e) => h('li', null, `${e.kind} (${e.subject}) desde ${e.since}`))));
}
