# Arquitetura: Vans Price Watcher

Versão 0.1 (2026-10-14). Base: `docs/requirements.md` (RF/RN/RNF), `docs/investigation.md`. Dados: `docs/data-model.md`. Decisões: `docs/adr/`. Segurança: `docs/security.md`.

> **ADR-0006 (2026-10-15): o produto agora é uma extensão MV3.** Os contratos de domínio (3.1-3.6) continuam; servidor, web, SQLite, SMTP e agendador em processo foram substituídos por `docs/extension-architecture.md`, que prevalece em conflito.

## 1. Stack e evidência do ambiente

Verificado em 2026-10-14 nesta máquina (Windows 11), com um projeto-sonda fora do repositório.

| Camada | Escolha | Evidência / motivo |
|---|---|---|
| Runtime | Node 24.14, ESM | `node -v` = 24.14.0. `fetch`, `node:test`, `node:https`, `node:crypto`, `node:zlib` embutidos. |
| Linguagem | TypeScript 7 estrito, **sem etapa de build**: `node src/main.ts` | Verificado: Node 24 executa `.ts` direto (remoção de tipos, sem flag, sem aviso) importando `better-sqlite3` e `hono`. `tsc --noEmit` (v7.0.2) é só o portão de tipos. Regra: sintaxe apagável (`erasableSyntaxOnly`: sem `enum`, sem parameter properties, sem `namespace`) e imports relativos com `.ts`. Sem `tsx`, sem `ts-node`, sem `dist/`. |
| Banco | SQLite via **`better-sqlite3` 13** | Requisito pede driver estável. `node:sqlite` exige aviso: verificado `ExperimentalWarning: SQLite is an experimental feature and might change at any time` em 24.14. `better-sqlite3` instalou sem compilar (`prebuilds/win32-x64.node` no pacote), rodou em 24.14 com SQLite 3.53 e API síncrona (casa com transações curtas). Risco R-15 evitado, não só isolado. |
| Web | **Hono 4** + `@hono/node-server` | Middlewares embutidos que cobrem requisitos sem plugin extra: `hono/csrf` (Origin), `hono/secure-headers` (CSP), `hono/html` (escape automático de interpolação). Teste sem porta: `app.request()`. 2 pacotes. Alternativas em ADR-0001. |
| UI | HTML renderizado no servidor, formulários `POST` + redirect (PRG), **1 CSS**, **zero JS no cliente** no MVP | RNF-ACC-01: semântica nativa (`label`, `fieldset`, `table`, `details`) dá teclado e leitor de tela de graça. Responsivo por CSS (`grid`, `clamp`), tema claro/escuro por `prefers-color-scheme`. Sem framework (nada na investigação exige SPA). Gráfico é S. |
| Coleta HTTP | `node:https` (stdlib) com `lookup` customizado | Precisamos validar o IP resolvido e usá-lo na conexão (anti-rebinding), revalidar cada redirect e limitar corpo/tempo. `fetch` não expõe o `lookup` sem depender do pacote `undici`; `https.request` expõe e é stdlib. Playwright não é necessário (investigation 1, 5). |
| E-mail | `nodemailer` (SMTP) + provedores `simulated` (padrão) e `fake` (testes) | RNF-SEC-05, D-16. Único cliente SMTP maduro; escapa cabeçalhos. |
| Agendador | Laço in-process, estado em SQLite (ADR-0004) | D-13: só roda com o app aberto; sem Redis/cron externo. |
| Testes | `node:test` + `node:assert/strict` + cobertura nativa | Sem Jest/Vitest. Propriedade: PRNG semeado próprio (sem `fast-check`). Ver `testing.md`. |
| Logs | JSON em stdout, módulo próprio de ~40 linhas com campos permitidos por tipo | RNF-OBS-01, RNF-PRIV-01 (PII fora por construção). |

Dependências de produção (4): `hono`, `@hono/node-server`, `better-sqlite3`, `nodemailer`. Desenvolvimento (4): `typescript`, `@types/node`, `@types/better-sqlite3`, `@types/nodemailer`. Sem ORM, sem validador de esquema (a validação de entrada é pequena e escrita à mão com testes de tabela), sem lint/formatter obrigatório (`tsc` estrito é o portão; ponto aberto).

Fora de escopo, deliberadamente: Redis, filas externas, microserviços, Kubernetes, Docker obrigatório (Docker 29.3 existe na máquina; um `Dockerfile` é opcional e não entra no MVP), Python (3.14: risco de wheels, investigation 7), Playwright.

## 2. Estrutura de diretórios

