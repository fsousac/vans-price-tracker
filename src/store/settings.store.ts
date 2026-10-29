import { err, ok, type Result } from '../shared/result.ts';
import {
  applySettings, parseSettings, publicSettings, toStored,
  type PublicSettings, type Settings, type SettingsErrors, type SettingsPatch,
} from '../settings/settings.ts';
import type { KvRepo } from './ports.ts';

export interface SettingsStore {
  /** Só para serviços internos do SW (inclui apiKey; toJSON redigido). */
  get(): Promise<Settings>;
  /** Para a camada de UI: nunca traz apiKey (só apiKeySet). */
  getPublic(): Promise<PublicSettings>;
  /** Aplica patch validado; devolve a visão pública. */
  set(patch: SettingsPatch): Promise<Result<PublicSettings, SettingsErrors>>;
}

export function createSettingsStore(kv: KvRepo): SettingsStore {
  const get = async (): Promise<Settings> => {
    const raw = await kv.get('settings');
    try { return parseSettings(raw === null ? null : JSON.parse(raw)); } catch { return parseSettings(null); }
  };
  return {
    get,
    getPublic: async () => publicSettings(await get()),
    async set(patch) {
      const r = applySettings(await get(), patch);
      if (!r.ok) return err(r.error);
      await kv.set('settings', JSON.stringify(toStored(r.value))); // toStored: cópia com apiKey, sem toJSON
      return ok(publicSettings(r.value));
    },
  };
}
