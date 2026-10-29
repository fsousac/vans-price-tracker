# Modelo de dados: Vans Price Watcher

Versão 0.1 (2026-10-14). Banco: SQLite (arquivo único `data/vans-alert.db`) via `better-sqlite3` (ADR-0001). Requisitos: `docs/requirements.md`. Contratos de código: `docs/architecture.md`.

> **ADR-0006 (2026-10-15): o produto agora é uma extensão MV3.** Os campos e as regras de integridade continuam; o DDL SQLite é histórico. O esquema vigente (IndexedDB, 12 stores, migração por versão) está em `docs/extension-architecture.md` seção 7.

## 1. Convenções

| Tema | Regra |
|---|---|
| Dinheiro | `INTEGER` em centavos de BRL, sufixo `_cents` (ADR-0003). Nunca `REAL`. Margem em pontos-base inteiros, sufixo `_bp` (300 = 3%). |
| Tempo | `TEXT` ISO-8601 UTC com milissegundos e `Z`: `2026-10-14T12:00:00.000Z` (24 caracteres, ordena lexicograficamente). Gerado só pelo `Clock` injetado; nunca `datetime('now')` no SQL. Exibição em America/Sao_Paulo é da camada `web`/`notifications`. |
| Tabelas | `STRICT` (SQLite >= 3.37; o driver traz 3.53 no ambiente verificado). Tipos: `INTEGER`, `TEXT`. Booleano = `INTEGER` 0/1 com `CHECK`. |
| Conexão | `PRAGMA foreign_keys = ON; journal_mode = WAL; synchronous = NORMAL; busy_timeout = 5000;` definidos em `db/connection.ts` (PRAGMA de conexão não pertence a migração). |
| Chaves | Naturais quando a investigação dá uma (`products.code`, `product_variants.variant_code`); `INTEGER PRIMARY KEY` (rowid) nas demais. |
| Enums | `TEXT` com `CHECK (... IN (...))`. Valores de domínio em pt-BR sem acento, como em requirements (`ATIVO`, `PENDENTE`, `formato_desconhecido`). |
| SQL | Só dentro dos `*.repo.ts` (RNF-MNT-02), sempre parametrizado (`?`/`@nome`). Nenhuma concatenação de entrada. |
| Dados proibidos | Sem imagens, descrições, cookies, headers de sessão (RN-21). O único dado pessoal é `price_alerts.email`. |

Decisão de modelagem: falha de extração nunca entra em `price_observations`; vive em `run_items` (RF-07-AC3). A tabela de observações tem `CHECK (current_cents > 0)`, portanto um "preço de falha" R$ 0 é inexpressável no banco, não só no código.

## 2. Diagrama lógico

```
products 1--* product_variants 1--* price_observations *--1 monitoring_runs 1--* run_items *--1 products
                    |                      ^
                    1                      | observation_id (SET NULL)
                    *                      |
              price_alerts 1--* notifications *--0..1 health_events
catalog_items (cache de listagem, independente)   app_state (chave/valor)   failure_samples (1 por produto)
```

## 3. DDL completo: `migrations/0001_init.sql`