```
vans-alert/
├── package.json              # "type": "module"; scripts: start, dev, typecheck, test, test:cov, test:live, db:migrate
├── tsconfig.json             # strict, noEmit, erasableSyntaxOnly, allowImportingTsExtensions, verbatimModuleSyntax
├── .env.example              # sem valores reais (RNF-SEC-05)
├── .gitignore                # .env, data/, node_modules/
├── migrations/
│   └── 0001_init.sql         # DDL de docs/data-model.md
├── public/
│   └── app.css               # único asset estático
├── scripts/
│   ├── sanitize-fixtures.ts  # remove fbclid/UTM/cookies das fixtures (C10)
│   └── capture-fixtures.ts   # captura ao vivo manual, ritmo lento, não roda em testes
├── data/                     # (ignorado) vans-alert.db, backups/, outbox/ (só com sink de arquivo)
├── src/
│   ├── main.ts               # raiz de composição: config -> db -> migrate -> módulos -> scheduler -> web
│   ├── config.ts             # leitura e validação do ambiente (falha rápida)
│   ├── shared/               # sem dependência de módulos de negócio
│   │   ├── clock.ts          # interface Clock, SystemClock
│   │   ├── random.ts         # interface Random (jitter), SystemRandom
│   │   ├── result.ts         # Result<T,E>, ok(), err()
│   │   ├── money.ts          # parseBrlToCents, valueToCents, formatBrl, percentOff
│   │   ├── hash.ts           # sha256Hex
│   │   ├── mask.ts           # maskEmail, stripControl
│   │   ├── freshness.ts      # freshness(lastConfirmedAt, now, intervalMs) pura (usada por price-history, web e observability)
│   │   ├── price-compare.ts  # classifyBand (pura; usada por alerts e pelo painel, por isso fica em shared)
│   │   └── types.ts          # ProductCode, VariantCode, Cents, IsoUtc, SourceName, FailureClass
│   ├── db/
│   │   ├── connection.ts     # abre better-sqlite3, PRAGMAs, helper transaction()
│   │   └── migrate.ts        # runner versionado (+ migrate-cli.ts)
│   ├── observability/
│   │   ├── logger.ts         # logger JSON com LogFields permitidos
│   │   ├── health.ts         # monta o payload de /saude a partir do banco
│   │   ├── events.repo.ts    # health_events (abre/fecha episódio, 1 aviso por episódio)
│   │   └── state.repo.ts     # app_state (circuito, heartbeat, último refresh do catálogo)
│   ├── catalog/
│   │   ├── ports.ts          # CatalogSource, CatalogRepo
│   │   ├── catalog.source.ts # OCC /products/search?category=SAPATOS (via HttpClient)
│   │   ├── catalog.parser.ts # JSON de listagem -> CatalogItem[] (ignora item sem code/preço)
│   │   ├── catalog.repo.ts
│   │   └── catalog.service.ts# busca local, atualização (1/24 h, cortesia)
│   ├── price-monitor/
│   │   ├── ports.ts          # PriceSource, HttpClient, ProductRepo, RunRepo, tipos de snapshot/falha
│   │   ├── url.ts            # extractProductCode(url): só o code, nunca busca a URL
│   │   ├── sanitize.ts       # sanitizeBody (cookies, UTM, fbclid, tokens); usado por failure_samples e por scripts/sanitize-fixtures.ts
│   │   ├── http/safe-http.ts # SafeHttpClient: allowlist, DNS/IP, redirects, limites
│   │   ├── http/rate-gate.ts # withRateGate(HttpClient): serializa (1 em voo) e espaça 2-5 s + jitter TODA requisição de saída, de qualquer origem; registra em outbound_requests
│   │   ├── normalize.ts      # valor -> centavos, preço efetivo, disponibilidade (funções puras)
│   │   ├── occ.source.ts     # fonte primária
│   │   ├── nextdata.source.ts# fallback 1
│   │   ├── jsonld.source.ts  # fallback 2 (S, FORA do MVP: sem preço "de", sem estoque numérico; não implementar agora)
│   │   ├── composite.source.ts # primária -> fallback, regras de quando cair
│   │   ├── fake.source.ts    # FakeSource / FakeHttpClient para testes (exportado para tests/)
│   │   ├── confirm.ts        # decideConfirmation (pura)
│   │   ├── monitor.repo.ts   # products, variants, runs, run_items, failure_samples
│   │   └── monitor.service.ts# processa 1 produto: fetch -> persistir -> avaliar -> notificar
│   ├── price-history/
│   │   ├── ports.ts          # ObservationRepo
│   │   ├── history.repo.ts   # price_observations
│   │   └── history.service.ts# série, mín/máx (só confirmadas); frescor via shared/freshness
│   ├── alerts/
│   │   ├── ports.ts          # AlertRepo
│   │   ├── validation.ts     # alvo, margem, e-mail
│   │   ├── evaluate.ts       # evaluateAlert (pura): faixa x travas -> decisão
│   │   ├── alerts.repo.ts
│   │   └── alerts.service.ts # criar/editar/pausar/retomar/excluir + aplicar decisão em transação
│   ├── notifications/
│   │   ├── ports.ts          # Mailer, NotificationRepo, OutgoingEmail, MailResult
│   │   ├── render.ts         # snapshot -> OutgoingEmail (texto + HTML escapado), fuso SP
│   │   ├── mailer.simulated.ts # modo teste: não abre conexão
│   │   ├── mailer.smtp.ts    # nodemailer
│   │   ├── mailer.fake.ts    # gravador para testes
│   │   ├── notifications.repo.ts
│   │   └── notifications.service.ts # outbox: estados, retentativas, reenviar, idempotência
│   ├── scheduler/
│   │   ├── scheduler.ts      # laço, due?, recuperação, heartbeat
│   │   ├── runner.ts         # executa uma rodada de monitoramento
│   │   ├── circuit.ts        # disjuntor global (puro + persistência via state.repo)
│   │   ├── backoff.ts        # atrasos de retentativa e cortesia + jitter (puro)
│   │   └── housekeeping.ts   # retenção (S)
│   └── web/
│       ├── server.ts         # cria o Hono app (middlewares, rotas) e o listen
│       ├── middleware.ts     # host-guard, csrf, secure-headers, erro genérico
│       ├── routes/           # index.ts, dashboard.ts, catalog.ts, product.ts, alerts.ts, health.ts
│       └── views/            # layout.ts, components.ts, dashboard.ts, catalog.ts, product.ts, alert-form.ts, history.ts
└── tests/
    ├── helpers/              # clock.ts (ManualClock), db.ts (banco temporário), no-network.ts, fixtures.ts, prng.ts
    ├── fixtures/vans/        # já existe (investigação)
    ├── unit/  contract/  integration/  e2e/  security/  live/
    └── ...
```

Regras de fronteira (verificadas por teste `tests/unit/boundaries.test.ts`, que varre os imports):

1. `shared/` não importa de nenhum módulo. `db/` só de `shared/`.
2. Cada módulo de negócio expõe só `ports.ts`, os `*.service.ts` e as funções puras; **`*.repo.ts` é privado ao módulo** e só é instanciado em `main.ts`. SQL só em `*.repo.ts` (e `db/`). Exceção declarada: consultas **somente leitura** que juntam tabelas de outro módulo sem importar código dele (`monitor.repo.dueForCollection` lê `price_alerts`; `observability/health.repo.ts` agrega runs, observações e notificações).
3. Dependências permitidas (setas = "pode importar"): `alerts -> {shared}` (inclui `shared/price-compare`); `price-history -> {shared}`; `notifications -> {shared, observability(logger)}`; `price-monitor -> {shared, price-history, alerts, notifications, observability}`; `catalog -> {shared, price-monitor/ports (HttpClient)}`; `scheduler -> {price-monitor, notifications, catalog, observability, shared}`; `web -> {todos os services, nunca repos}`; `observability -> {shared}`.
4. `price-monitor/monitor.service` é o único orquestrador do ciclo de um produto (ele chama `alerts.apply` e `notifications.enqueue` por interface, dentro da transação aberta por ele).
5. Nada fora de `price-monitor/http/safe-http.ts` abre conexão de rede de saída (exceto `mailer.smtp.ts`, que só é instanciado com `EMAIL_MODE=real`). Teste de segurança grep: `node:https`, `node:http`, `node:net`, `fetch(`, `nodemailer` só nesses arquivos.

