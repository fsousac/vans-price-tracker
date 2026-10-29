import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { h, mount } from '../../src/ext/ui/dom.ts';

// Mini documento falso: só o que dom.ts usa.
class N {
  children: N[] = [];
  text: string;
  constructor(text = '') {
    this.text = text;
  }
  get firstChild(): N | null {
    return this.children[0] ?? null;
  }
  appendChild(c: N): N {
    this.children.push(c);
    return c;
  }
  removeChild(c: N): N {
    this.children.splice(this.children.indexOf(c), 1);
    return c;
  }
}
class E extends N {
  attrs: Record<string, string> = {};
  listeners: Record<string, unknown> = {};
  tag: string;
  constructor(tag: string) {
    super();
    this.tag = tag;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(ev: string, fn: unknown): void {
    this.listeners[ev] = fn;
  }
}
const attrs = (n: E): string => Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
const html = (n: N): string => (n instanceof E ? `<${n.tag}${attrs(n)}>${n.children.map(html).join('')}</${n.tag}>` : n.text);

const g = globalThis as Record<string, unknown>;
let had: unknown;
beforeEach(() => {
  had = g.document;
  g.document = { createElement: (t: string) => new E(t), createTextNode: (s: string) => new N(s) };
});
afterEach(() => void (g.document = had));

test('S7 dados hostis viram nó de texto, nunca marcação', () => {
  const evil = '<img src=x onerror=alert(1)>"><script>1</script>';
  const el = h('p', { class: 'a' }, evil, 7, null, false, [h('b', null, 'x')]) as unknown as E;
  assert.equal(el.children.length, 3);
  assert.ok(!(el.children[0] instanceof E));
  assert.equal(el.children[0]!.text, evil);
  assert.equal(el.children[1]!.text, '7');
  assert.equal(html(el), `<p class="a">${evil}7<b>x</b></p>`);
});

test('S7 atributos fora da lista, on* e style são recusados', () => {
  for (const k of ['onclick', 'onerror', 'style', 'srcdoc', 'formaction', 'src'])
    assert.throws(() => h('div', { [k]: 'x' }), /atributo não permitido/, k);
});

test('S7 tags perigosas e nomes inválidos são recusados', () => {
  for (const t of ['script', 'style', 'iframe', 'object', 'link', 'img onerror=1', 'A', ''])
    assert.throws(() => h(t), /tag não permitida/, t);
});

test('S7 href só https', () => {
  const ok = h('a', { href: 'https://www.vans.com.br/p/1' }) as unknown as E;
  assert.equal(ok.attrs.href, 'https://www.vans.com.br/p/1');
  for (const u of ['javascript:alert(1)', 'data:text/html,x', 'http://x', '//x', 'https://a b'])
    assert.throws(() => h('a', { href: u }), /href/, u);
});

test('RNF-ACC-01 aria-*, data-*, booleanos e eventos', () => {
  const fn = () => {};
  const el = h('button', { 'aria-selected': 'true', 'data-id': 3, disabled: true, hidden: false, tabindex: undefined, on: { click: fn } }) as unknown as E;
  assert.deepEqual(el.attrs, { 'aria-selected': 'true', 'data-id': '3', disabled: '' });
  assert.equal(el.listeners.click, fn);
});

test('mount substitui o conteúdo', () => {
  const root = new E('main');
  root.appendChild(new N('velho'));
  mount(root as unknown as Element, 'novo', h('i', null, 'y'));
  assert.equal(html(root), '<main>novo<i>y</i></main>');
});

test('S7 fontes da UI não usam APIs de marcação/eval (varredura)', () => {
  const files = ['dom', 'format', 'client', 'options/main', 'options/alerts-view', 'options/history-view', 'options/health-view', 'options/settings-view', 'options/catalog-view'];
  for (const f of files) {
    const src = readFileSync(new URL(`../../src/ext/ui/${f}.ts`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, f);
  }
});
