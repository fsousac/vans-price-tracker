// Service worker MV3 (extension-architecture.md seção 4). Efêmero: TODOS os listeners são registrados
// de forma síncrona no topo do módulo; cada evento pede os serviços (composição preguiçosa) e devolve a promessa.
import { registerNotificationClicks } from '../notifier.chrome.ts';
import { ensureAlarms, handleAlarm, handleLifecycle, handlePermissionRemoved, type GetServices } from './alarms.ts';
import { registerApi } from './api.ts';
import { createComposer, degradedApi } from './compose.ts';

export function registerListeners(get: GetServices): void {
  registerApi(async () => {
    const s = await get();
    return s.degraded ? degradedApi : s.api;
  });
  registerNotificationClicks(async (key) => {
    const s = await get();
    return s.degraded ? null : s.notificationCode(key);
  });
  chrome.alarms.onAlarm.addListener((a) => handleAlarm(a.name, get));
  chrome.runtime.onInstalled.addListener((d) => handleLifecycle(get, d.reason));
  chrome.runtime.onStartup.addListener(() => handleLifecycle(get));
  chrome.permissions.onRemoved.addListener((p) => handlePermissionRemoved(p.origins, get));
  void ensureAlarms(); // a cada ativação: alarmes podem sumir após atualização/reinício
}

const composer = createComposer();
registerListeners(() => composer.getServices());