## 3. Contratos TypeScript

Assinaturas normativas. Pequenas variações de nome são aceitáveis na implementação; a forma e as garantias não.

### 3.1 Tipos base (`shared/types.ts`)

```ts
export type Cents = number;                       // inteiro >= 0 (Number.isSafeInteger); ADR-0003
export type BasisPoints = number;                 // inteiro 0..5000
export type IsoUtc = string;                      // '2026-10-14T12:00:00.000Z'
export type ProductCode = string;                 // '1003800580026U' (validado: [A-Za-z0-9]{8,20})
export type VariantCode = string;                 // '1003800580026U-34'
export type SourceName = 'occ' | 'next_data' | 'json_ld';

export type FailureClass =
  | 'rede_timeout' | 'http_5xx' | 'http_429' | 'http_403_ou_desafio'
  | 'produto_removido' | 'formato_desconhecido' | 'preco_invalido' | 'host_nao_autorizado';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
```

### 3.2 Relógio e aleatório (`shared/clock.ts`, `shared/random.ts`)

```ts
export interface Clock {
  now(): Date;                                        // única fonte de tempo do sistema
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export interface Random { next(): number }            // [0,1); jitter e testes determinísticos
```

`SystemClock` usa `Date`/`setTimeout`. `ManualClock` (tests/helpers) tem `advance(ms)`, que resolve os `sleep` vencidos na ordem. Nenhum código de negócio chama `Date.now()`, `new Date()` ou `setTimeout` diretamente (teste de varredura).

### 3.3 Coletor (`price-monitor/ports.ts`)

```ts
export interface HttpClient {                          // única porta de rede de saída
  get(req: { url: URL; headers?: Record<string, string>; accept: 'json' | 'html' }): Promise<HttpResult>;
}
export type HttpResult =
  | { ok: true; status: number; body: string; contentType: string; retryAfterMs?: number }
  | { ok: false; failure: FailureClass; status?: number; retryAfterMs?: number; body?: string };
  // 4xx/5xx chegam como ok:false com a classe; 404/400 do OCC => 'produto_removido' só no source (conhece o contrato)

export interface VariantSnapshot {
  variantCode: VariantCode;
  size: string;
  ean: string | null;
  originalCents: Cents;            // price.value (RN-02)
  currentCents: Cents;             // discountPrice.value>0 ? : price.value (RN-03); sempre >0 e <= original
  available: boolean;              // sellable && stockLevel>0 (RN-06); JSON-LD: InStock
}
export interface ProductSnapshot {
  code: ProductCode;
  name: string;
  slug: string | null;             // decorativo
  legacySku: string | null;
  source: SourceName;
  degraded: boolean;               // true para qualquer fonte != 'occ' (RN-09a)
  fetchedAt: IsoUtc;
  variants: VariantSnapshot[];     // >=1; sem variantes => falha formato_desconhecido (nunca lista vazia "ok")
  skippedVariants: number;         // variantes com preço inválido (RN-04), contadas, não gravadas
}
export interface Failure { class: FailureClass; httpStatus?: number; retryAfterMs?: number; rawBody?: string }

export type SourceResult =
  | { ok: true; snapshot: ProductSnapshot; httpStatus: number; requests: number }
  | { ok: false; failure: Failure; requests: number };

export interface PriceSource {                         // "coletor atrás de interface substituível" (RNF-MNT-01)
  readonly name: SourceName | 'composite' | 'fake';
  fetchProduct(code: ProductCode): Promise<SourceResult>;
}
```

Implementações: `OccSource` (GET `/arezzocoocc/v2/vans/products/{code}`), `NextDataSource` (GET `/{slug|p}/p/{code}` e leitura de `__NEXT_DATA__` -> `props.pageProps.product`), `JsonLdSource` (S, fora do MVP), `CompositeSource` (ordem OCC -> next_data), `FakeSource` (fixture por código ou falha programada). Todas recebem `HttpClient` e `Clock`; nenhuma importa `node:https`. `JsonLdSource` está fora do MVP (a ordem do composite é OCC -> next_data).

Regras do `CompositeSource` (de RN-18, investigation 8):
- Cai para o próximo só em `rede_timeout`, `http_5xx`, `formato_desconhecido`. **Nunca** em `http_403_ou_desafio` ou `http_429` (seria insistir contra bloqueio) nem em `produto_removido` ou `host_nao_autorizado`.
- Precedência de classificação (`SafeHttpClient`/sources): `cf-mitigated` ou corpo de desafio vence o status (um `503` com desafio é `http_403_ou_desafio`: sem retentativa, sem fallback). O cliente nunca guarda nem reenvia cookies (o OCC devolve `Set-Cookie: JSESSIONID` até no 400); `Content-Type` é comparado só pelo tipo, ignorando parâmetros (`text/html; charset=utf-8`).
- Resultado de fallback sempre `degraded: true`. O fallback consome requisição do orçamento (`requests` soma).
- Na URL de HTML sem slug (`/p/{code}`), a loja responde 301; o `SafeHttpClient` o segue (mesmo host, revalidado). Uma URL de produto montada pelo sistema usa o `last_slug` conhecido, senão `/p/{code}`.

Parser OCC (de `occ_disc_1003800580026U.json`): `baseOptions[0].options[]` para variantes (`code`, `displayText`, `ean`, `priceData`/`discountPrice`, `sellable`, `stock.stockLevel`); preço do produto no topo (`price`, `discountPrice`). Ausência de `baseOptions[0].options` ou lista vazia = `formato_desconhecido`; `code` da resposta diferente do solicitado, ou `code` de variante que não começa com `{code}-`, também = `formato_desconhecido` (nunca deixar chegar à `CHECK` do banco). `stock`/`stockLevel` ausente = variante indisponível, sem erro. O parser OCC não segue redirect (3xx = `formato_desconhecido`). Variante ausente numa leitura válida não gera observação; o frescor (RN-17) a cobre. O corpo `400 UnknownIdentifierError` (`occ_404.json`) = `produto_removido`. Não ler `formattedValue`, `percentualOfDiscount`, `stockLevelStatus`, `purchasable`, `stock` do topo.

