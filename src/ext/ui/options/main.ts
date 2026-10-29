import { h, mount } from '../dom.ts';
import { renderAlertsView } from './alerts-view.ts';
import { renderCatalogView } from './catalog-view.ts';
import { renderHealthView } from './health-view.ts';
import { renderHistoryView } from './history-view.ts';
import { renderSettingsView } from './settings-view.ts';

type View = (panel: HTMLElement) => void | Promise<void>;
const TABS: { id: string; label: string; view: View }[] = [
  { id: 'alerts', label: 'Monitoramentos', view: renderAlertsView },
  { id: 'history', label: 'Histórico', view: renderHistoryView },
  { id: 'health', label: 'Saúde', view: renderHealthView },
  { id: 'settings', label: 'E-mail', view: renderSettingsView },
  { id: 'catalog', label: 'Catálogo', view: renderCatalogView },
];

const root = document.getElementById('app');
if (root) {
  const panel = h('section', { id: 'panel', role: 'tabpanel', tabindex: '0' });
  const n = TABS.length;
  const buttons = TABS.map((t, i) =>
    h('button', {
      role: 'tab', id: `tab-${t.id}`, type: 'button', 'aria-controls': 'panel',
      on: {
        click: () => select(i),
        keydown: (e) => {
          const k = (e as KeyboardEvent).key;
          const to = k === 'ArrowRight' ? (i + 1) % n : k === 'ArrowLeft' ? (i + n - 1) % n : k === 'Home' ? 0 : k === 'End' ? n - 1 : -1;
          if (to < 0) return;
          e.preventDefault();
          select(to, true);
        },
      },
    }, t.label));

  function select(i: number, focus = false): void {
    buttons.forEach((b, j) => {
      b.setAttribute('aria-selected', String(i === j));
      b.tabIndex = i === j ? 0 : -1;
    });
    if (focus) buttons[i]!.focus();
    panel.setAttribute('aria-labelledby', `tab-${TABS[i]!.id}`);
    try { history.replaceState(null, '', `#${TABS[i]!.id}`); } catch { /* sem URL: ignora */ }
    // Erro de view não derruba o painel.
    void Promise.resolve(TABS[i]!.view(panel)).catch(() => mount(panel, h('p', { role: 'alert' }, 'Erro ao carregar esta tela.')));
  }

  mount(root,
    h('h1', null, 'Vans Price Watcher'),
    h('div', { role: 'tablist', class: 'tabs', 'aria-label': 'Seções' }, buttons),
    panel);
  select(Math.max(0, TABS.findIndex((t) => `#${t.id}` === location.hash)));
}
document.documentElement.dataset.ready = '1';
