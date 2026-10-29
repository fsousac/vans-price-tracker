// Adaptador da porta Notifier sobre chrome.notifications (E15). Texto de modelo fixo; nunca lança.
import type { Notifier } from '../notifications/notifier.ts';
import { formatSaoPaulo } from '../notifications/render.ts';
import { extractProductCode } from '../price-monitor/url.ts';
import { stripControl } from '../shared/mask.ts';
import { formatBrl } from '../shared/money.ts';
import type { NotificationRow } from '../store/ports.ts';

const clip = (s: string, n: number) => [...stripControl(s)].slice(0, n).join('');

export function renderDesktop(n: NotificationRow): { title: string; message: string } {
  if (n.kind === 'SAUDE') {
    return { title: 'Vans Price Watcher: atenção', message: 'O monitor encontrou um problema. Abra o painel para ver os detalhes.' };
  }
  const name = clip(n.productName ?? '', 80) || 'Produto';
  const lines = [
    n.priceCents != null ? `Preço: ${formatBrl(n.priceCents)}` : '',
    n.targetCents != null ? `Alvo: ${formatBrl(n.targetCents)}` : '',
    n.size ? `Tamanho: ${clip(n.size, 20)}` : '',
    n.observedAt ? `Lido em ${formatSaoPaulo(n.observedAt)} (Brasília)` : '',
  ].filter(Boolean);
  return { title: `${n.kind === 'ATINGIDO' ? 'Preço-alvo atingido' : 'Próximo do alvo'}: ${name}`, message: lines.join('\n') };
}

/** O id da notificação é a chave de idempotência; 'mostrada' = entregue ao sistema, não "lida". */
export function createChromeNotifier(): Notifier {
  return {
    async show(n) {
      try {
        await chrome.notifications.create(n.key, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/128.png'),
          ...renderDesktop(n),
          requireInteraction: n.kind !== 'SAUDE',
        });
        return chrome.runtime.lastError ? 'falha' : 'mostrada';
      } catch {
        return 'falha';
      }
    },
  };
}

/** Só abre https://www.vans.com.br/p/{code}, reconstruída do code validado. Chamar no topo do sw.ts. */
export function registerNotificationClicks(lookupCode: (key: string) => Promise<string | null>): void {
  chrome.notifications.onClicked.addListener(async (key: string) => {
    try {
      const code = await lookupCode(key);
      if (!code) return;
      const r = extractProductCode(`https://www.vans.com.br/p/${code}`);
      if (!r.ok) return;
      await chrome.tabs.create({ url: `https://www.vans.com.br/p/${r.value}` });
      await chrome.notifications.clear(key);
    } catch {
      /* ignora: clique nunca deve quebrar o service worker */
    }
  });
}