### 3.4 Funções puras de negócio

```ts
// shared/price-compare.ts  (RNF-PERF-03: sem I/O, inteiros; em shared porque alerts/evaluate.ts o usa e alerts só pode importar shared)
export type Band = 'ATINGIDO' | 'PROXIMO' | 'ACIMA';
export function classifyBand(priceCents: Cents, targetCents: Cents, marginBp: BasisPoints): Band;
// P<=T -> ATINGIDO; P*10000 <= T*(10000+bp) -> PROXIMO; senão ACIMA. Max ~1.5e11 << 2^53: sem BigInt.

// shared/money.ts
export function valueToCents(value: unknown): Result<Cents, 'preco_invalido'>;      // RN-01
export function parseBrlToCents(input: string): Result<Cents, TargetError>;          // RN-10, D-07
export function formatBrl(cents: Cents): string;                                     // 'R$ 1.234,56'
export function percentOff(originalCents: Cents, currentCents: Cents): number;       // inteiro arredondado

// price-monitor/confirm.ts  (RN-09)
export interface ConfirmInput {
  candidate: { currentCents: Cents; source: SourceName; observedAt: IsoUtc };
  lastConfirmed: { currentCents: Cents } | null;
  pendingUnconfirmed: { id: number; currentCents: Cents } | null;   // leitura anterior ainda não confirmada
}
export type ConfirmDecision =
  | { confirmed: true; confirmsPendingId?: number }
  | { confirmed: false; reason: 'variacao_maior_70pct' | 'fonte_fallback_sem_par' };
export function decideConfirmation(i: ConfirmInput): ConfirmDecision;

// alerts/evaluate.ts  (RN-11..16)
export interface AlertState {
  id: number; revision: number; status: 'ATIVO' | 'PAUSADO';
  targetCents: Cents; marginBp: BasisPoints;
  armedProximo: boolean; armedAtingido: boolean;
  episodeProximo: number; episodeAtingido: number;
  rearmNotBeforeProximo: IsoUtc | null; rearmNotBeforeAtingido: IsoUtc | null;
  evaluatedOnce: boolean;
}
export interface ObservationView {
  id: number; currentCents: Cents; available: boolean; confirmed: boolean; observedAt: IsoUtc;
}
export type Decision = {
  fire: null | { kind: 'PROXIMO' | 'ATINGIDO'; episode: number; alreadyInBand: boolean };
  next: Pick<AlertState, 'armedProximo' | 'armedAtingido' | 'episodeProximo' | 'episodeAtingido'
                       | 'rearmNotBeforeProximo' | 'rearmNotBeforeAtingido' | 'evaluatedOnce'>;
  reason: 'inativo' | 'nao_confirmada' | 'indisponivel' | 'fora_da_faixa' | 'travado' | 'disparo' | 'rearmado';
};
export function evaluateAlert(a: AlertState, o: ObservationView, now: Date, cooldownMs: number): Decision;
```

Regras de `evaluateAlert`, na ordem: (1) `PAUSADO` -> sem efeito; (2) `!o.confirmed` -> sem efeito (nem dispara nem rearma, RN-16); (3) calcula `band`; (4) rearme (RN-13) depende só do preço confirmado: trava `atingido` reabre com `P > T`, trava `proximo` com `P > T*(1+M)`, ambas respeitando `rearmNotBefore*` e incrementando o episódio do tipo; disponibilidade não entra, então "indisponível com preço ainda na faixa" não rearma (o preço não saiu da faixa); (5) disparo exige `available`, trava aberta e faixa do tipo; `ATINGIDO` fecha as duas travas; (6) a primeira avaliação marca `evaluatedOnce` e define `alreadyInBand`. A função devolve o novo estado; quem persiste é `alerts.service.apply()`.

### 3.5 E-mail (`notifications/ports.ts`)

```ts
export interface OutgoingEmail {
  to: string;                       // validado (sem CR/LF/vírgula)
  subject: string;                  // gerado de modelo fixo + valores controlados
  text: string;                     // alternativa principal
  html: string;                     // toda interpolação escapada
  idempotencyKey: string;           // vai no header Message-ID derivado, para rastreio; não garante dedupe no provedor
}
export type MailResult =
  | { kind: 'accepted'; providerMessageId: string }
  | { kind: 'temporary_error'; reason: string }     // rede, 4xx SMTP 4yz
  | { kind: 'permanent_error'; reason: string };    // 5yz, credencial, destinatário inválido
export interface Mailer {
  readonly mode: 'real' | 'teste';
  send(msg: OutgoingEmail): Promise<MailResult>;     // nunca lança por erro de provedor; lança só por bug
}
```

`SimulatedMailer` (padrão, `EMAIL_MODE=test`): devolve `accepted` com id `simulated:{n}`, **não abre conexão**, loga só `{kind, alert_id, price_cents}`; sink opcional `EMAIL_TEST_SINK=file` grava `.eml` em `data/outbox/{notification_id}.eml` (contém PII local; desligado por padrão; nome de arquivo só do id numérico). `SmtpMailer` (`EMAIL_MODE=real`). `FakeMailer` (tests): lista `sent`, respostas programáveis, e um modo "falha se chamado".

### 3.6 Repositórios (síncronos, `better-sqlite3`)

Repositórios são síncronos porque o driver é síncrono; serviços que misturam rede e banco **nunca seguram transação durante um `await`** (toda transação é um bloco síncrono).

