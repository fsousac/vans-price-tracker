import { classifyBand } from '../shared/price-compare.ts';
import type { AlertKind, AlertState, Decision, ObservationView } from './ports.ts';

// RN-11..16 (pura, sem I/O). Quem persiste é alerts.service.apply().
export function evaluateAlert(a: AlertState, o: ObservationView, now: Date, cooldownMs: number): Decision {
  const next: Decision['next'] = {
    armedProximo: a.armedProximo,
    armedAtingido: a.armedAtingido,
    episodeProximo: a.episodeProximo,
    episodeAtingido: a.episodeAtingido,
    rearmNotBeforeProximo: a.rearmNotBeforeProximo,
    rearmNotBeforeAtingido: a.rearmNotBeforeAtingido,
    evaluatedOnce: a.evaluatedOnce,
  };
  if (a.status !== 'ATIVO') return { fire: null, next, reason: 'inativo' };
  if (!o.confirmed) return { fire: null, next, reason: 'nao_confirmada' };

  const band = classifyBand(o.currentCents, a.targetCents, a.marginBp);
  const observedMs = Date.parse(o.observedAt);
  const cooledDown = (notBefore: string | null): boolean => notBefore === null || observedMs >= Date.parse(notBefore);
  let rearmed = false;

  // RN-13: rearme só depende do preço confirmado (não da disponibilidade) e do cooldown da própria observação.
  if (!next.armedAtingido && band !== 'ATINGIDO' && cooledDown(next.rearmNotBeforeAtingido)) {
    next.armedAtingido = true;
    next.episodeAtingido++;
    rearmed = true;
  }
  if (!next.armedProximo && band === 'ACIMA' && cooledDown(next.rearmNotBeforeProximo)) {
    next.armedProximo = true;
    next.episodeProximo++;
    rearmed = true;
  }

  // RN-16: indisponível nunca dispara; também não marca "primeira avaliação" (alreadyInBand fica para o disparo real).
  if (!o.available) {
    const reason = band === 'ACIMA' ? (rearmed ? 'rearmado' : 'fora_da_faixa') : 'indisponivel';
    return { fire: null, next, reason };
  }

  const alreadyInBand = !next.evaluatedOnce;
  next.evaluatedOnce = true;
  const cooldownEnd = new Date(now.getTime() + cooldownMs).toISOString();

  let kind: AlertKind | null = null;
  if (band === 'ATINGIDO' && next.armedAtingido) {
    kind = 'ATINGIDO';
    next.armedAtingido = false;
    next.armedProximo = false; // ATINGIDO fecha as duas travas
    next.rearmNotBeforeAtingido = cooldownEnd;
    next.rearmNotBeforeProximo = cooldownEnd;
  } else if (band === 'PROXIMO' && next.armedProximo) {
    kind = 'PROXIMO';
    next.armedProximo = false;
    next.rearmNotBeforeProximo = cooldownEnd;
  }
  if (kind) {
    const episode = kind === 'ATINGIDO' ? next.episodeAtingido : next.episodeProximo;
    return { fire: { kind, episode, alreadyInBand }, next, reason: 'disparo' };
  }
  if (rearmed) return { fire: null, next, reason: 'rearmado' };
  return { fire: null, next, reason: band === 'ACIMA' ? 'fora_da_faixa' : 'travado' };
}
