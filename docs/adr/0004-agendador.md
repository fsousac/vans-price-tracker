# ADR-0004: Agendador in-process persistente e recuperável

Status: aceito (2026-10-14).

## Contexto

Monitoramento periódico (padrão 4 h, 2-6 h) de até 50 produtos, 1 requisição por vez com cortesia de 2-5 s, teto 400 req/24 h de qualquer origem. Sem Redis, filas externas ou cron do sistema (restrição de produto). O app roda local e pode ser fechado (D-13). Requisitos: não sobrepor rodadas (RF-06-AC4), 1 rodada de recuperação na partida (RF-06-AC5), circuito de 24 h (RN-18), tudo testável com relógio falso.

## Decisão

1. **Laço único no processo:** `tick()` a cada 30 s via `Clock.sleep` (`while(!stopped)`); `tick()` é público e determinístico, e é o que os testes chamam. O `tick` **não espera** a rodada (ela roda em segundo plano), senão heartbeat e `drain` ficariam parados durante a coleta.
2. **O estado da agenda é o banco, não a memória.** `monitoring_runs` (`kind`, `trigger`, `status`, `started_at`...) e `run_items` registram o que foi feito. "Vence" quando `now >= início_da_última_rodada_monitor_não_pulada + I`. Reiniciar não perde agenda nem duplica.
3. **Uma rodada por vez garantida pelo banco:** índice único parcial `WHERE status='running'` (vale também entre dois processos). Gatilho que chega com rodada em andamento é registrado como `skipped: anterior_em_andamento`.
4. **Recuperação:** na partida, `running` órfão vira `interrupted`; no máximo 1 rodada `recovery` se vencida, coletando só produtos sem leitura boa há >= 2 h (isso também retoma uma rodada interrompida sem refazer o que já foi lido). Sem rodadas em cascata ao voltar da suspensão do notebook (o `due` é um instante, não uma contagem).
5. **Limites no banco/consulta:** mínimo de 2 h por produto (`dueForCollection`), teto 50 produtos (no `create` de alerta), orçamento 400 req/24 h de qualquer origem (`outbound_requests`, escrita pelo `RateGate`), ordem "leitura mais antiga primeiro".
6. **Circuito global** em `app_state` (`circuit_open_until`, `circuit_reason`): 403/desafio, 2x 429 ou 3 falhas de transporte seguidas abrem por 24 h; depois, meia-abertura com 1 requisição de sonda; sucesso fecha; falha reabre sem novo aviso (mesmo episódio em `health_events`).
7. **Retentativa:** até 2 por item (5 s, 10 s, jitter +-25%); `Retry-After` respeitado (teto 60 s); 403 sem retentativa.
8. **Parada limpa:** `SIGINT/SIGTERM` aborta sleeps, termina o item corrente, fecha a rodada como `partial`.
9. **Heartbeat persistido** (`scheduler_heartbeat_at`) para `/saude` (`atrasado` se a última rodada concluída tem mais de `2*I`).
10. As notificações têm seu próprio laço leve (`drain`) no mesmo `tick`, independente da rodada de coleta.

## Alternativas

| Alternativa | Por que não |
|---|---|
| `setInterval` puro | Perde o estado ao reiniciar, sobrepõe rodadas, não é testável com relógio falso |
| `node-cron`/`agenda`/`bree` | Dependência para algo que `tick()` + SQL resolve; `agenda` exige Mongo |
| Cron/Agendador de Tarefas do SO | Fora do processo; dificulta locks, circuito e testes; acopla ao SO |
| Fila de jobs (BullMQ/Redis) | Proibido pela restrição de produto; desproporcional |
| Tabela `jobs` genérica com workers | Só há um tipo de trabalho periódico; as próprias rodadas já são o registro |
| Agenda por produto (`next_check_at`) | Mais flexível, mais estado e mais casos; rodada única respeita melhor cortesia e circuito. Revisitar se o volume exigir frequências por produto |

## Consequências

- Só roda com o app aberto (documentado na UI e em `operations.md`); frescor/`defasado` e `/saude` tornam a lacuna visível.
- Deploy público exigiria worker fora do processo web e fila durável (`security.md`, seção 8).
- Relógio do sistema que volta no tempo pode atrasar uma rodada; aceito (uso pessoal).
- Duas instâncias do app no mesmo banco não coletam em paralelo (índice único), mas ambas rodam `tick()`: documentar "uma instância".