```sql
-- 0001_init.sql  (forward-only; o runner a executa dentro de uma transação)

CREATE TABLE products (
  code                 TEXT PRIMARY KEY
    CHECK (length(code) BETWEEN 8 AND 20 AND code NOT GLOB '*[^A-Za-z0-9]*'),   -- D-24
  name                 TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  legacy_sku           TEXT CHECK (legacy_sku IS NULL OR length(legacy_sku) <= 40),
  last_slug            TEXT CHECK (last_slug IS NULL OR (length(last_slug) <= 200 AND last_slug NOT GLOB '*[^a-z0-9-]*')),
  state                TEXT NOT NULL DEFAULT 'ativo'
    CHECK (state IN ('ativo','removido','formato_desconhecido')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),  -- >=3 => "com_falha" (derivado)
  not_found_streak     INTEGER NOT NULL DEFAULT 0 CHECK (not_found_streak >= 0),      -- 2 => removido (RN-19)
  degraded_since       TEXT,                                                           -- leitura por fonte fallback (RN-09a)
  last_attempt_at      TEXT,                                                           -- última tentativa (ok ou falha)
  last_ok_at           TEXT,                                                           -- última leitura válida
  created_at           TEXT NOT NULL CHECK (length(created_at) = 24),
  updated_at           TEXT NOT NULL CHECK (length(updated_at) = 24)
) STRICT;

CREATE TABLE product_variants (
  variant_code TEXT PRIMARY KEY,                                   -- '1003800580026U-34'
  product_code TEXT NOT NULL REFERENCES products(code) ON DELETE CASCADE,
  size         TEXT NOT NULL CHECK (length(size) BETWEEN 1 AND 10),
  ean          TEXT CHECK (ean IS NULL OR length(ean) <= 20),
  last_seen_at TEXT NOT NULL CHECK (length(last_seen_at) = 24),
  CHECK (substr(variant_code, 1, length(product_code) + 1) = product_code || '-'),
  UNIQUE (product_code, size)
) STRICT;

CREATE TABLE monitoring_runs (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('monitor','catalog')),
  trigger       TEXT NOT NULL CHECK (trigger IN ('scheduled','recovery','manual')),
  status        TEXT NOT NULL CHECK (status IN ('running','ok','partial','failed','skipped','interrupted')),
  skip_reason   TEXT CHECK (skip_reason IS NULL OR skip_reason IN
                  ('anterior_em_andamento','circuito_aberto','sem_alertas_ativos','intervalo_minimo','orcamento_diario')),
  started_at    TEXT NOT NULL CHECK (length(started_at) = 24),
  finished_at   TEXT CHECK (finished_at IS NULL OR length(finished_at) = 24),
  items_total   INTEGER NOT NULL DEFAULT 0 CHECK (items_total >= 0),
  items_ok      INTEGER NOT NULL DEFAULT 0 CHECK (items_ok >= 0),
  items_failed  INTEGER NOT NULL DEFAULT 0 CHECK (items_failed >= 0),
  requests_made INTEGER NOT NULL DEFAULT 0 CHECK (requests_made >= 0),
  circuit_opened INTEGER NOT NULL DEFAULT 0 CHECK (circuit_opened IN (0,1)),
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK ((status = 'skipped') = (skip_reason IS NOT NULL))
) STRICT;
-- RNF-REL-03: o banco garante no máximo uma rodada (monitor OU catálogo) em execução.
-- Atenção às CHECKs: toda saída de 'running' (ok, partial, failed, skipped, interrupted) DEVE gravar finished_at na mesma UPDATE
-- (markInterruptedOnStartup inclusive, senão a partida do app falha), e 'skipped' exige skip_reason (rodada sem alertas = skipped/sem_alertas_ativos).
CREATE UNIQUE INDEX ux_runs_single_running ON monitoring_runs (status) WHERE status = 'running';
CREATE INDEX ix_runs_kind_started ON monitoring_runs (kind, started_at DESC);

CREATE TABLE run_items (
  id                 INTEGER PRIMARY KEY,
  run_id             INTEGER NOT NULL REFERENCES monitoring_runs(id) ON DELETE CASCADE,
  product_code       TEXT NOT NULL REFERENCES products(code) ON DELETE CASCADE,
  seq                INTEGER NOT NULL CHECK (seq >= 1),                 -- ordem na rodada
  outcome            TEXT NOT NULL CHECK (outcome IN ('ok','degradado','falha','pulado')),
  failure_class      TEXT CHECK (failure_class IS NULL OR failure_class IN
                       ('rede_timeout','http_5xx','http_429','http_403_ou_desafio','produto_removido',
                        'formato_desconhecido','preco_invalido','host_nao_autorizado')),
  skip_reason        TEXT CHECK (skip_reason IS NULL OR skip_reason IN ('intervalo_minimo','orcamento_diario','circuito_aberto')),
  http_status        INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  source             TEXT CHECK (source IS NULL OR source IN ('occ','next_data','json_ld')),
  requests           INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),   -- inclui retentativas e fallbacks
  attempts           INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  duration_ms        INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  observations_written INTEGER NOT NULL DEFAULT 0 CHECK (observations_written >= 0),
  finished_at        TEXT NOT NULL CHECK (length(finished_at) = 24),
  CHECK ((outcome = 'falha') = (failure_class IS NOT NULL)),
  CHECK ((outcome = 'pulado') = (skip_reason IS NOT NULL)),
  UNIQUE (run_id, product_code)
) STRICT;
CREATE INDEX ix_items_product_time ON run_items (product_code, finished_at DESC);
CREATE INDEX ix_items_time ON run_items (finished_at);            -- retenção (o orçamento usa outbound_requests)

CREATE TABLE price_observations (
  id              INTEGER PRIMARY KEY,
  variant_code    TEXT NOT NULL REFERENCES product_variants(variant_code) ON DELETE CASCADE,
  run_id          INTEGER NOT NULL REFERENCES monitoring_runs(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL DEFAULT 1 CHECK (seq >= 1),       -- releitura no mesmo ciclo (RN-09c)
  observed_at     TEXT NOT NULL CHECK (length(observed_at) = 24),
  original_cents  INTEGER NOT NULL CHECK (original_cents > 0 AND original_cents <= 9999999),
  current_cents   INTEGER NOT NULL CHECK (current_cents > 0 AND current_cents <= original_cents),  -- RN-04
  available       INTEGER NOT NULL CHECK (available IN (0,1)),       -- sellable AND stockLevel>0 (RN-06)
  confirmed       INTEGER NOT NULL CHECK (confirmed IN (0,1)),
  confirmed_by    INTEGER REFERENCES price_observations(id) ON DELETE SET NULL,  -- leitura que concordou (RN-09c)
  degraded        INTEGER NOT NULL CHECK (degraded IN (0,1)),
  source          TEXT NOT NULL CHECK (source IN ('occ','next_data','json_ld')),
  UNIQUE (run_id, variant_code, seq)                                 -- reprocessar a mesma rodada não duplica
) STRICT;
CREATE INDEX ix_obs_variant_time ON price_observations (variant_code, observed_at DESC);
CREATE INDEX ix_obs_variant_confirmed ON price_observations (variant_code, observed_at DESC) WHERE confirmed = 1;
CREATE INDEX ix_obs_run ON price_observations (run_id);

CREATE TABLE price_alerts (
  id                    INTEGER PRIMARY KEY,
  variant_code          TEXT NOT NULL REFERENCES product_variants(variant_code) ON DELETE RESTRICT,
  target_cents          INTEGER NOT NULL CHECK (target_cents BETWEEN 1 AND 9999999),     -- RN-10: até 99.999,99
  margin_bp             INTEGER NOT NULL DEFAULT 300 CHECK (margin_bp BETWEEN 0 AND 5000), -- RF-05
  email                 TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1
                          AND instr(email, char(10)) = 0 AND instr(email, char(13)) = 0 AND instr(email, ' ') = 0),
  status                TEXT NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','PAUSADO')),
  paused_at             TEXT CHECK (paused_at IS NULL OR length(paused_at) = 24),
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),                -- RN-14
  episode_proximo       INTEGER NOT NULL DEFAULT 1 CHECK (episode_proximo >= 1),         -- RN-12/13, por tipo
  episode_atingido      INTEGER NOT NULL DEFAULT 1 CHECK (episode_atingido >= 1),
  armed_proximo         INTEGER NOT NULL DEFAULT 1 CHECK (armed_proximo IN (0,1)),       -- trava de disparo
  armed_atingido        INTEGER NOT NULL DEFAULT 1 CHECK (armed_atingido IN (0,1)),
  last_sent_proximo_at  TEXT CHECK (last_sent_proximo_at IS NULL OR length(last_sent_proximo_at) = 24),
  last_sent_atingido_at TEXT CHECK (last_sent_atingido_at IS NULL OR length(last_sent_atingido_at) = 24),
  rearm_not_before_proximo  TEXT CHECK (rearm_not_before_proximo IS NULL OR length(rearm_not_before_proximo) = 24),
  rearm_not_before_atingido TEXT CHECK (rearm_not_before_atingido IS NULL OR length(rearm_not_before_atingido) = 24),
  evaluated_once        INTEGER NOT NULL DEFAULT 0 CHECK (evaluated_once IN (0,1)),      -- D-09 ("já estava na faixa")
  created_at            TEXT NOT NULL CHECK (length(created_at) = 24),
  updated_at            TEXT NOT NULL CHECK (length(updated_at) = 24),
  CHECK ((status = 'PAUSADO') = (paused_at IS NOT NULL)),
  UNIQUE (variant_code, target_cents, margin_bp, email)                                  -- RF-09-AC7 (ver nota 4.2)
) STRICT;
CREATE INDEX ix_alerts_variant_status ON price_alerts (variant_code, status);
CREATE INDEX ix_alerts_status ON price_alerts (status);

CREATE TABLE health_events (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN
               ('circuito_aberto','parser_degradado','produto_com_falha','produto_removido','formato_desconhecido')),
  subject    TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 40),        -- 'global' ou products.code
  detail     TEXT CHECK (detail IS NULL OR length(detail) <= 200),          -- só classe de falha/motivo, sem PII
  opened_at  TEXT NOT NULL CHECK (length(opened_at) = 24),
  closed_at  TEXT CHECK (closed_at IS NULL OR length(closed_at) = 24)
) STRICT;
-- RNF-OBS-03: no máximo um episódio aberto por (kind, subject) => um aviso por episódio.
CREATE UNIQUE INDEX ux_health_open ON health_events (kind, subject) WHERE closed_at IS NULL;
CREATE INDEX ix_health_time ON health_events (opened_at DESC);

CREATE TABLE notifications (
  id                  INTEGER PRIMARY KEY,
  alert_id            INTEGER REFERENCES price_alerts(id) ON DELETE CASCADE,            -- D-14: some com o alerta
  health_event_id     INTEGER REFERENCES health_events(id) ON DELETE CASCADE,
  observation_id      INTEGER REFERENCES price_observations(id) ON DELETE SET NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('PROXIMO','ATINGIDO','SAUDE')),
  idempotency_key     TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) = 64),         -- sha256 hex (RN-12)
  status              TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','ACEITO','FALHA')),
  mode                TEXT NOT NULL CHECK (mode IN ('real','teste')),
  simulated           INTEGER NOT NULL DEFAULT 0 CHECK (simulated IN (0,1)),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 4),   -- envios iniciados: inicial + 3 retentativas (contado ANTES do envio, no claim)
  next_attempt_at     TEXT CHECK (next_attempt_at IS NULL OR length(next_attempt_at) = 24),     -- também serve de lease (now+10 min) enquanto o envio está em andamento
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 200),
  accepted_at         TEXT CHECK (accepted_at IS NULL OR length(accepted_at) = 24),
  failure_reason      TEXT CHECK (failure_reason IS NULL OR length(failure_reason) <= 200),  -- código, nunca texto do provedor com PII
  -- snapshot do disparo: o e-mail é renderizado só destes campos (determinístico, sem reler a loja)
  product_code        TEXT,
  product_name        TEXT CHECK (product_name IS NULL OR length(product_name) <= 300),
  product_slug        TEXT,
  size                TEXT,
  price_cents         INTEGER CHECK (price_cents IS NULL OR price_cents > 0),
  target_cents        INTEGER CHECK (target_cents IS NULL OR target_cents > 0),
  margin_bp           INTEGER CHECK (margin_bp IS NULL OR margin_bp BETWEEN 0 AND 5000),
  observed_at         TEXT CHECK (observed_at IS NULL OR length(observed_at) = 24),
  source              TEXT CHECK (source IS NULL OR source IN ('occ','next_data','json_ld')),
  degraded            INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0,1)),
  already_in_band     INTEGER NOT NULL DEFAULT 0 CHECK (already_in_band IN (0,1)),
  created_at          TEXT NOT NULL CHECK (length(created_at) = 24),
  updated_at          TEXT NOT NULL CHECK (length(updated_at) = 24),
  CHECK ((kind = 'SAUDE') = (alert_id IS NULL)),
  CHECK ((kind = 'SAUDE') = (health_event_id IS NOT NULL)),
  CHECK (status <> 'ACEITO' OR accepted_at IS NOT NULL),
  CHECK (status <> 'FALHA'  OR failure_reason IS NOT NULL),
  CHECK (simulated = 0 OR mode = 'teste')
) STRICT;
-- Segunda barreira de idempotência: uma observação dispara um tipo uma única vez por alerta.
CREATE UNIQUE INDEX ux_notif_alert_obs_kind ON notifications (alert_id, observation_id, kind)
  WHERE alert_id IS NOT NULL AND observation_id IS NOT NULL;
CREATE INDEX ix_notif_due ON notifications (next_attempt_at) WHERE status = 'PENDENTE';
CREATE INDEX ix_notif_alert ON notifications (alert_id, created_at DESC);

CREATE TABLE catalog_items (
  code         TEXT PRIMARY KEY CHECK (length(code) BETWEEN 8 AND 20 AND code NOT GLOB '*[^A-Za-z0-9]*'),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  name_search  TEXT NOT NULL,                                   -- minúsculas sem acento, calculado em código
  last_slug    TEXT CHECK (last_slug IS NULL OR last_slug NOT GLOB '*[^a-z0-9-]*'),
  price_cents  INTEGER CHECK (price_cents IS NULL OR price_cents > 0),  -- só referência de listagem, não é histórico
  fetched_at   TEXT NOT NULL CHECK (length(fetched_at) = 24)
) STRICT;
CREATE INDEX ix_catalog_name ON catalog_items (name_search);

-- No máximo 1 corpo bruto por produto (RF-11-AC11); sobrescrito a cada falha, apagado na próxima leitura válida.
CREATE TABLE failure_samples (
  product_code  TEXT PRIMARY KEY REFERENCES products(code) ON DELETE CASCADE,
  run_id        INTEGER REFERENCES monitoring_runs(id) ON DELETE SET NULL,
  captured_at   TEXT NOT NULL CHECK (length(captured_at) = 24),
  http_status   INTEGER,
  content_type  TEXT CHECK (content_type IS NULL OR length(content_type) <= 100),
  body          TEXT NOT NULL CHECK (length(body) <= 262144)    -- 256 KiB, já sanitizado (sem cookie/UTM/fbclid)
) STRICT;

-- Toda requisição de saída (monitor, catálogo, cadastro por URL, sonda) deixa 1 linha: base do teto de 400/24 h (RNF-REL-04).
-- Escrita só pelo withRateGate. Poda > 7 dias em housekeeping (S); ~400 linhas/dia, irrelevante sem poda.
CREATE TABLE outbound_requests (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL CHECK (length(at) = 24),
  purpose TEXT NOT NULL CHECK (purpose IN ('monitor','catalog','discover','probe'))
) STRICT;
CREATE INDEX ix_outreq_at ON outbound_requests (at);

CREATE TABLE app_state (
  key        TEXT PRIMARY KEY CHECK (key IN
               ('circuit_open_until','circuit_reason','circuit_probe_pending',
                'catalog_last_refresh_at','scheduler_heartbeat_at','last_recovery_at')),
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
) STRICT;
```

