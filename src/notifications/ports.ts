import type { BasisPoints, Cents, IsoUtc, SourceName } from '../shared/types.ts';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}
export type MailResult =
  | { kind: 'accepted'; providerMessageId: string }
  | { kind: 'temporary_error'; reason: string }
  | { kind: 'permanent_error'; reason: string };
export interface Mailer {
  readonly mode: 'real' | 'teste';
  send(msg: OutgoingEmail): Promise<MailResult>; // nunca lança por erro de provedor
}

export type NotificationKind = 'PROXIMO' | 'ATINGIDO' | 'SAUDE';
export type NotificationStatus = 'PENDENTE' | 'ACEITO' | 'FALHA';

export interface NewNotification {
  alertId: number | null;
  healthEventId: number | null;
  observationId: number | null;
  kind: NotificationKind;
  idempotencyKey: string; // sha256 hex (64)
  mode: 'real' | 'teste';
  productCode: string | null;
  productName: string | null;
  productSlug: string | null;
  size: string | null;
  priceCents: Cents | null;
  targetCents: Cents | null;
  marginBp: BasisPoints | null;
  observedAt: IsoUtc | null;
  source: SourceName | null;
  degraded: boolean;
  alreadyInBand: boolean;
  now: IsoUtc;
}
export interface NotificationRow extends Omit<NewNotification, 'now'> {
  id: number;
  status: NotificationStatus;
  simulated: boolean;
  attempts: number;
  nextAttemptAt: IsoUtc | null;
  providerMessageId: string | null;
  acceptedAt: IsoUtc | null;
  failureReason: string | null;
  createdAt: IsoUtc;
  updatedAt: IsoUtc;
}

export interface NotificationRepo {
  insertIfAbsent(n: NewNotification): { id: number; created: boolean };
  claimDue(now: IsoUtc, limit: number): NotificationRow[]; // attempts++ e lease antes de devolver
  markAccepted(id: number, r: { providerMessageId: string; now: IsoUtc; simulated: boolean }): void;
  markAttemptFailed(id: number, r: { nextAttemptAt: IsoUtc | null; reason: string; now: IsoUtc }): void; // null => FALHA
  resend(id: number, now: IsoUtc): boolean;
  listForAlert(alertId: number): NotificationRow[];
}