```ts
export type Tx = <T>(fn: () => T) => T;          // db.transaction(fn)(): IMMEDIATE, reentrante via savepoint

export interface ProductRepo {
  upsertProduct(p: { code: ProductCode; name: string; legacySku: string | null; slug: string | null }, now: IsoUtc): void;
  upsertVariants(code: ProductCode, vs: { variantCode: VariantCode; size: string; ean: string | null }[], now: IsoUtc): void;
  get(code: ProductCode): ProductRow | null;
  listVariants(code: ProductCode): VariantRow[];
  dueForCollection(now: IsoUtc, minIntervalMs: number): ProductCode[];        // com alerta ATIVO, state='ativo', respeita 2 h
  recordSuccess(code: ProductCode, o: { degraded: boolean; now: IsoUtc }): void;   // zera falhas, degraded_since
  recordFailure(code: ProductCode, f: { class: FailureClass; now: IsoUtc }): { consecutiveFailures: number; notFoundStreak: number; state: ProductState };
  setState(code: ProductCode, s: ProductState, now: IsoUtc): void;
  saveFailureSample(code: ProductCode, s: { runId: number; capturedAt: IsoUtc; httpStatus?: number; contentType?: string; body: string }): void; // já sanitizado
  clearFailureSample(code: ProductCode): void;
}
export interface RunRepo {
  tryStart(kind: 'monitor' | 'catalog', trigger: RunTrigger, now: IsoUtc): { runId: number } | { skipped: 'anterior_em_andamento' };
  recordSkipped(kind: RunKind, trigger: RunTrigger, reason: SkipReason, now: IsoUtc): void;
  addItem(runId: number, item: RunItemInput): void;
  finish(runId: number, summary: RunSummary, now: IsoUtc): void;
  markInterruptedOnStartup(now: IsoUtc): number;                               // running -> interrupted E finished_at = now (a CHECK exige)
  lastFinished(kind: RunKind): RunRow | null;
  // orçamento: ver RequestLog abaixo (não depende de rodada nem de run_items)
  lastSuccessfulItemAt(code: ProductCode): IsoUtc | null;
}
export interface RequestLog {                                                // tabela outbound_requests; escrita só pelo withRateGate
  record(purpose: 'monitor' | 'catalog' | 'discover' | 'probe', now: IsoUtc): void;
  countSince(since: IsoUtc): number;                                          // teto 400/24 h de QUALQUER origem (RNF-REL-04)
}
export interface ObservationRepo {                                            // price-history/ports.ts
  insert(o: NewObservation): number;                                           // lança em UNIQUE(run_id,variant_code,seq): idempotente via try/ignore
  confirm(id: number, confirmedBy: number): void;
  latestConfirmed(v: VariantCode): ObservationRow | null;
  latestUnconfirmed(v: VariantCode): ObservationRow | null;
  history(v: VariantCode, limit: number, offset: number): ObservationRow[];
  stats(v: VariantCode): { minCents: Cents; maxCents: Cents; count: number } | null;   // só confirmadas (RF-07-AC5)
}
export interface AlertRepo {
  create(a: NewAlert, now: IsoUtc): number;                                    // erros tipados: AlertDuplicate (UNIQUE), VariantNotFound (FK)
  get(id: number): AlertRow | null;
  list(): AlertRow[];
  activeByProduct(code: ProductCode): AlertRow[];
  update(id: number, patch: AlertPatch, now: IsoUtc): void;
  applyDecision(id: number, next: Decision['next'], fire: Decision['fire'], now: IsoUtc): void;
  delete(id: number): void;                                                    // cascade em notifications
}
export interface NotificationRepo {
  insertIfAbsent(n: NewNotification): { id: number; created: boolean };        // ON CONFLICT(idempotency_key) DO NOTHING
  claimDue(now: IsoUtc, limit: number): NotificationRow[];                     // 1 TX IMMEDIATE: PENDENTE, next_attempt_at <= now, alerta ATIVO (ou SAUDE); faz attempts++ e next_attempt_at = now+10 min (lease) ANTES de devolver: dois drains ou dois processos nunca pegam a mesma linha
  markAccepted(id: number, r: { providerMessageId: string; now: IsoUtc; simulated: boolean }): void;      // no-op se a linha sumiu (alerta excluído durante o envio)
  markAttemptFailed(id: number, r: { nextAttemptAt: IsoUtc | null; reason: string; now: IsoUtc }): void; // null => FALHA
  resend(id: number, now: IsoUtc): boolean;                                    // FALHA -> PENDENTE (mesma chave)
  listForAlert(alertId: number): NotificationRow[];
}
export interface CatalogRepo { replaceAll(items: CatalogItem[], now: IsoUtc): void; search(q: string, limit: number): CatalogItem[]; count(): number }
export interface HealthEventRepo { open(kind: HealthKind, subject: string, detail: string | null, now: IsoUtc): { id: number; created: boolean }; close(kind: HealthKind, subject: string, now: IsoUtc): void }
export interface StateRepo { get(key: StateKey): string | null; set(key: StateKey, value: string, now: IsoUtc): void; delete(key: StateKey): void }
```

## 4. Fluxo de um ciclo de monitoramento

Dono: `scheduler/runner.ts` (rodada) + `price-monitor/monitor.service.ts` (produto).

