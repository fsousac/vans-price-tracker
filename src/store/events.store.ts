import type { HealthKind } from '../observability/ports.ts';
import type { IsoUtc } from '../shared/types.ts';
import type { Db } from './db.ts';
import type { HealthEventRepo } from './ports.ts';

interface Row { id?: number; kind: HealthKind; subject: string; detail: string | null; openedAt: IsoUtc; closedAt: IsoUtc | '' }

// RNF-OBS-03: 1 episódio aberto por (kind, subject). Aberto = closedAt '' (null não indexa).
export function createHealthEventStore(db: Db): HealthEventRepo {
  const openRange = (kind: HealthKind, subject: string) => ({ index: 'open', range: { eq: [kind, subject, ''] } });
  return {
    open: (kind, subject, detail, now) =>
      db.tx(async () => {
        const [cur] = await db.getAll<Row>('health_events', { ...openRange(kind, subject), limit: 1 });
        if (cur) return { id: cur.id!, created: false };
        const id = (await db.add('health_events', { kind, subject, detail, openedAt: now, closedAt: '' })) as number;
        return { id, created: true };
      }),
    close: (kind, subject, now) =>
      db.tx(async () => {
        for (const r of await db.getAll<Row>('health_events', openRange(kind, subject))) {
          await db.put('health_events', { ...r, closedAt: now });
        }
      }),
    listOpen: async () =>
      (await db.getAll<Row>('health_events', { index: 'open', range: { gte: [''], lt: [[]] } }))
        .filter((r) => r.closedAt === '')
        .sort((a, b) => a.id! - b.id!)
        .map((r) => ({ id: r.id!, kind: r.kind, subject: r.subject, detail: r.detail, openedAt: r.openedAt })),
  };
}