`schema_migrations` não está no 0001: é criada pelo runner antes de qualquer migração (seção 6).

## 4. Constraints e decisões que o banco impõe

### 4.1 Mapa invariante -> mecanismo

| Invariante | Mecanismo |
|---|---|
| Nunca existe preço R$ 0 ou negativo (RN-04, RF-11-AC2) | `price_observations.current_cents > 0`, `<= original_cents` |
| Uma rodada por vez (RNF-REL-03) | índice único parcial `ux_runs_single_running` |
| Reprocessar a mesma observação não duplica notificação (RN-12, RF-10-AC1/AC10) | `notifications.idempotency_key UNIQUE` + `ux_notif_alert_obs_kind`; insert com `INSERT ... ON CONFLICT DO NOTHING` |
| Reprocessar a mesma rodada não duplica observação | `UNIQUE (run_id, variant_code, seq)` |
| Dois drains (ou duas instâncias) nunca enviam a mesma notificação | `claimDue` em `BEGIN IMMEDIATE` com `attempts++` e lease em `next_attempt_at` antes do envio |
| Orçamento de requisições vale para toda origem | `outbound_requests` escrita pelo `withRateGate` |
| Aviso de saúde 1x por episódio (RNF-OBS-03) | `ux_health_open` |
| Notificação de preço sempre ligada a alerta; de saúde nunca (RF-08) | `CHECK ((kind='SAUDE') = (alert_id IS NULL))` |
| `ACEITO` sempre tem instante; `FALHA` sempre tem motivo; simulado só em modo teste | CHECKs em `notifications` |
| Excluir alerta remove e-mail e notificações (D-14, RNF-PRIV-03) | `notifications.alert_id ON DELETE CASCADE`; o histórico fica |
| Não se apaga variante que tem alerta | `price_alerts.variant_code ON DELETE RESTRICT` |
| Código/slug/e-mail sem caracteres perigosos | `CHECK ... GLOB` em `code`/`last_slug`, `instr(email, char(10))` (defesa em profundidade; a validação principal é do código) |