```
scheduler.tick()                                  (a cada 30 s; barato: 1-2 SELECTs; NUNCA espera a rodada: ela roda em segundo plano, `inflight = runner.run().finally(...)`, para que heartbeat e drain continuem enquanto coleta)
 ├─ heartbeat -> app_state.scheduler_heartbeat_at
 ├─ circuito aberto e circuit_open_until > now?  -> nada (status 'pausado_circuito')
 ├─ há rodada running (processo vivo)?  -> não inicia; recordSkipped('anterior_em_andamento') no máximo 1x por intervalo I
 ├─ due? = (última rodada monitor NÃO pulada começou há >= I) OU (partida e rodada de recuperação ainda não feita)
 └─ runner.runMonitoringRound(trigger)

runner.runMonitoringRound
 1. RunRepo.tryStart('monitor')                   -- índice único garante 1 rodada; senão skipped
 2. products = dueForCollection(now, 2h)           -- só com alerta ATIVO, state='ativo', >=2 h desde a última leitura boa;
                                                      ordem: last_ok_at mais antigo primeiro (justiça sob orçamento/queda)
    se vazio -> registrada como skipped com skip_reason='sem_alertas_ativos' (a CHECK do banco liga skip_reason a status='skipped')
 3. se circuito estava aberto e venceu: sonda = 1º produto (half-open); falha -> reabre +24 h (sem novo aviso)
 4. para cada produto (sequencial, 1 req por vez):
      a. orçamento: requestLog.countSince(now-24h) >= 400 -> item 'pulado: orcamento_diario', próximos idem
      b. cortesia: NÃO é do runner; o RateGate (decorador do HttpClient) serializa e espaça 2-5 s + jitter toda requisição, inclusive as de cadastro por URL, catálogo e sonda disparadas pela web
      c. result = withRetry(source.fetchProduct(code))     -- backoff.ts: <=2 retentativas; respeita Retry-After (teto 60 s)
      d. monitor.service.processResult(runId, code, result)   -- ver abaixo
      e. circuit.record(result): 403/desafio, 2x 429 ou 3 falhas de transporte seguidas -> abre circuito 24 h, aborta a rodada; 3 produtos seguidos com formato_desconhecido/preco_invalido -> encerra a rodada 'partial' + health_events('formato_desconhecido','global'), sem circuito
 5. RunRepo.finish(status: ok | partial | failed)

monitor.service.processResult  (NENHUM await dentro da transação; o estado dos alertas é LIDO DENTRO da TX, nunca antes do fetch: o usuário pode ter editado/pausado/excluído durante a rede)
 ── sucesso ───────────────────────────────────────────────────────────────────────────────
   TX {
     upsertProduct + upsertVariants (nome/slug/legacySku/variantes; nome saneado)
     recordSuccess(code, degraded)                            -- zera consecutive_failures e not_found_streak
     clearFailureSample(code)
     para cada variante COM alerta ATIVO (ou já observada):
        pend = latestUnconfirmed(v); last = latestConfirmed(v)
        dec  = decideConfirmation({candidate, last, pend})
        id   = observation.insert({... confirmed: dec.confirmed, degraded})
        se dec.confirmsPendingId: observation.confirm(pend.id, id)
        se confirmed (esta ou a pendente anterior):
           para cada alerta ATIVO da variante:
              d = evaluateAlert(alertState, obsView, now, cooldown)
              alerts.applyDecision(alert.id, d.next, d.fire)
              se d.fire: notifications.insertIfAbsent({ key: sha256(alert|revisão|tipo|episódio), snapshot })
     se degraded: health.open('parser_degradado', code)  | senão: health.close(...)
     se havia 'com_falha'/'removido-pendente': health.close(...)
     run_items.add({ outcome: ok|degradado, source, http_status, requests, duration })
   }
   -- Falha de qualquer passo dentro do TX => ROLLBACK total: nada de observação sem avaliação nem trava sem notificação (RNF-REL-02, T-SM-03)
   -- Violação de CHECK/FK causada por DADO da loja (nome > 300, tamanho > 10 etc.) é capturada por try/catch ao redor da TX e tratada como falha formato_desconhecido (2ª TX de falha); nunca derruba a rodada nem deixa o produto em laço de exceção
 ── falha ─────────────────────────────────────────────────────────────────────────────────
   TX {
     recordFailure(code, class) -> { consecutiveFailures, notFoundStreak, state }
     saveFailureSample (corpo sanitizado, <=256 KiB) para formato_desconhecido/preco_invalido/5xx com corpo
     produto_removido e notFoundStreak>=2  -> setState('removido') + health.open('produto_removido') + notificação SAUDE
     consecutiveFailures>=3 (não removido) -> health.open('produto_com_falha') + notificação SAUDE (1 por episódio, pelo índice único)
     run_items.add({ outcome: 'falha', failure_class })
     -- NENHUMA linha em price_observations; último preço confirmado fica como estava; zero alerta (RF-11-AC1)
   }

depois da rodada (fora do TX, por tick do scheduler):
 notifications.service.drain(now):  claimDue -> render -> mailer.send -> markAccepted | markAttemptFailed
```

Pontos de atenção:

- **Concordância entre fontes (RF-06-AC8).** Em produção o fallback só é consultado quando o OCC falha, então não existe divergência observável por rodada (a coluna `divergence` foi removida). A concordância OCC x SSR é vigiada por teste de contrato (T-MON-07) e pelo teste live.
- **Releitura para confirmar.** Quando uma leitura **do OCC** não é confirmada, no máximo 1 releitura na mesma rodada (após o RateGate, se houver orçamento) a confirma ou não; ela é uma 2ª chamada de `processResult` (TX própria) com `seq=2`, e a leitura pendente é achada por `latestUnconfirmed` (só vale se mais nova que a última confirmada). Leitura de fallback nunca é relida na hora (o cache SSR devolveria o mesmo dado): espera a rodada seguinte. A releitura fica atrás de `CONFIRM_REREAD=1` (padrão 1, 1 extra por produto suspeito). Ver "ponto aberto" na seção 10.
- **Faixa PROXIMO e disponibilidade.** Observação `available=false` é gravada normalmente (RN-08), nunca dispara, e não rearma por indisponibilidade.
- **Alerta recém-criado.** `alerts.service.create` não dispara nada; a avaliação ocorre na próxima observação confirmada (D-09), com `evaluated_once=0` => `alreadyInBand=true`. A tela de criação mostra o preço da última observação (ou "sem leitura ainda").

## 5. Tratamento de falhas e backoff

| Classe | Origem | Por item | Efeito global |
|---|---|---|---|
| `rede_timeout` | timeout (conexão 5 s, total 15 s), `ECONNRESET`, DNS (precedência: desafio vence status) | até 2 retentativas: atraso base 5 s x 2^n (5 s, 10 s) com jitter +-25% | conta para "3 falhas seguidas" |
| `http_5xx` | 500-599 | idem | idem |
| `http_429` | 429 | 1 retentativa após `Retry-After` (teto 60 s; ausente = 30 s) | 2º 429 seguido: **abre circuito 24 h** |
| `http_403_ou_desafio` | 403, `cf-mitigated`, corpo de desafio | **0** retentativas | **abre circuito 24 h** imediatamente |
| `produto_removido` | OCC 400 `UnknownIdentifierError`, HTML 404 | 0 | 2 rodadas seguidas => `removido`; não conta para o circuito |
| `formato_desconhecido` | JSON/HTML sem estrutura esperada, sem `baseOptions[0].options`, `code` divergente, 3xx no OCC, Content-Type inesperado | 0 no mesmo source; cai para fallback (composite) | `state='formato_desconhecido'` se todos os sources falharem 3x seguidas (retomada manual, RF-09-AC10); 3 produtos seguidos na rodada encerram a rodada; não conta para o circuito |
| `preco_invalido` | preço ausente/<=0/`discountPrice>price`/>2 casas | 0 | não grava observação da variante; não conta para o circuito |
| `host_nao_autorizado` | redirect/host fora da allowlist, IP interno, >3 redirects, `http:` | 0 | conta para "3 falhas seguidas"; log de segurança |

