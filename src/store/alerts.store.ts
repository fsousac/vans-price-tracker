import type { Db } from './db.ts';
import type { IsoUtc, ProductCode } from '../shared/types.ts';
import { type AlertPatch, type AlertRepo, type AlertRow, type NewAlert, AlertDuplicate, VariantNotFound, type Decision } from './ports.ts';

// Alerta por variante no store 'alerts' (id auto). Sem e-mail (vive em settings).
export function createAlertStore(db: Db): AlertRepo {
  const dupOf = async (a: { variantCode: string; targetCents: number; marginBp: number }, exceptId?: number) =>
    (await db.getAll<AlertRow>('alerts', { index: 'variantCode', range: { eq: a.variantCode } })).some(
      (r) => r.id !== exceptId && r.targetCents === a.targetCents && r.marginBp === a.marginBp,
    );

  const get = async (id: number) => (await db.get<AlertRow>('alerts', id)) ?? null;

  return {
    create: (a: NewAlert, now: IsoUtc) =>
      db.tx(async () => {
        if (!(await db.get('variants', a.variantCode))) throw new VariantNotFound(a.variantCode);
        if (await dupOf(a)) throw new AlertDuplicate('alerta idêntico já existe');
        const row = {
          variantCode: a.variantCode, targetCents: a.targetCents, marginBp: a.marginBp,
          status: 'ATIVO', pausedAt: null, revision: 1,
          episodeProximo: 0, episodeAtingido: 0, armedProximo: true, armedAtingido: true,
          lastSentProximoAt: null, lastSentAtingidoAt: null,
          rearmNotBeforeProximo: null, rearmNotBeforeAtingido: null,
          evaluatedOnce: false, createdAt: now, updatedAt: now,
        };
        return (await db.add('alerts', row)) as number;
      }),

    get,
    list: () => db.getAll<AlertRow>('alerts'),

    async activeByProduct(code: ProductCode) {
      const vs = await db.getAll<{ variantCode: string }>('variants', { index: 'productCode', range: { eq: code } });
      const out: AlertRow[] = [];
      for (const v of vs) out.push(...(await db.getAll<AlertRow>('alerts', { index: 'variantCode', range: { eq: v.variantCode } })));
      return out.filter((a) => a.status === 'ATIVO').sort((a, b) => a.id - b.id);
    },

    update: (id: number, patch: AlertPatch, now: IsoUtc) =>
      db.tx(async () => {
        const cur = await get(id);
        if (!cur) return;
        const target = patch.targetCents ?? cur.targetCents;
        const margin = patch.marginBp ?? cur.marginBp;
        const status = patch.status ?? cur.status;
        // RN-14: mudar alvo/margem reabre as duas travas e muda a revisão; só status não.
        const reopen = target !== cur.targetCents || margin !== cur.marginBp;
        if (reopen && (await dupOf({ variantCode: cur.variantCode, targetCents: target, marginBp: margin }, id)))
          throw new AlertDuplicate('alerta idêntico já existe');
        const next: AlertRow = {
          ...cur, targetCents: target, marginBp: margin, status,
          pausedAt: status === 'PAUSADO' ? (cur.status === 'PAUSADO' ? cur.pausedAt : now) : null,
          updatedAt: now,
          ...(reopen && {
            revision: cur.revision + 1, armedProximo: true, armedAtingido: true,
            rearmNotBeforeProximo: null, rearmNotBeforeAtingido: null,
          }),
        };
        await db.put('alerts', next);
      }),

    applyDecision: (id: number, next: Decision['next'], fire: Decision['fire'], now: IsoUtc) =>
      db.tx(async () => {
        const cur = await get(id);
        if (!cur) return;
        await db.put('alerts', {
          ...cur, ...next, updatedAt: now,
          ...(fire?.kind === 'PROXIMO' && { lastSentProximoAt: now }),
          ...(fire?.kind === 'ATINGIDO' && { lastSentAtingidoAt: now }),
        });
      }),

    // Cascata em notifications; observations (histórico) ficam.
    delete: (id: number) =>
      db.tx(async () => {
        const ns = await db.getAll<{ key: string }>('notifications', { index: 'alertId', range: { eq: id } });
        for (const n of ns) await db.delete('notifications', n.key);
        await db.delete('alerts', id);
      }),
  };
}