### 4.2 Notas

1. **Chave de idempotência.** `idempotency_key = sha256_hex("{alert_id}|{revision}|{kind}|{episode}")` para `PROXIMO`/`ATINGIDO` (`episode` é o do tipo), e `sha256_hex("saude|{health_event_id}")` para `SAUDE`. O enunciado pede `(alert_id, observation_id/condição)`: a "condição" é `(revision, kind, episode)`; a observação que disparou é guardada em `observation_id` e protegida pelo segundo índice único.
2. **Episódio por tipo.** requirements fala em um `episodio`; aqui há `episode_proximo` e `episode_atingido` porque as travas são independentes (RN-11). Equivalente, mais preciso.
3. **`UNIQUE (variant_code, target_cents, margin_bp, email)`** é mais estrito que RF-09-AC7 (janela de 1 min): um alerta idêntico nunca é duplicado. Um alerta idêntico é inútil (mesmo e-mail, mesma condição); a UI devolve "alerta idêntico já existe". QA: testar a mensagem.
4. **Observação confirmada depois.** Uma leitura `confirmed=0` vira `1` quando uma leitura posterior concorda em centavos (RN-09c); `confirmed_by` aponta a leitura concordante. É o único `UPDATE` em `price_observations` (as demais colunas são imutáveis por convenção do repositório).
5. **Estado derivado, não persistido:** `faixa`, frescor, `com_falha` (`consecutive_failures >= 3`), `parser degradado` (`degraded_since IS NOT NULL`), idade (`now - last confirmed observed_at`). O que é calculado não pode ficar inconsistente.
6. **Margem 0.** `margin_bp = 0` é válido (faixa PROXIMO vazia).
7. **Sem tabela `users`.** Usuário único (D-29). Para deploy público a migração adiciona `users` e `price_alerts.user_id` (ver `security.md`, seção 8).

