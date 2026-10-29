import type { BasisPoints, Cents, IsoUtc, ProductCode, VariantCode } from '../shared/types.ts';

export type AlertStatus = 'ATIVO' | 'PAUSADO';
export type AlertKind = 'PROXIMO' | 'ATINGIDO';

export interface AlertState {
  id: number;
  revision: number;
  status: AlertStatus;
  targetCents: Cents;
  marginBp: BasisPoints;
  armedProximo: boolean;
  armedAtingido: boolean;
  episodeProximo: number;
  episodeAtingido: number;
  rearmNotBeforeProximo: IsoUtc | null;
  rearmNotBeforeAtingido: IsoUtc | null;
  evaluatedOnce: boolean;
}
export interface ObservationView {
  id: number;
  currentCents: Cents;
  available: boolean;
  confirmed: boolean;
  observedAt: IsoUtc;
}
export type Decision = {
  fire: null | { kind: AlertKind; episode: number; alreadyInBand: boolean };
  next: Pick<
    AlertState,
    | 'armedProximo'
    | 'armedAtingido'
    | 'episodeProximo'
    | 'episodeAtingido'
    | 'rearmNotBeforeProximo'
    | 'rearmNotBeforeAtingido'
    | 'evaluatedOnce'
  >;
  reason: 'inativo' | 'nao_confirmada' | 'indisponivel' | 'fora_da_faixa' | 'travado' | 'disparo' | 'rearmado';
};

export interface AlertRow extends AlertState {
  variantCode: VariantCode;
  email: string;
  pausedAt: IsoUtc | null;
  lastSentProximoAt: IsoUtc | null;
  lastSentAtingidoAt: IsoUtc | null;
  createdAt: IsoUtc;
  updatedAt: IsoUtc;
}
export interface NewAlert {
  variantCode: VariantCode;
  targetCents: Cents;
  marginBp: BasisPoints;
  email: string;
}
export type AlertPatch = Partial<Pick<NewAlert, 'targetCents' | 'marginBp' | 'email'>> & { status?: AlertStatus };

export class AlertDuplicate extends Error {}
export class VariantNotFound extends Error {}

export interface AlertRepo {
  create(a: NewAlert, now: IsoUtc): number; // lança AlertDuplicate (UNIQUE) ou VariantNotFound (FK)
  get(id: number): AlertRow | null;
  list(): AlertRow[];
  activeByProduct(code: ProductCode): AlertRow[];
  update(id: number, patch: AlertPatch, now: IsoUtc): void;
  applyDecision(id: number, next: Decision['next'], fire: Decision['fire'], now: IsoUtc): void;
  delete(id: number): void; // cascade em notifications
}
