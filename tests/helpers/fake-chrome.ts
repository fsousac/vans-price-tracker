// API `chrome` falsa (subconjunto MV3) para node:test. Lê as permissões do manifest real:
// namespace sem permissão declarada LANÇA ao ser acessado (no Chrome ele seria `undefined`).
import { readFileSync } from 'node:fs';
import { ManualClock } from './clock.ts';

export const MANIFEST_PATH = new URL('../../extension/manifest.json', import.meta.url);

export type Manifest = {
  permissions?: string[];
  host_permissions?: string[];
  optional_permissions?: string[];
  optional_host_permissions?: string[];
};
export type Sender = { id?: string; url?: string };
export type Alarm = { name: string; scheduledTime: number; periodInMinutes?: number };
export type Tab = { id: number; url?: string; active?: boolean; windowId?: number };
type Perms = { permissions?: string[]; origins?: string[] };
type AlarmInfo = { when?: number; delayInMinutes?: number; periodInMinutes?: number };
type Fn = (...a: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

export class FakeEvent<F extends Fn> {
  readonly listeners: F[] = [];
  addListener = (f: F): void => void this.listeners.push(f);
  removeListener = (f: F): void => void this.listeners.splice(0, this.listeners.length, ...this.listeners.filter((x) => x !== f));
  hasListener = (f: F): boolean => this.listeners.includes(f);
  emit(...a: Parameters<F>): ReturnType<F>[] {
    return [...this.listeners].map((f) => f(...a));
  }
}

// `https://x/*` casa `https://x/...`
const matchOrigin = (pattern: string, url: string): boolean =>
  url.startsWith(pattern.endsWith('*') ? pattern.slice(0, -1) : pattern);

export function installFakeChrome(
  opts: { manifest?: Manifest; clock?: ManualClock; extensionId?: string; grantPermissions?: boolean | ((p: Perms) => boolean) } = {},
) {
  const manifest: Manifest = opts.manifest ?? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const clock = opts.clock ?? new ManualClock('2026-01-01T00:00:00Z');
  const id = opts.extensionId ?? 'abcdefghijklmnopabcdefghijklmnop';
  const base = `chrome-extension://${id}/`;
  const declared = new Set(manifest.permissions ?? []);
  const granted: Required<Perms> = { permissions: [...declared], origins: [...(manifest.host_permissions ?? [])] };
  const optional = { permissions: manifest.optional_permissions ?? [], origins: manifest.optional_host_permissions ?? [] };

  const h = {
    clock,
    sender: { id, url: `${base}popup.html` } as Sender, // remetente padrão de runtime.sendMessage
    grantPermissions: (opts.grantPermissions ?? true) as boolean | ((p: Perms) => boolean), // resposta programável
    notificationCalls: [] as { id: string; options: Record<string, unknown> }[],
    tabs: [] as Tab[],
    openedOptionsPage: 0,
    nextTabId: 1,
  };
  const notifications = new Map<string, Record<string, unknown>>();
  const alarms = new Map<string, Alarm>();

  const onMessage = new FakeEvent<(m: unknown, s: Sender, r: (x?: unknown) => void) => boolean | void>();
  const onInstalled = new FakeEvent<(d: { reason: string }) => void>();
  const onStartup = new FakeEvent<() => void>();
  const onAlarm = new FakeEvent<(a: Alarm) => void>();
  const onClicked = new FakeEvent<(id: string) => void>();
  const onPermRemoved = new FakeEvent<(p: Perms) => void>();

  // Chrome: listener devolve true => resposta assíncrona; senão só vale sendResponse síncrono.
  const dispatch = (message: unknown, sender: Sender): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let done = false;
      const respond = (x?: unknown) => {
        if (!done) {
          done = true;
          resolve(x);
        }
      };
      let async = false;
      try {
        for (const l of [...onMessage.listeners]) if (l(structuredClone(message), sender, respond) === true) async = true;
      } catch (e) {
        return reject(e);
      }
      if (!async && !done) resolve(undefined);
    });

  const scheduleTime = (i: AlarmInfo): number =>
    i.when ?? clock.now().getTime() + (i.delayInMinutes ?? i.periodInMinutes ?? 0) * 60_000;

  const tabVisible = (t: Tab): boolean =>
    declared.has('tabs') ||
    (declared.has('activeTab') && t.active === true) ||
    (t.url !== undefined && granted.origins.some((o) => matchOrigin(o, t.url!)));

  const ns: Record<string, unknown> = {
    runtime: {
      id,
      lastError: undefined,
      getURL: (p: string) => base + p.replace(/^\//, ''),
      onMessage,
      onInstalled,
      onStartup,
      sendMessage: (m: unknown) => dispatch(m, h.sender),
      openOptionsPage: async () => void h.openedOptionsPage++,
    },
    permissions: {
      onRemoved: onPermRemoved,
      contains: async (p: Perms) =>
        (p.permissions ?? []).every((x) => granted.permissions.includes(x)) && (p.origins ?? []).every((x) => granted.origins.includes(x)),
      request: async (p: Perms) => {
        const bad = [
          ...(p.permissions ?? []).filter((x) => !optional.permissions.includes(x)),
          ...(p.origins ?? []).filter((x) => !optional.origins.includes(x)),
        ];
        if (bad.length) throw new Error(`permissions.request: ${bad.join(', ')} não declarado(s) como opcional no manifest`);
        const ok = typeof h.grantPermissions === 'function' ? h.grantPermissions(p) : h.grantPermissions;
        if (ok) {
          granted.permissions.push(...(p.permissions ?? []));
          granted.origins.push(...(p.origins ?? []));
        }
        return ok;
      },
      remove: async (p: Perms) => {
        const had = (p.permissions ?? []).concat(p.origins ?? []).some((x) => granted.permissions.includes(x) || granted.origins.includes(x));
        api.revoke(p);
        return had;
      },
    },
    alarms: {
      onAlarm,
      create: async (a: string | AlarmInfo, i?: AlarmInfo) => {
        const [name, info] = typeof a === 'string' ? [a, i ?? {}] : ['', a];
        alarms.set(name, { name, scheduledTime: scheduleTime(info), ...(info.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}) });
      },
      get: async (name = '') => alarms.get(name),
      getAll: async () => [...alarms.values()],
      clear: async (name = '') => alarms.delete(name),
      clearAll: async () => {
        const had = alarms.size > 0;
        alarms.clear();
        return had;
      },
    },
    notifications: {
      onClicked,
      create: async (a: string | Record<string, unknown>, o?: Record<string, unknown>) => {
        const [nid, options] = typeof a === 'string' ? [a, o ?? {}] : [`n${h.notificationCalls.length + 1}`, a];
        for (const k of ['type', 'title', 'message', 'iconUrl'])
          if (typeof options[k] !== 'string' || options[k] === '') throw new Error(`notifications.create: "${k}" obrigatório`);
        notifications.set(nid, options);
        h.notificationCalls.push({ id: nid, options: structuredClone(options) });
        return nid;
      },
      clear: async (nid: string) => notifications.delete(nid),
      getAll: async () => Object.fromEntries(notifications),
    },
    tabs: {
      query: async (q: { active?: boolean } = {}) =>
        h.tabs
          .filter((t) => q.active === undefined || !!t.active === q.active)
          .map((t) => (tabVisible(t) ? { ...t } : { id: t.id, active: t.active, windowId: t.windowId })),
      create: async (p: { url?: string; active?: boolean }) => {
        const t: Tab = { id: h.nextTabId++, active: p.active ?? true, ...(p.url ? { url: p.url } : {}) };
        h.tabs.push(t);
        return { ...t };
      },
    },
  };

  const g = globalThis as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(g, 'chrome');
  const chrome: Record<string, unknown> = {};
  const needs: Record<string, string | null> = { runtime: null, permissions: null, tabs: null, alarms: 'alarms', notifications: 'notifications' };
  for (const [name, perm] of Object.entries(needs)) {
    if (perm === null || declared.has(perm)) chrome[name] = ns[name];
    else
      Object.defineProperty(chrome, name, {
        get() {
          throw new Error(`chrome.${name}: permissão "${perm}" não declarada no manifest`);
        },
        enumerable: true,
      });
  }
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true });

  const api = {
    /** runtime.sendMessage com remetente arbitrário (ex.: página web falsa, outra extensão). */
    sendFrom: (message: unknown, sender: Sender) => dispatch(message, sender),
    /** Dispara o alarme agora (relógio manual: ignora o horário); periódico é reagendado, único é removido. */
    fire: async (name: string) => {
      const a = alarms.get(name);
      if (!a) throw new Error(`alarme inexistente: ${name}`);
      if (a.periodInMinutes) a.scheduledTime = clock.now().getTime() + a.periodInMinutes * 60_000;
      else alarms.delete(name);
      await Promise.all(onAlarm.emit({ ...a }));
    },
    /** Avança o relógio manual e dispara, em ordem, os alarmes vencidos. */
    advance: async (ms: number) => {
      const target = clock.now().getTime() + ms;
      for (;;) {
        const next = [...alarms.values()].filter((a) => a.scheduledTime <= target).sort((a, b) => a.scheduledTime - b.scheduledTime)[0];
        if (!next) break;
        await clock.advance(Math.max(0, next.scheduledTime - clock.now().getTime()));
        await api.fire(next.name);
      }
      await clock.advance(target - clock.now().getTime());
    },
    click: (nid: string) => {
      if (!notifications.has(nid)) throw new Error(`notificação inexistente: ${nid}`);
      return Promise.all(onClicked.emit(nid));
    },
    /** Revoga permissões (usuário ou API) e dispara permissions.onRemoved. */
    revoke: (p: Perms) => {
      const removed = {
        permissions: (p.permissions ?? []).filter((x) => granted.permissions.includes(x)),
        origins: (p.origins ?? []).filter((x) => granted.origins.includes(x)),
      };
      granted.permissions = granted.permissions.filter((x) => !removed.permissions.includes(x));
      granted.origins = granted.origins.filter((x) => !removed.origins.includes(x));
      if (removed.permissions.length || removed.origins.length) onPermRemoved.emit(removed);
    },
    emitInstalled: (reason = 'install') => Promise.all(onInstalled.emit({ reason })),
    emitStartup: () => Promise.all(onStartup.emit()),
    uninstall: () => {
      if (had) Object.defineProperty(g, 'chrome', had);
      else delete g.chrome;
    },
  };
  return Object.assign(h, api, { chrome, granted, onMessage, onInstalled, onStartup, onAlarm, onClicked, onPermRemoved });
}
export type FakeChrome = ReturnType<typeof installFakeChrome>;