## 5. Consultas críticas e índices

| Consulta | Índice |
|---|---|
| Produtos a coletar: `products` com `EXISTS (alert ATIVO em alguma variante)` e `state='ativo'`, ordenados por `last_ok_at` mais antigo | `ix_alerts_variant_status`, PK de variantes |
| Última observação confirmada de uma variante (avaliação, frescor, dashboard) | `ix_obs_variant_confirmed` |
| Histórico da variante, mais recente primeiro | `ix_obs_variant_time` |
| Orçamento diário: `COUNT(*)` em `outbound_requests` nas últimas 24 h (todas as origens, não só rodadas) | `ix_outreq_at` |
| Notificações vencidas a enviar | `ix_notif_due` |
| Rodada em andamento / última rodada | `ix_runs_kind_started`, `ux_runs_single_running` |
| Busca de catálogo por nome (`LIKE '%q%' ESCAPE '\'` em `name_search`) | varredura de ~1.239 linhas; aceitável, índice só ordena |

RNF-PERF-02 (dashboard com 50 alertas e 10 mil observações < 1 s): o dashboard faz 1 consulta com `LEFT JOIN LATERAL`-equivalente (subconsulta correlacionada `ORDER BY observed_at DESC LIMIT 1` por variante) que usa `ix_obs_variant_confirmed`.

