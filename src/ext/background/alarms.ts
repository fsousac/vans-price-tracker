// Alarmes do SW (extension-architecture.md seções 4-5). Sem estado de módulo: cada handler pede os serviços.
import { TICK_MS } from '../../app/tick.ts';
import type { Services } from './compose.ts';

export type GetServices = () => Promise<Services>;
export type AlarmName = 'tick' | 'resume' | 'outbox';

export const RESEND_ORIGIN = 'https://api.resend.com/*';
const MIN_ALARM_MS = 30_000; // piso do Chrome para alarmes de extensão

/** Idempotente: recria o `tick` se sumiu (atualização/reinício do navegador). Não reagenda o existente. */
export async function ensureAlarms(): Promise<void> {
  if (await chrome.alarms.get('tick')) return;
  await chrome.alarms.create('tick', { periodInMinutes: TICK_MS / 60_000, delayInMinutes: 1 });
}

/** Porta `schedule(name, when)` do round/notifications: when = null remove o alarme único. */
export async function schedule(name: 'resume' | 'outbox', when: string | null, nowMs: number): Promise<void> {
  if (when === null) {
    await chrome.alarms.clear(name);
    return;
  }
  await chrome.alarms.create(name, { when: Math.max(Date.parse(when), nowMs + MIN_ALARM_MS) });
}

export async function handleAlarm(name: string, get: GetServices): Promise<void> {
  const s = await get();
  if (s.degraded) return; // somente leitura: nenhuma rodada, nenhuma escrita
  try {
    if (name === 'tick') await s.tick();
    else if (name === 'resume') await s.resume();
    else if (name === 'outbox') await s.drain();
  } catch {
    s.log.error('alarme_falhou'); // sem mensagem/stack; a lease vence e o próximo tick retoma
  }
}

/** onInstalled/onStartup: recria alarmes; em `update` abre a base cedo para migrar (falha => degradado). */
export async function handleLifecycle(get: GetServices, reason?: string): Promise<void> {
  await ensureAlarms();
  if (reason === 'update') await get();
}

/** permissions.onRemoved: sem o host do provedor, o e-mail é desligado (configuração preservada). */
export async function handlePermissionRemoved(origins: string[] | undefined, get: GetServices): Promise<void> {
  if (!origins?.includes(RESEND_ORIGIN)) return;
  const s = await get();
  if (!s.degraded) await s.emailPermissionRemoved();
}
