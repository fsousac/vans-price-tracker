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