Circuito global (`scheduler/circuit.ts`): `app_state.circuit_open_until` (ISO), `circuit_reason`. Aberto: o scheduler não coleta nem faz sondagem; `/saude` mostra motivo e retomada (RF-12-AC4); 1 `health_events('circuito_aberto','global')` + 1 notificação `SAUDE`. Passadas 24 h: meia-abertura, **1** requisição de sonda (1º produto da lista); sucesso fecha o episódio e a rodada continua; falha reabre por +24 h sem novo aviso (mesmo episódio). Nunca troca User-Agent, IP ou headers para contornar (RNF-LEG-02).

Cortesia e orçamento: 2-5 s entre requisições (uniforme + jitter, aplicado pelo `RateGate`), 1 requisição simultânea no processo inteiro, mínimo 2 h por produto, teto 400 requisições/24 h de qualquer origem (`RequestLog.countSince`: monitor, catálogo, cadastro por URL e sonda; base 50 x 6 = 300), intervalo da rodada 2-6 h (padrão 4 h) validado em `config.ts`, 50 produtos no máximo (RF-06-AC3, verificado em `alerts.service.create`).

Falha de e-mail: ver seção 6.2.

## 6. Idempotência e notificações

### 6.1 Chaves

| Objeto | Chave | Onde é garantida |
|---|---|---|
| Notificação de preço | `sha256("{alert_id}\|{revision}\|{kind}\|{episode}")` | `notifications.idempotency_key UNIQUE` |
| Mesma observação, mesmo alerta, mesmo tipo | `(alert_id, observation_id, kind)` | índice único parcial |
| Notificação de saúde | `sha256("saude\|{health_event_id}")` | `UNIQUE` + `ux_health_open` |
| Observação | `(run_id, variant_code, seq)` | `UNIQUE` |
| Rodada | 1 `running` | índice único parcial |

O disparo é: na **mesma transação**, `applyDecision` (fecha a trava, `last_sent_*`, `rearm_not_before_*`) + `insertIfAbsent`. Reavaliar a mesma observação encontra a trava já fechada (não dispara) e, se algum caminho de código tentasse, a chave única o barraria. Defesa em duas camadas (RF-10-AC10).

### 6.2 Máquina de notificação (`notifications.service`)

```
PENDENTE --accepted--> ACEITO (simulated=1 em modo teste)
PENDENTE --claimDue--> (attempts++, lease 10 min)  -- tentativa contada ANTES do envio
  --temporary_error, attempts<4--> PENDENTE (next_attempt_at = now + [5 min, 30 min, 2 h][attempts-1])   -- tentativa inicial + 3 retentativas
  --temporary_error, attempts==4 | permanent_error--> FALHA (failure_reason)
FALHA --reenviar manual--> PENDENTE (mesma linha, mesma chave, attempts=0)
PENDENTE (alerta PAUSADO > 24 h) --> FALHA ('alerta_pausado')
```

- `drain()` roda no tick (30 s) e processa `claimDue(now, 10)` sequencialmente (o claim com lease evita envio duplo por dois drains ou duas instâncias; `PENDENTE` de alerta `PAUSADO` não é pego, RN-15); limite global de segurança de 20 e-mails por hora (excedente fica `PENDENTE`; abuso/erro de configuração, ver `security.md`).
- **Aceite != entrega.** `ACEITO` significa "o provedor aceitou a mensagem" (SMTP 250). A UI e os logs dizem "aceito pelo provedor". Bounce, spam e leitura não são observáveis no MVP.
- **Janela de duplicata residual (R-09, D-31).** Se o processo cair entre `mailer.send` e `markAccepted`, o reinício reenvia a notificação (entrega pelo menos uma vez). Mitigação: `Message-ID` derivado da chave de idempotência (um cliente de e-mail ou o provedor pode agrupar), e o `PENDENTE` com `attempts` já incrementado **antes** do envio (`attempts` conta tentativas iniciadas), o que limita a repetição a 4.
- Render (`render.ts`) usa só o snapshot da notificação e o e-mail atual do alerta. Texto fixo em pt-BR: preço, alvo, margem (se PROXIMO), tamanho, horário da leitura em America/Sao_Paulo, fonte, link `https://www.vans.com.br/{slug}/p/{code}` (sem slug: `/p/{code}`), aviso "o preço pode ter mudado desde a leitura" e, se `degraded`, aviso de fonte degradada; aviso de que Pix/cupom/carrinho podem diferir (D-02).
- `SAUDE` vai para `OWNER_EMAIL` (ambiente). Sem `OWNER_EMAIL`, a notificação não é criada: o evento aparece só no painel.

## 7. Agendador

Detalhe em ADR-0004. Resumo:

- **Persistente e recuperável:** o "relógio" é a tabela `monitoring_runs` (`kind='monitor'`). `due` é derivado: `now >= start_da_última_rodada + I`. Reiniciar o app não perde nem duplica agenda. Na partida: (1) `markInterruptedOnStartup` converte `running` órfão em `interrupted` (o índice único libera); (2) no máximo **1** rodada `recovery` se `due`, que só coleta produtos sem leitura boa há >= 2 h, o que também retoma uma rodada interrompida sem refazer o que já foi lido (D-13, RF-06-AC5).
- **Laço:** `while (!stopped) { await tick(); await clock.sleep(30_000, signal) }`. `tick()` é público e determinístico: os testes chamam `tick()` e `clock.advance()` sem esperar tempo real.
- **Sem sobreposição:** índice único + `inflight` em memória; o `tick` não espera a rodada (ver §4), então heartbeat e `drain` seguem durante a coleta. Gatilho manual (`POST /monitor/executar`) respeita o mínimo de 2 h por produto, o orçamento e o circuito; retorna "nada a fazer" se nenhum produto está vencido. Atualização de catálogo (`POST /catalogo/atualizar`) também é rodada em segundo plano (`tryStart('catalog')`), responde `303` e a tela mostra "em andamento/concluída"; se há rodada de monitor ativa, é recusada com mensagem.
- **Parada:** `SIGINT/SIGTERM` -> `stopped=true`, `AbortSignal` interrompe sleeps, rodada em andamento termina o item atual, `finish(status='partial')`; o servidor fecha por último.
- **Aviso honesto (RF-12-AC6):** monitoramento só roda com o app aberto (a tela diz isso).

