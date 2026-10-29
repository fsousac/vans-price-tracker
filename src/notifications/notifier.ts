import type { NotificationRow } from '../store/ports.ts';

/** Canal desktop. 'mostrada' = entregue ao sistema de notificações, não "lida". Nunca lança. */
export interface Notifier {
  show(n: NotificationRow): Promise<'mostrada' | 'falha'>;
}
