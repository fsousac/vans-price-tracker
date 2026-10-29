import { send } from '../client.ts';
import { h, mount } from '../dom.ts';
import { brl, formatSp } from '../format.ts';
import { checkUrl, errorText, parseInspect, parseSearch, refreshState, storeUrl, type Inspected } from './catalog-model.ts';

export async function renderCatalogView(panel: HTMLElement): Promise<void> {
  const status = h('p', { role: 'status' });
  const list = h('ul', { class: 'list' });
  const refreshInfo = h('p', null);
  const urlBox = h('div', null);
  const refreshBtn = h('button', { type: 'button', on: { click: () => void refresh() } }, 'Atualizar catálogo') as HTMLButtonElement;
  const q = h('input', { type: 'search', id: 'cat-q', maxlength: 100, autocomplete: 'off', on: { input: () => void search() } }) as HTMLInputElement;
  const urlInput = h('input', { type: 'url', id: 'u-url', maxlength: 2048, required: true, placeholder: 'https://www.vans.com.br/.../p/CÓDIGO' }) as HTMLInputElement;
  let refreshedAt: string | null = null;
  let seq = 0;

  const say = (m: string): void => mount(status, m);

  async function search(): Promise<void> {
    const my = ++seq;
    const r = await send({ type: 'catalog.search', q: q.value });
    if (my !== seq) return; // resposta velha
    if (!r.ok) return say(errorText(r.error));
    const { rows, refreshedAt: at } = parseSearch(r.data);
    refreshedAt = at;
    const st = refreshState(at, Date.now());
    refreshBtn.disabled = !st.allowed;
    mount(refreshInfo, at ? `Última atualização: ${formatSp(at)}.` : 'Catálogo ainda não carregado.',
      st.nextAt ? ` Nova atualização a partir de ${formatSp(st.nextAt)}.` : '');
    say(rows.length ? `${rows.length} produto(s).` : at ? 'Nenhum produto encontrado.' : 'Atualize o catálogo para listar produtos.');
    mount(list, rows.map((row) => {
      const href = storeUrl(row.code, row.slug);
      return h('li', null, h('strong', null, row.name), ' ', brl(row.priceCents), ' (preço de listagem) ',
        href && h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir na loja'));
    }));
  }

  async function refresh(): Promise<void> {
    if (!refreshState(refreshedAt, Date.now()).allowed) return;
    refreshBtn.disabled = true;
    say('Atualizando o catálogo…');
    const r = await send({ type: 'catalog.refresh' });
    const msg = r.ok ? 'Catálogo atualizado.' : errorText(r.error);
    await search();
    say(msg);
  }

  async function inspect(e: Event): Promise<void> {
    e.preventDefault();
    const v = checkUrl(urlInput.value);
    if (!v.ok) return mount(urlBox, h('p', { role: 'alert' }, v.message)); // zero rede
    mount(urlBox, h('p', { role: 'status' }, 'Lendo o produto…'));
    const r = await send({ type: 'tab.inspect', url: urlInput.value });
    if (!r.ok) return mount(urlBox, h('p', { role: 'alert' }, errorText(r.error)));
    const p = parseInspect(r.data);
    mount(urlBox, p.ok ? createForm(p.value) : h('p', { role: 'alert' }, p.message));
  }

  function createForm(p: Inspected): HTMLElement {
    const size = h('select', { id: 'u-size' }, p.variants.map((v) =>
      h('option', { value: v.code }, `${v.size}${v.available ? '' : ' (indisponível)'}`))) as HTMLSelectElement;
    const target = h('input', { id: 'u-target', inputmode: 'decimal', required: true, placeholder: '299,90' }) as HTMLInputElement;
    const margin = h('input', { id: 'u-margin', inputmode: 'decimal', value: '3' }) as HTMLInputElement;
    const msg = h('p', { role: 'status' });
    return h('form', {
      on: {
        submit: (e) => {
          e.preventDefault();
          void send({ type: 'alert.create', variantCode: size.value, target: target.value, margin: margin.value })
            .then((r) => mount(msg, r.ok ? 'Monitoramento criado.' : errorText(r.error)));
        },
      },
    },
    h('h3', null, p.name),
    h('p', null, h('label', { for: 'u-size' }, 'Tamanho '), size),
    h('p', null, h('label', { for: 'u-target' }, 'Preço-alvo (R$) '), target),
    h('p', null, h('label', { for: 'u-margin' }, 'Margem (%) '), margin),
    h('button', { type: 'submit' }, 'Monitorar'), msg);
  }

  mount(panel,
    h('h2', null, 'Catálogo'),
    h('p', null, h('label', { for: 'cat-q' }, 'Buscar por nome '), q),
    refreshInfo, h('p', null, refreshBtn), status, list,
    h('h3', null, 'Cadastrar por link'),
    h('form', { on: { submit: (e) => void inspect(e) } }, h('label', { for: 'u-url' }, 'Link do produto '), urlInput, ' ',
      h('button', { type: 'submit' }, 'Ler produto')),
    urlBox);
  await search();
}