## 8. Web (módulo `web`)

Rotas (todas em pt-BR; mutações só `POST`, com `Origin` verificado):

| Método e caminho | Função | RF |
|---|---|---|
| `GET /` | dashboard: alertas, faixa, frescor, banners (atrasado, circuito, "só roda com o app aberto") | RF-09, RF-12 |
| `GET /catalogo?q=` / `POST /catalogo/atualizar` | busca local; atualização (recusada < 24 h) | RF-01 |
| `POST /produtos/url` | cola URL -> extrai `code` -> consulta OCC -> redireciona | RF-02 |
| `GET /produtos/:code` | produto, tamanhos (disponível/indisponível), formulário de alerta | RF-03, RF-04 |
| `POST /alertas` | cria alerta | RF-04, RF-05, RF-08-AC9 |
| `GET /alertas/:id` | detalhe, histórico, notificações (estado + "simulado") | RF-07, RF-08 |
| `GET /alertas/:id/editar`, `POST /alertas/:id` | edita alvo/margem/e-mail | RF-09-AC2 |
| `POST /alertas/:id/pausar` `.../retomar` `.../excluir` | gestão (excluir com confirmação em página própria) | RF-09 |
| `POST /notificacoes/:id/reenviar` | `FALHA` -> `PENDENTE` | 6.2 |
| `POST /monitor/executar` | rodada manual com as mesmas travas | RF-06 |
| `POST /produtos/:code/retomar` | volta `removido`/`formato_desconhecido` a `ativo` e zera contadores | RN-19, RF-09-AC10 |
| `GET /saude` | JSON sem PII | RF-12 |
| `GET /static/app.css` | CSS | |

Middleware (ordem): `host-guard` (aceita só `Host` = `127.0.0.1:PORT` ou `localhost:PORT`, anti DNS rebinding) -> `secureHeaders` (CSP restrita) -> `csrf({ origin })` nas rotas `POST` -> handler -> `onError` genérico (corpo sem stack e sem dados; log com `request_id`). Padrão PRG: `POST` válido -> `303` para `GET`. Erro de validação: renderiza o formulário com mensagem associada ao campo (`aria-describedby`, `aria-invalid`) e `422`.

A camada web recebe serviços por injeção; **não** importa repositórios nem SQL. Os dados exibidos que vêm da loja (nome do produto, slug) são sempre interpolados pelo `html` do Hono (escape) e o slug é reaplicado por `[a-z0-9-]` antes de virar link.

## 9. Observabilidade (módulo `observability`)

- **Logs** (RNF-OBS-01): uma linha JSON por evento, `{ ts, level, module, event, run_id?, alert_id?, product_code?, failure_class?, http_status?, duration_ms?, source?, count? }`. O tipo `LogFields` **não tem campo livre**: não há como passar e-mail, corpo ou credencial sem mudar o tipo (revisão de PR vê). Mensagens são constantes (`event: 'run_finished'`). `maskEmail` existe só para o caso excepcional de diagnóstico explícito.
- **Contadores** (RNF-OBS-02): calculados do banco sob demanda em `/saude` (sobrevivem a reinício; sem estado em memória): rodadas por status, itens ok/falha por classe (24 h), observações por fonte, notificações por estado, idade da última observação por frescor.
- **`/saude`** (RF-12-AC1): `{ version, now, scheduler: { status: 'ok'|'atrasado'|'pausado_circuito', last_run: {...}, heartbeat_at }, circuit: { open, reason, until }, freshness: { fresco, defasado, sem_dados }, email_mode, counters: {...} }`. `atrasado` = há alerta `ATIVO` e a última rodada **não pulada** concluída há > 2*I (ou nunca, com app no ar há > 2*I); sem alertas ativos = `ok`; circuito aberto = `pausado_circuito`. Só lê o banco local, <200 ms, nenhuma requisição à loja.
- **Eventos de saúde únicos por episódio** (RNF-OBS-03): `health_events` com índice único parcial; abrir é idempotente; fechar quando a condição some.
- **Frescor** (RN-17, `shared/freshness.ts`, função pura `freshness(lastConfirmedAt, now, intervalMs)`): `fresco <= 2*I`, `defasado <= 24 h`, `sem_dados` caso contrário/nunca.

## 10. Decisões em aberto / pontos para o dono

1. **Releitura imediata para confirmar** (RN-09c): o texto de requirements aceita "releitura no mesmo ciclo" como confirmação. Esta arquitetura implementa 1 releitura extra só para leituras suspeitas (variação > 70% ou fallback), com a cortesia de 2-5 s. Desligável por configuração. Se o dono preferir zero requisição extra, a confirmação espera a próxima rodada (4 h de atraso no alerta).
2. **"3 falhas seguidas de qualquer produto na mesma rodada"** (RN-18, agora escrito assim em requirements): interpretado como falhas de **transporte** (`rede_timeout`, `http_5xx`, `http_429`, `http_403_ou_desafio`, `host_nao_autorizado`). Conteúdo ruim (`formato_desconhecido`, `preco_invalido`, `produto_removido`) não abre o circuito global porque não indica bloqueio. Requer confirmação de produto.
3. **Observação só de variantes com alerta** (`data-model.md`, seção 7), não de todos os tamanhos. Reversível sem migração.
4. **`UNIQUE` permanente em alertas idênticos** (mais estrito que RF-09-AC7). Ver `data-model.md`.
5. **Linter/formatter:** não adicionados. `tsc` estrito e testes são o portão. Adicionar quando houver mais de um desenvolvedor.
6. **Provedor SMTP real** não escolhido (depende do dono): o `SmtpMailer` é genérico (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, TLS obrigatório).
