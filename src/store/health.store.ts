import type { IsoUtc } from '../shared/types.ts';
import type { Db } from './db.ts';

export interface LastRun {
  status: string;
  trigger: string;
  startedAt: IsoUtc;
  finishedAt: IsoUtc;
  itemsOk: number;
  itemsFailed: number;
}

// Exceção de fronteira (como T28): consultas SOMENTE LEITURA agregando stores de outros módulos. Nunca grava.
export interface HealthReadStore {
  lastFinishedRun(): Promise<LastRun | null>;
  activeAlertCount(): Promise<number>;
  activeAlertLastConfirmed(): Promise<(IsoUtc | null)[]>;
  runsByStatus(): Promise<Record<string, number>>;
  itemsSince(since: IsoUtc): Promise<{ ok: number; failedByClass: Record<string, number> }>;
  observationsBySource(): Promise<Record<string, number>>;
  notificationsByStatus(): Promise<Record<string, number>>;
  lastObservationAt(): Promise<IsoUtc | null>;
}

const tally = <T>(rows: T[], key: (r: T) => string): Record<string, number> => {
  const o: Record<string, number> = {};
  for (const r of rows) o[key(r)] = (o[key(r)] ?? 0) + 1;
  return o;
};

// ponytail: agregações por varredura (ok no teto de ~110 mil observações/ano); índice/contador se medir lento.
export function createHealthReadStore(db: Db): HealthReadStore {
  const all = <T>(store: string, o?: Parameters<Db['getAll']>[1]) => db.getAll<T>(store, o);
  return {
    async lastFinishedRun() {
      const runs = await all<LastRun & { kind: string; id: number }>('runs');
      const best = runs
        .filter((r) => r.kind === 'monitor' && r.finishedAt && r.status !== 'skipped')
        .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : a.finishedAt > b.finishedAt ? -1 : b.id - a.id))[0];
      return best
        ? { status: best.status, trigger: best.trigger, startedAt: best.startedAt, finishedAt: best.finishedAt, itemsOk: best.itemsOk, itemsFailed: best.itemsFailed }
        : null;
    },
    activeAlertCount: () => db.count('alerts', { index: 'status', range: { eq: 'ATIVO' } }),
    async activeAlertLastConfirmed() {
      const alerts = await all<{ variantCode: string }>('alerts', { index: 'status', range: { eq: 'ATIVO' } });
      return Promise.all(
        alerts.map(async (a) => {
          const obs = await all<{ observedAt: IsoUtc; confirmed: boolean }>('observations', {
            index: 'byVariant', range: { gte: [a.variantCode], lt: [a.variantCode, []] }, direction: 'prev',
          });
          return obs.find((o) => o.confirmed)?.observedAt ?? null;
        }),
      );
    },
    runsByStatus: async () => tally(await all<{ status: string }>('runs'), (r) => r.status),
    async itemsSince(since) {
      const items = (await all<{ outcome: string; failureClass?: string; finishedAt: IsoUtc }>('run_items')).filter(
        (i) => i.finishedAt >= since && ['ok', 'degradado', 'falha'].includes(i.outcome),
      );
      const failed = items.filter((i) => i.outcome === 'falha');
      return { ok: items.length - failed.length, failedByClass: tally(failed, (i) => i.failureClass ?? 'falha') };
    },
    observationsBySource: async () => tally(await all<{ source: string }>('observations'), (o) => o.source),
    // Campo `emailStatus` = o do índice `due` do esquema.
    notificationsByStatus: async () => tally(await all<{ emailStatus: string }>('notifications'), (n) => n.emailStatus),
    async lastObservationAt() {
      const obs = await all<{ observedAt: IsoUtc }>('observations');
      return obs.reduce<IsoUtc | null>((m, o) => (m === null || o.observedAt > m ? o.observedAt : m), null);
    },
  };
}
