import type { Db } from '../db/connection.ts';
import type { IsoUtc } from '../shared/types.ts';
import type { HealthEventRepo, HealthKind } from './ports.ts';

// RNF-OBS-03: no máximo 1 episódio aberto por (kind, subject); abrir de novo é idempotente (ux_health_open).
export function createHealthEventRepo(db: Db): HealthEventRepo {
  const find = db.prepare('SELECT id FROM health_events WHERE kind = ? AND subject = ? AND closed_at IS NULL');
  const insert = db.prepare('INSERT INTO health_events (kind, subject, detail, opened_at) VALUES (?, ?, ?, ?)');
  const closeOpen = db.prepare('UPDATE health_events SET closed_at = ? WHERE kind = ? AND subject = ? AND closed_at IS NULL');
  return {
    open(kind: HealthKind, subject: string, detail: string | null, now: IsoUtc) {
      const open = find.get(kind, subject) as { id: number } | undefined;
      if (open) return { id: open.id, created: false };
      const r = insert.run(kind, subject, detail, now);
      return { id: Number(r.lastInsertRowid), created: true };
    },
    close(kind: HealthKind, subject: string, now: IsoUtc): void {
      closeOpen.run(now, kind, subject);
    },
  };
}
