# ADR-0005: Notificações, estados e idempotência

Status: aceito (2026-10-14).

## Contexto

Requisitos: estados de notificação `PENDENTE`/`ACEITO`/`FALHA` (aceite != entrega), dois tipos de aviso de preço (`PROXIMO`, `ATINGIDO`) com travas e rearme, sem duplicatas por reprocessamento, retry, reinício ou concorrência; modo de teste que não envia; aviso de saúde ao dono 1x por episódio. A chave do enunciado: `(alert_id, observation_id/condição)`.

## Decisão

1. **Outbox transacional.** O disparo é uma única transação: gravar a observação, avaliar o alerta, fechar a trava e inserir a `Notification` `PENDENTE`. O envio acontece depois, fora da transação, por `drain()`.
2. **Idempotência em duas camadas no banco:**
   - `idempotency_key = sha256("{alert_id}|{revision}|{kind}|{episode}")` `UNIQUE` (a "condição": revisão do alerta, tipo e episódio de rearme; o episódio só incrementa no rearme).
   - `UNIQUE (alert_id, observation_id, kind)` parcial (a observação que disparou).
   - Inserção por `ON CONFLICT DO NOTHING`; a trava fechada impede o caminho normal de sequer tentar.
   - Saúde: `sha256("saude|{health_event_id}")` e `ux_health_open` (1 episódio aberto por `kind`+`subject`).
3. **Estados:** `PENDENTE -> ACEITO | FALHA`; `claimDue` (TX `IMMEDIATE`) faz `attempts++` e põe lease em `next_attempt_at` antes do envio; erro temporário mantém `PENDENTE` com `next_attempt_at` (5 min, 30 min, 2 h); tentativa inicial + 3 retentativas (4 envios) ou erro permanente = `FALHA` com `failure_reason` (código); `FALHA -> PENDENTE` só por "reenviar" manual (mesma linha, mesma chave, D-30). `ACEITO` = o provedor aceitou (SMTP 250); a UI diz "aceito pelo provedor", nunca "entregue".
4. **Modo de teste:** `EMAIL_MODE=test` (padrão) usa `SimulatedMailer`: nenhuma conexão, a notificação vai a `ACEITO` com `simulated=1`, `mode='teste'`; log só com `{kind, alert_id, price_cents}`. `EMAIL_TEST_SINK=file` é opt-in e grava o `.eml` local.
5. **Tentativa contada antes do envio** (`attempts++` persistido antes de `send`): a janela "provedor aceitou, processo caiu antes de gravar `ACEITO`" gera reenvio no máximo 4 vezes: entrega pelo menos uma vez, duplicata rara aceita (R-09, D-31). `Message-ID` derivado da chave ajuda a agrupar.
6. **Snapshot:** a notificação guarda produto, slug, tamanho, preço, alvo, margem, instante, fonte, `degraded`, `already_in_band`; o e-mail se renderiza só disso (determinístico). O destinatário **não** é copiado: vem do alerta no envio (some com o alerta; `ON DELETE CASCADE`), e `SAUDE` vai a `OWNER_EMAIL` do ambiente.
7. **Travas e rearme:** ACIMA->ATINGIDO envia só `ATINGIDO` e fecha as duas travas; `PROXIMO` e depois `ATINGIDO` são 2 notificações; rearme exige confirmação `P > T` (ou `> T*(1+M)`) e `rearm_not_before` (24 h após o último envio do tipo); indisponibilidade nem dispara nem rearma; editar alvo/margem/variante incrementa `revision` e reabre travas (nova chave).
8. **Freios:** no máximo 20 e-mails/h no total; `PENDENTE` de alerta pausado por > 24 h vira `FALHA('alerta_pausado')`.
9. **Nunca alerta sem evidência:** só observação `confirmed && available` e alerta `ATIVO`; falha de coleta não cria nada (RN-16, RNF-REL-01).

## Alternativas

| Alternativa | Por que não |
|---|---|
| Enviar e-mail dentro da transação da observação | Segura transação durante rede; falha de SMTP perderia a observação ou o alerta |
| Chave só `(alert_id, observation_id)` | Reedição do alerta ou rearme não distingue a "condição"; a chave por `(revisão, tipo, episódio)` expressa a regra de negócio, e a observação segue protegida pelo segundo índice |
| Tentar de novo sem limite | Rajada de e-mails; D-30 pede parar em 3 e reenvio manual |
| Fila externa (Redis/SQS) | Proibido/desnecessário; a própria tabela é o outbox |
| "Entregue" via webhook do provedor | Não observável no MVP; documentar a diferença é a escolha honesta |
| Guardar o e-mail do destinatário na notificação | PII duplicada; apagar o alerta deixaria cópia |

## Consequências

Retentativa, reinício e reprocessamento são seguros por construção; testes de concorrência (T-DUP-07) exercitam a restrição única; a UI precisa dos textos "aceito pelo provedor" e "simulado (não enviado)"; "entregue/bounce" fica para deploy público (SPF/DKIM/DMARC, tratamento de bounce).
