// Mini-DOM sem framework (extension-architecture.md seção 12). Só createElement/createTextNode/setAttribute
// de lista permitida: nunca innerHTML, atributos on* ou URLs não https. Texto de dados sempre vira nó de texto.

const ATTRS = new Set([
  'class', 'id', 'type', 'role', 'for', 'name', 'value', 'placeholder', 'title', 'lang', 'rel', 'href', 'target', 'colspan', 'scope',
  'min', 'max', 'step', 'maxlength', 'rows', 'inputmode', 'autocomplete', 'tabindex',
  'disabled', 'hidden', 'checked', 'selected', 'required', 'readonly', 'open', 'multiple',
]);
const SAFE_HREF = /^https:\/\/\S+$/;
const TAG = /^[a-z][a-z0-9]*$/;
const BLOCKED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base']);

export type Child = Node | string | number | null | undefined | false | Child[];
export interface Props {
  on?: Record<string, (e: Event) => void>;
  [attr: string]: unknown;
}

export function h(tag: string, props: Props | null = null, ...children: Child[]): HTMLElement {
  if (!TAG.test(tag) || BLOCKED_TAGS.has(tag)) throw new Error(`tag não permitida: ${tag}`);
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === 'on') {
      for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
    } else if (v === false || v === null || v === undefined) {
      continue;
    } else if (ATTRS.has(k) || k.startsWith('aria-') || k.startsWith('data-')) {
      if (k === 'href' && !SAFE_HREF.test(String(v))) throw new Error('href não permitido');
      el.setAttribute(k, v === true ? '' : String(v));
    } else {
      throw new Error(`atributo não permitido: ${k}`);
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/** Substitui o conteúdo de `root`. */
export function mount(root: Element, ...children: Child[]): void {
  while (root.firstChild) root.removeChild(root.firstChild);
  append(root, children);
}