## 6. Migrações versionadas

- Arquivos `migrations/NNNN_nome.sql` (4 dígitos), imutáveis depois de aplicados. Só avançam (sem `down`); reverter = restaurar o backup.
- Runner `src/db/migrate.ts`, executado na partida de `main.ts` antes de abrir o servidor e pelo script `npm run db:migrate`.
- Tabela do runner (criada com `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL CHECK (length(checksum) = 64),   -- sha256 do arquivo
  applied_at TEXT NOT NULL
) STRICT;
```

- Algoritmo: ler diretório, ordenar por versão, exigir sequência sem buracos; para cada versão já aplicada comparar checksum (divergência = abortar a partida com mensagem clara: migração aplicada foi editada); para cada pendente, `BEGIN IMMEDIATE` -> `exec(sql)` -> `INSERT schema_migrations` -> `COMMIT`; falha = `ROLLBACK` e a aplicação não sobe.
- Antes de aplicar qualquer pendente em banco não vazio, `VACUUM INTO 'data/backups/vans-alert-pre-NNNN-<yyyymmddThhmmss>.db'` (cópia consistente com WAL). Retém os 5 últimos.
- Versão do banco maior que a do código (arquivo `migrations/` mais antigo que o aplicado) = recusa a partida (não rebaixa).
- Mudanças que SQLite não faz com `ALTER` (alterar CHECK) seguem o padrão "criar tabela nova, copiar, trocar, recriar índices", dentro da mesma migração, com `PRAGMA foreign_keys` tratado pelo runner (`defer_foreign_keys = ON` na transação).
- Teste (T-MIG): banco vazio -> 0001 aplicado; reexecutar é no-op; checksum adulterado aborta; esquema final igual ao DDL deste documento (comparação com `sqlite_schema`).

## 7. Políticas de exclusão e retenção

| Dado | Política | Como |
|---|---|---|
| Alerta | Exclusão física por ação do usuário (confirmação). Remove notificações do alerta (cascade). Histórico de preço permanece (D-14). | `DELETE FROM price_alerts` |
| E-mail do usuário | Só existe em `price_alerts.email`. Some com o alerta. Nunca copiado para logs, `run_items`, `health_events` ou `notifications`. `notifications` guarda snapshot de produto/preço, não de destinatário (resolvido do alerta no envio). SAUDE vai a `OWNER_EMAIL` lido do ambiente. | desenho do esquema |
| Notificações `PENDENTE` de alerta pausado > 24 h | viram `FALHA` com `failure_reason='alerta_pausado'` (RN-15) | job do `notifications` |
| Notificações `ACEITO`/`FALHA` | mantidas 180 dias; depois apagadas (S) | `housekeeping()` diário |
| `price_observations` | mantidas enquanto a variante tem alerta. Variante sem alerta há > 30 dias: observações apagadas (S). O que não pode: apagar enquanto há alerta (série do histórico). | `housekeeping()` |
| `monitoring_runs` / `run_items` | 90 dias; cascade apaga os itens | `housekeeping()` |
| `outbound_requests` | 7 dias (só o último dia importa) | `housekeeping()` |
| `failure_samples` | 1 por produto; apagado quando uma leitura válida chega; sempre sanitizado | `monitor.repo` |
| `health_events` | 180 dias | `housekeeping()` |
| `catalog_items` | substituído por inteiro em cada atualização bem-sucedida, numa transação; atualização falha mantém o anterior (RF-01-AC5) | `catalog.repo.replaceAll()` |
| Produtos/variantes | nunca apagados automaticamente (chaves de histórico). Removidos da loja ficam com `state='removido'`. | n/a |
| Backups de migração | 5 últimos; backup manual por cópia a frio (`operations.md`) | runner |

`housekeeping()` roda uma vez por dia na partida do primeiro tick do `scheduler` (lógica em cada `*.repo.ts`, orquestração em `scheduler/housekeeping.ts`). É melhoria **S**: o MVP funciona sem ela, e o volume (50 produtos x ~15 variantes x 6 leituras/dia ≈ 4.500 linhas/dia) leva anos para incomodar. Nota: observação é por variante *monitorada*; coletar um produto grava as variantes que têm alerta, não todos os tamanhos (menos linhas, menos ruído). Variantes sem alerta ainda têm `product_variants` para a tela de escolha, atualizada a cada leitura (`last_seen_at`).

Decisão registrada: o histórico guarda observação só das variantes com alerta (ou que já tiveram), porque RF-07 é "histórico do alerta". Se o dono quiser a série de todos os tamanhos, é uma opção em `monitor.service` (`recordAllVariants`), sem mudar o esquema.
