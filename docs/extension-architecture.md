# Arquitetura da extensão: Vans Price Watcher (MV3)

Versão 0.2 (2026-10-15). Decisão: `docs/adr/0006-extensao-navegador.md`. Regras de negócio: `docs/requirements.md` (RN-01..21 intactas). Este documento **vigora no lugar de** `architecture.md` e `data-model.md` onde houver conflito (servidor, SQL, web, SMTP); os contratos de domínio (`ProductSnapshot`, `Decision`, `FailureClass`...) continuam os de `architecture.md` 3.1-3.6.

## 1. Visão geral

```
 popup (activeTab) ─┐                       ┌─ chrome.alarms: tick 15 min, resume, outbox
 options/dashboard ─┼─ runtime.sendMessage ─▶ SERVICE WORKER (efêmero, sem estado em memória)
                    │   (validado, só SW     │   api ─ app services ─ stores (porta Db) ─ IndexedDB
                    │    escreve)            │   round/tick ─ source(OCC→NextData) ─ RateGate ─ fetch
                    │                        │   notifier ─ chrome.notifications
                    │                        └─ mailer (opcional) ─ fetch https://api.resend.com
                    └─ lê/escreve só por mensagem
```

Camadas e fronteiras (cada seta só aponta para baixo):

| Camada | Pasta | Conhece `chrome`? | Testada com |
|---|---|---|---|
| Lógica pura | `src/shared`, `src/price-monitor`, `src/alerts`, `src/scheduler/{backoff,circuit}`, `src/notifications/render`, `src/catalog/{parser,source}`, `src/settings` | não | `node:test` |
| Portas e armazenamento | `src/store` (`ports.ts`, `db.ts`, `memory.ts`, `idb.ts`, `schema.ts`, `*.store.ts`) | não (IndexedDB só em `idb.ts`) | memória em `node:test`; `idb.ts` no autoteste do navegador |
| Aplicação | `src/app` (`alerts`, `monitor`, `notifications`, `history`, `health`, `catalog`, `round`, `tick`, `rate-gate`, `circuit-store`) | não | `node:test` com `Db` em memória, `ManualClock`, `FakeHttpClient` |
| Cola da extensão | `src/ext/background` (`sw`, `compose`, `alarms`, `api`), `src/ext/notifier.chrome.ts`, `src/ext/messages.ts` | sim, via `globalThis.chrome` | `node:test` com `tests/helpers/fake-chrome.ts` |
| UI | `src/ext/ui` (`popup`, `options`, `dom.ts`, `format.ts`, `client.ts`) | só `client.ts` e `main.ts` | modelos de visão puros em `node:test`; DOM por checklist manual |

Regra de fronteira (verificada por varredura em `tests/security`): `src/shared|price-monitor|alerts|scheduler|notifications|catalog|settings|store|app` não referenciam `chrome.` nem `document`; nada no bundle importa `node:*` (o esbuild falha).

## 2. Estrutura de arquivos

```
extension/                 estático copiado para dist/
  manifest.json            (version injetada pelo build a partir do package.json)
  popup.html  options.html  app.css  popup.css
  icons/{16,32,48,128}.png (geradas por scripts/make-icons.ts, sem dependência)
src/ext/
  background/{sw,compose,alarms,api}.ts
  ui/{dom,format,client}.ts
  ui/popup/{main,model}.ts
  ui/options/{main,alerts-view,history-view,health-view,settings-view,catalog-view}.ts (+ *-model.ts)
  messages.ts  notifier.chrome.ts
src/store/  src/app/  src/settings/      (novos; ver seção 8)
scripts/build.ts  scripts/make-icons.ts
dist/                      saída do build (ignorada pelo git): é a pasta que se carrega
```

## 3. Manifest e permissões mínimas

```json
{
  "manifest_version": 3,
  "name": "Vans Price Watcher",
  "version": "0.2.0",
  "description": "Avisa quando um tênis da Vans Brasil chega ao seu preço-alvo.",
  "minimum_chrome_version": "120",
  "action": { "default_popup": "popup.html", "default_title": "Vans Price Watcher", "default_icon": { "16": "icons/16.png", "32": "icons/32.png" } },
  "options_ui": { "page": "options.html", "open_in_tab": true },
  "background": { "service_worker": "background.js", "type": "module" },
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
  "permissions": ["alarms", "notifications", "activeTab", "unlimitedStorage"],
  "host_permissions": ["https://www.vans.com.br/*"],
  "optional_host_permissions": ["https://api.resend.com/*"],
  "content_security_policy": {
    "extension_pages": "default-src 'none'; script-src 'self'; object-src 'none'; style-src 'self'; img-src 'self'; connect-src 'self' https://www.vans.com.br https://api.resend.com; base-uri 'none'; form-action 'none'"
  }
}
```

| Permissão | Por que | Alternativa descartada |
|---|---|---|
| `alarms` | Agendador (`tick`, `resume`, `outbox`) | `setInterval` morre com o SW |
| `notifications` | Canal primário (RF-08 adaptado) | e-mail como único canal |
| `activeTab` | O popup lê a URL da aba atual só quando o usuário clica no ícone; sem aviso de instalação | `tabs` (lê todas as URLs) ou content script |
| `unlimitedStorage` | Evita despejo do IndexedDB e quota do histórico; sem aviso de instalação | confiar na cota padrão |
| host `https://www.vans.com.br/*` | `fetch` do SW sem CORS à API OCC e à página de produto | `<all_urls>` |
| opcional `https://api.resend.com/*` | Só se o usuário ativar e-mail; pedida por clique, revogável | permissão obrigatória, ou `https://*/*` para "qualquer provedor" |

Não pedir: `tabs`, `scripting`, `cookies`, `webRequest`, `declarativeNetRequest`, `storage`, `history`, `<all_urls>`. Sem `content_scripts`, sem `externally_connectable`, sem `web_accessible_resources`. Um teste do manifest fixa a lista exata de permissões, hosts e CSP (mudar exige ADR). Observação: `style-src 'self'` proíbe atributo `style=` e `<style>` inline; o JS pode usar `element.style.x = ...` (CSSOM não é bloqueado), mas as telas usam só classes do `app.css`.

## 4. Service worker efêmero

- O Chrome encerra o SW após ~30 s ociosos e limita um evento a ~5 min. **Regra: nenhum estado de negócio em variável de módulo.** Cache em memória só de coisas reconstruíveis (instância de `Db`, de serviços).
- `sw.ts` registra **todos** os listeners de forma síncrona no topo do módulo (`alarms.onAlarm`, `runtime.onMessage`, `runtime.onInstalled`, `runtime.onStartup`, `notifications.onClicked`, `permissions.onRemoved`); cada listener chama `getServices()` (composição preguiçosa em `compose.ts`) e `event.waitUntil`-equivalente devolvendo a promessa (`onMessage` retorna `true` e responde com `sendResponse`).
- A cada ativação roda `ensureAlarms()` (idempotente): `alarms.get('tick')` ausente => `alarms.create('tick', { periodInMinutes: 15, delayInMinutes: 1 })`. Alarmes podem sumir após atualização/reinício do navegador; por isso `onInstalled`, `onStartup` e o topo do SW sempre o recriam.
- Esperas dentro de uma ativação: cortesia (2-5 s) e backoff (5 s, 10 s) ficam em `Clock.sleep` (menores que 30 s; fetch e IndexedDB reiniciam o contador ocioso). Qualquer espera > 20 s (ex. `Retry-After` de 60 s) **não é dormida**: a rodada grava `resumeAt` e cria o alarme único `resume` (mínimo 30 s) e a ativação termina.
- `onInstalled` (`reason: 'update'`) abre a base cedo para rodar migração e registra um evento de saúde se ela falhar (seção 7.4).

## 5. Alarmes

| Alarme | Tipo | Quem cria | O que faz |
|---|---|---|---|
| `tick` | periódico, 15 min | `ensureAlarms` | `drain` de notificações vencidas; `resumeOrStart('scheduled')`: retoma rodada `running` com lease vencida, ou inicia rodada se `now >= início_última_rodada_não_pulada + I` (I = ajuste, 2-6 h, padrão 4 h; jitter +-10% determinístico por `startedAt` para não alinhar em horário cheio); recuperação ao voltar do sono do computador = no máximo 1 rodada (o "vencido" é um instante, não uma contagem) |
| `resume` | único (`when`) | rodada ao fim de fatia ou espera longa | chama `resumeOrStart('recovery')` |
| `outbox` | único (`when` = menor `nextAttemptAt`) | `notifications.drain` ao agendar retentativa | chama `drain` (retentativas 5 min / 30 min / 2 h sem esperar o `tick`) |

Atualizações de UI não usam alarme: a página de opções recarrega ao receber foco, após cada ação e a cada 30 s enquanto visível.

## 6. Rodada retomável

Constantes (`src/app/round.ts`): `LEASE_MS = 90_000` (batimento), `SLICE_MS = 150_000`, `MAX_RESUME_AGE_MS = 2 h`, `MIN_PRODUCT_INTERVAL_MS = 2 h`, `DAILY_BUDGET = 400` (já existente), `LONG_WAIT_MS = 20_000`.

Estado persistido (`runs`): `id`, `kind`, `trigger`, `status` (`running|ok|partial|failed|skipped|interrupted`), `queue: ProductCode[]` (congelada no início, mais antigo primeiro), `heartbeatAt`, `resumeAt|null`, contadores, `circuitOpened`. Itens em `run_items` com chave `[runId, seq]`; **o cursor é o conjunto de códigos já presentes em `run_items`** (nada de índice mutável que possa divergir).

Fluxo de `resumeOrStart(trigger)`:

1. Transação curta: se há rodada `running`: lease viva (`now - heartbeatAt < LEASE_MS`) => registra `skipped: anterior_em_andamento` e sai; lease vencida e `now - startedAt <= MAX_RESUME_AGE_MS` => **retoma a mesma rodada**; mais velha => fecha como `interrupted` e segue como nova. Sem rodada `running`: circuito aberto => `skipped: circuito_aberto`; sem alerta ativo => `skipped: sem_alertas_ativos`; não vencida (e trigger não manual) => `skipped: intervalo_minimo`; caso contrário `due = dueForCollection(now, 2 h)` (só produtos com alerta ATIVO, leitura boa há >= 2 h) vira `queue` de uma nova rodada. O índice único "uma `running`" é garantido na mesma transação (mutex da `Db`).
2. Laço de fatia, enquanto `now - sliceStart < SLICE_MS`:
   a. Próximo código da `queue` sem item. Fila vazia => passo 4.
   b. Transação curta: grava `heartbeatAt`. Orçamento 24 h esgotado => itens `pulado: orcamento_diario` para o resto e passo 4. Circuito aberto => idem `circuito_aberto`.
   c. **Fora de transação** (a transação IndexedDB morreria no `await fetch`): `source.fetchProduct(code)` via `RateGate` (serializa, cortesia 2-5 s + jitter, registra em `outbound_requests` **antes** da requisição) com `CompositeSource` (OCC, fallback `__NEXT_DATA__` só em `rede_timeout|http_5xx|formato_desconhecido`). Retentativas com `retryDelayMs`: espera <= `LONG_WAIT_MS` dorme; maior => grava `resumeAt`, cria alarme `resume`, termina a ativação.
   d. `RoundBreaker.observe` por tentativa: 403/desafio abre o circuito 24 h (item e restante `pulado`), 429 repetido idem, 3 falhas de transporte idem, 3 de conteúdo ruim = `end_partial`.
   e. **Uma transação** `monitor.processResult(runId, seq, result)` (lógica de `monitor.service`: produto, variantes, observações, confirmação, `evaluateAlert`, travas, notificação `insertIfAbsent`, `run_item`). Idempotente: se já existe `run_item` para `(runId, code)`, não faz nada (cobre retomada após morte entre c e e: no pior caso 1 requisição repetida, já contada no orçamento).
3. Fatia acabou com fila pendente => `resumeAt = now + 30 s`, alarme `resume`, fim da ativação.
4. Fechamento: transação grava `status` (`ok|partial|failed`), `finishedAt`, contadores; `drain()` das notificações geradas.

Propriedades: matar o SW em qualquer ponto nunca produz observação ou alerta sem a transação completa (RNF-REL-01/02); a retomada não refaz o que já foi lido; duas rodadas nunca coexistem; 50 produtos cabem em ~2 fatias.

## 7. Armazenamento

### 7.1 Escolha

| Critério | IndexedDB (escolhido) | `chrome.storage.local` |
|---|---|---|
| Atomicidade multi-registro (RNF-REL-02) | transação com várias stores | só um `set` multi-chave, sem leitura-modifica-grava |
| Histórico (~110 mil linhas/ano no teto: 50 variantes x 6/dia) | índice `[variantCode, observedAt]`, cursor, `count` | array inteiro regravado a cada leitura |
| Consulta por estado/tempo (`dueForCollection`, `claimDue`) | índices | varredura de tudo |
| Testar em Node | precisa de porta + memória (custo) | fake trivial |
| Quota | `unlimitedStorage` | 10 MB sem a permissão |

Custo (porta `Db`, autoteste) está em 14.3. Nada de `storage.sync` (segredos e histórico não saem do perfil).

### 7.2 Porta `Db` (`src/store/db.ts`)

Pequena de propósito: `get(store, key)`, `add` (rejeita `ConstraintError` em chave/índice único), `put`, `delete`, `getAll(store, { index?, range?, direction?, limit? })`, `count`, `clear`, e `tx(fn)`. **`tx` é ambiente e exclusivo:** um mutex serializa as transações; dentro de `fn` as chamadas `get/put/...` usam a transação corrente; `fn` rejeitar = rollback total (IndexedDB `abort`; memória restaura o snapshot). Regras de uso: dentro de `tx` só se aguardam operações da `Db` e cálculo puro (nunca `fetch`, `sleep`, `chrome.*`); fora de `tx`, cada chamada é sua própria transação. Os repositórios (`*.store.ts`) implementam as portas assíncronas de `src/store/ports.ts` em cima disso; validam o que antes eram `CHECK`/`FK` (`current_cents > 0`, `discount <= price`, alerta duplicado, cascata alerta -> notificações) e lançam `StoreConstraintError` (o `monitor` o trata como `formato_desconhecido` quando causado por dado da loja).

### 7.3 Esquema (versão 1)

Datas em ISO UTC (texto), dinheiro em centavos inteiros (ADR-0003).

| Store | Chave | Índices | Conteúdo (resumo) |
|---|---|---|---|
| `products` | `code` | `state` | nome, `legacySku`, `lastSlug`, `state`, `consecutiveFailures`, `notFoundStreak`, `degradedSince`, `lastAttemptAt`, `lastOkAt` |
| `variants` | `variantCode` | `productCode` | `size`, `ean`, `lastSeenAt` |
| `observations` | `id` auto | `byVariant [variantCode, observedAt]`; único `[runId, variantCode, seq]` | `originalCents`, `currentCents`, `available`, `confirmed`, `confirmedBy`, `degraded`, `source` |
| `alerts` | `id` auto | `variantCode`, `status` | `targetCents`, `marginBp`, `status`, `revision`, travas e episódios por tipo, `rearmNotBefore*`, `lastSent*At`, `evaluatedOnce`, `pausedAt` (sem e-mail) |
| `notifications` | `key` (texto `alertId\|revision\|tipo\|episódio` ou `saude\|id`) | `alertId`, `due [emailStatus, nextAttemptAt]` | dados do render, `desktop` (`pendente\|mostrada\|falha`), `email` (`desligado\|PENDENTE\|ACEITO\|FALHA`), `attempts`, `nextAttemptAt`, `providerMessageId`, `simulated`, `failureReason` |
| `runs` | `id` auto | `status`, `startedAt` | ver seção 6 |
| `run_items` | `[runId, seq]` | `productCode` | resultado por produto (ok/degradado/falha/pulado), fonte, HTTP, tentativas, requisições |
| `failure_samples` | `productCode` | | 1 amostra sanitizada (256 KiB) por produto |
| `health_events` | `id` auto | `open [kind, subject, closedAt]` | 1 aberto por (kind, subject) |
| `outbound_requests` | `id` auto | `at` | `purpose`, `at` (podada > 48 h) |
| `catalog` | `code` | `gen` | nome, slug, preço de referência, `gen` |
| `kv` | `key` | | `settings`, `circuit_open_until`, `circuit_reason`, `circuit_probe_pending`, `catalog_gen`, `catalog_refreshed_at`, `catalog_cursor`, `last_tick_at` |

`settings` (kv): `{ v: 1, intervalHours: 4, email: { mode: 'teste'|'real', enabled, to, from, apiKey } }`. A UI nunca recebe `apiKey` (só `apiKeySet: boolean`).

Catálogo (RF-01) por geração: a atualização grava páginas com `gen = nova` e, ao terminar, troca `catalog_gen` e apaga a geração antiga; atualização interrompida nunca deixa o catálogo pela metade visível. Cursor de página em `catalog_cursor`, em fatias como a rodada (`kind: 'catalog'`).

### 7.4 Migração de versão

- `DB_VERSION = MIGRATIONS.length` em `src/store/schema.ts`; `MIGRATIONS[n]` leva de `n` a `n+1` e recebe um `Migrator` (`createStore`, `createIndex`, `deleteStore`, `forEach(store, fn)` para transformar dados dentro da transação de upgrade). `onupgradeneeded` executa de `oldVersion` até `DB_VERSION`; a memória implementa o mesmo `Migrator`, então **a migração é testada em Node**: monta a base na versão `n` com dados reais, migra, confere.
- Regras: passos aditivos por padrão; passo destrutivo (apagar store/campo com dado) exige ADR e teste de preservação; o SW nunca apaga e recria a base para "consertar"; `settings` evolui por `v` e preenchimento de padrões na leitura (campo novo = default, sem migração).
- Falhas: `VersionError` (dados de uma versão **mais nova** que o código, p.ex. após reverter a extensão) ou exceção no upgrade => `compose` entra em modo `somente_leitura_degradado`: nenhuma rodada, nenhuma escrita; a UI mostra banner "dados de versão mais nova ou migração falhou" e orienta atualizar a extensão. Nunca cria base vazia por cima.
- Fluxo de atualização do usuário: recarregar/atualizar a extensão => `onInstalled(update)` => abre a base (upgrade) => `ensureAlarms`.

## 8. Portas que mudam

Os repositórios SQLite sincrônicos e os serviços que os usam **permanecem** (e verdes) até a E35; as versões assíncronas são arquivos novos, de modo que cada onda termina verde. Tipos de linha (`ProductRow`, `RunRow`, `NotificationRow`...) são reaproveitados de cada `ports.ts`.

| Porta (antes, `ports.ts`) | Depois (`src/store/ports.ts`) | Mudança |
|---|---|---|
| `Tx = (fn) => T` síncrona | `Tx = (fn) => Promise<T>` ambiente | `await`; sem I/O de rede dentro |
| `ProductRepo`, `RunRepo`, `RequestLog` | idem, métodos `Promise` | + `RunRepo.claim/resume` (lease, `queue`, `heartbeat`, `resumeAt`); `RequestLog.countSince/record` assíncronos |
| `AlertRepo` (`email` no alerta) | idem sem `email` | e-mail passa aos `settings` |
| `NotificationRepo` (`status` único, SMTP) | idem com `desktop` + `email` | `claimDue` considera só o canal e-mail |
| `ObservationRepo`, `CatalogRepo` (`replaceAll`) | idem assíncronos | catálogo por `gen` |
| `StateRepo` (`app_state`) | `kv` assíncrono | chaves novas (`last_tick_at`, `catalog_*`) |
| `HttpClient` | **igual** | implementado por `FetchHttpClient` (E05) |
| `Mailer` | **igual** | `ResendMailer`, `DryRunMailer` (E08) |
| (novo) `Notifier` | `show(n): Promise<'mostrada'\|'falha'>` | implementado por `notifier.chrome.ts` |
| `Clock`, `Random` | **iguais** | |

## 9. Rede

`FetchHttpClient` (`src/price-monitor/http/fetch-http.ts`): `validateOutboundUrl` (https, host exato `www.vans.com.br`, porta 443, sem credenciais) **e** allowlist de caminho (`/arezzocoocc/v2/vans/products/{code}`, `.../products/search?category=SAPATOS&...`, `/{slug}/p/{code}`) antes de todo `fetch`; `fetch(url, { method: 'GET', credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer', cache: 'no-store', signal })`; 3xx/`opaqueredirect` = `host_nao_autorizado`; tipo de conteúdo só `application/json|text/html`; corpo lido em stream e abortado em 2 MB; timeout 15 s; `cf-mitigated` ou corpo de desafio vence o status (`http_403_ou_desafio`); `Retry-After` honrado. O `fetch` de extensão com host permission não sofre CORS. O navegador resolve DNS e valida TLS (sem `lookup` customizado). O `User-Agent` não é controlável (ver ADR-0006).

## 10. Notificações e e-mail opcional

Disparo (`evaluateAlert`) grava a `notification` na mesma transação do ciclo. Depois do commit, `drain()`:

1. **Desktop:** para cada `desktop = pendente`: `chrome.notifications.create(key, { type: 'basic', iconUrl: 'icons/128.png', title, message, requireInteraction: kind !== 'SAUDE' })` com texto curto de modelo fixo (nome `stripControl` <= 80, preço, alvo, tamanho, horário SP). Resposta ok => `mostrada` (significa "entregue ao sistema de notificações", não "lida"); erro => `falha` com motivo, sem reenvio automático. `notifications.onClicked(key)` busca o registro e abre `https://www.vans.com.br/p/{code}` (reconstruída do `code` validado) com `tabs.create` (não exige `tabs`).
2. **E-mail (se `settings.email.enabled`):** `claimDue` (lease, `attempts++` antes do envio, teto 20/h) -> `render` (texto + HTML escapado) -> `Mailer.send`. Modo `teste` (padrão): `DryRunMailer` não abre conexão e termina `ACEITO` com `simulated = true` ("simulado, não enviado"). Modo `real`: `ResendMailer` faz `POST https://api.resend.com/emails` (`Authorization: Bearer <chave>`, `Idempotency-Key: <key>`, JSON `{ from, to: [to], subject, text, html }`), `credentials: 'omit'`, `redirect: 'error'`, 15 s; 2xx com `id` => `ACEITO` ("aceito pelo provedor", nunca "entregue"); 429/5xx/rede => temporário (5 min / 30 min / 2 h, 4 envios no total, alarme `outbox`); outro 4xx => permanente `FALHA`; sem permissão de host => `FALHA` `permissao_ausente`. Nunca lança.
3. **Ativação do e-mail:** botão na página de opções chama `chrome.permissions.request({ origins: ['https://api.resend.com/*'] })` **no clique** (gesto do usuário; o SW não pode pedir) e só então envia `settings.set`. `permissions.onRemoved` no SW desliga `email.enabled` e abre evento de saúde. "Enviar e-mail de teste" usa `Idempotency-Key` próprio e o modo atual. "Remover chave" apaga `apiKey`.
4. Resend: `from` precisa ser domínio verificado (ou `onboarding@resend.dev`, que só entrega ao e-mail da própria conta); recomenda-se chave restrita a "envio".

## 11. Mensagens UI -> SW (`src/ext/messages.ts`)

Requisição `{ type, ...payload }`, resposta `{ ok: true, data } | { ok: false, error: { code, message } }` (mensagens pt-BR sem stack/caminho). Tipos: `tab.inspect {url}` (extrai `code` com `extractProductCode`; devolve produto e variantes via `monitor.discoverProduct`, banco se lido há < 2 h), `alert.create|update|pause|resume|delete`, `alerts.list`, `history.get {alertId, page}`, `health.get`, `monitor.runNow`, `product.resume {code}`, `catalog.search {q}`, `catalog.refresh`, `settings.get|set`, `email.test`, `notification.resend {key}`. O SW valida: `sender.id === chrome.runtime.id`, `sender.url` começa por `chrome.runtime.getURL('')`, `type` conhecido, forma e limites do payload (alvo/margem por `alerts/validation`, e-mail por `validation`, `code` por `url.ts`). Nenhum `onMessageExternal`.

## 12. UI

- **Popup** (largura 360 px): detecta a aba ativa (`tabs.query` + `activeTab`), `tab.inspect`. Estados: não é produto Vans (explica e oferece abrir o dashboard); produto lido (nome, preço atual, tamanhos disponível/indisponível); formulário (tamanho, preço-alvo, margem padrão 3%, aviso "já abaixo do alvo"); já monitorado (mostra o alerta e atalho para o dashboard); erro/bloqueio/circuito aberto com mensagem clara. Salvar chama `alert.create`.
- **Opções/dashboard** (aba cheia, 360 a 1280 px): abas "Monitoramentos" (lista com produto, tamanho, alvo, margem, preço, faixa, disponibilidade, estado, frescor, última leitura; pausar/retomar/editar/excluir com confirmação; histórico por alerta com mín/máx só confirmadas e "não confirmada" marcada), "Saúde" (última rodada, circuito, frescor, orçamento 24 h, eventos abertos, banner "só monitora com o navegador aberto"), "E-mail" (modo, destinatário, remetente, chave, permissão, teste) e "Catálogo" (busca local por nome, atualizar 1/24 h, abrir produto).
- **Acessibilidade e i18n:** `lang="pt-BR"`, rótulos associados, erros com `aria-invalid`/`aria-describedby` e região `aria-live`, foco visível, navegação por teclado completa, selos de estado com texto (não só cor), tokens claro/escuro por `prefers-color-scheme`, alvo de toque >= 44 px, zoom 200%, largura 360 px; datas em America/Sao_Paulo e valores `formatBrl`.
- **Sem framework:** `dom.ts` expõe `h(tag, props, ...filhos)` (usa `createElement`, `textContent`, `setAttribute` de lista permitida) e `mount`. **Proibido** `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, atributos `on*` (varredura em `tests/security`). Cada tela separa um **modelo de visão puro** (`*-model.ts`: ordena, formata, valida, deriva selos) testado em Node, e uma casca DOM fina.

## 13. Build e empacotamento

- `scripts/build.ts` (Node 24, executa `.ts` direto) usa a API do esbuild: entradas `src/ext/background/sw.ts` (ESM, `background.js`), `src/ext/ui/popup/main.ts` (`popup.js`) e `src/ext/ui/options/main.ts` (`options.js`) em IIFE; `bundle: true`, `platform: 'browser'`, `target: 'chrome120'`, `charset: 'utf8'`, sem minificação (código legível para revisão do dono); `sourcemap` só com `--dev`; `legalComments: 'none'`. Copia `extension/*` para `dist/` e injeta `version` no manifest. Falha se algum bundle importar `node:*`. `--dev` inclui `selftest.html`/`selftest.js` (autoteste do IndexedDB); a build normal não.
- Por que esbuild e só ele: MV3 não carrega TypeScript nem `node_modules`; precisamos de JS plano por ponto de entrada. O esbuild faz bundle, remove tipos e aceita imports `.ts` em milissegundos, falha em import de `node:*` e é um binário único. `@types/chrome` é só tipos (não entra no bundle). Alternativa `tsc` + `rewriteRelativeImportExtensions` emitiria dezenas de módulos e não barraria `node:*`.
- `package.json` final: `dependencies` vazio; `devDependencies`: `typescript`, `esbuild`, `@types/chrome`, `@types/node` (versões exatas, `package-lock.json` versionado); scripts `build`, `build:dev`, `typecheck`, `test`, `test:cov`, `test:live`. `tsconfig`: `lib: ["ES2023","DOM"]`, `types: ["node","chrome"]`.
- Empacotamento: a **pasta `dist/` é o artefato** (uso pessoal, sem zip). Para compartilhar: `tar -a -cf vans-price-watcher.zip -C dist .` (bsdtar do Windows 10+/macOS). Web Store fica fora do escopo (ADR-0006).

## 14. Estratégia de testes

1. **Puros e de contrato** (existentes): continuam em `node:test`; fixtures reais (`tests/fixtures/vans`).
2. **Aplicação com `Db` em memória:** `tests/helpers/db.ts` passa a devolver `createMemoryDb()`; os testes de serviço/rodada usam `ManualClock`, PRNG semeado e `FakeHttpClient`. Cobrem atomicidade (falha injetada em qualquer passo => rollback), idempotência, retomada (matar a rodada entre c e e e rodar de novo), invariante RNF-REL-01 por propriedade.
3. **API `chrome` falsa** (`tests/helpers/fake-chrome.ts`): objeto instalado em `globalThis.chrome` com subconjunto fiel: `runtime` (`id`, `getURL`, `onMessage`, `onInstalled`, `onStartup`, `sendMessage` que invoca o listener como o Chrome faria, `openOptionsPage`, `lastError`), `alarms` (`create/get/clear`, `onAlarm`, `fire(name)`, relógio manual), `notifications` (`create`, `onClicked`, registro de chamadas, `click(id)`), `permissions` (`request/contains/remove`, `onRemoved`, resposta programável), `tabs` (`query`, `create`). Gera erro se a extensão chamar API não declarada no manifest (o fake lê as permissões do manifest real), o que pega esquecimento de permissão em teste. Testa `sw.ts`/`compose.ts`/`api.ts`/`notifier.chrome.ts`/`client.ts` ponta a ponta: alarme dispara `tick` -> rodada contra `FakeHttpClient` -> notificação "mostrada"; mensagem com `sender` falso é recusada; morte do SW simulada descartando a instância de serviços (a `Db` em memória persiste) e disparando outro alarme.
4. **E2E das jornadas J-1..J-6** adaptadas (E31) sobre o fake: loja e provedor falsos, relógio manual.
5. **Segurança** (E32): manifest, varredura de `innerHTML/eval/node:`/scripts remotos, fronteira de camadas, URLs geradas x `robots.txt`, logs sem PII/segredo, `apiKey` nunca na resposta de `settings.get`, `sender` validado, CRLF/HTML no e-mail.
6. **IndexedDB real** (E33): `src/store/db-contract.ts` é uma suíte sem `node:test` (recebe `assert` mínimo); roda em Node contra a memória e, no navegador, em `selftest.html` contra `idb.ts` (build `--dev`, botão "Executar"). Garante que a memória não diverge do IndexedDB em ordem de índice, unicidade, abort e migração.
7. **Manual** (E34): checklist no Chrome e no Edge (carregar, popup em produto real, alarme, notificação, e-mail teste, tema escuro, teclado, 360 px). Teste ao vivo (`tests/live`) continua opt-in, <= 6 requisições.

Metas de cobertura mantidas (80% linhas/ramos no gate; 100% em `money`/`price-compare`). `idb.ts` e a casca DOM ficam fora da métrica e dentro do checklist.

## 15. Carregar sem compactação

1. `npm ci` e `npm run build` (gera `dist/`).
2. Chrome: abrir `chrome://extensions`, ligar "Modo do desenvolvedor", "Carregar sem compactação", escolher a pasta `dist/` do projeto. Edge: `edge://extensions`, "Modo de desenvolvedor", "Carregar descompactada", mesma pasta.
3. Fixar o ícone na barra. Abrir um produto em `www.vans.com.br`, clicar no ícone.
4. Para ativar notificações no Windows: permitir notificações do navegador (e desligar "Não perturbe/Assistente de foco").
5. Depois de `npm run build` de novo: em `chrome://extensions`, "Recarregar" no cartão. Os dados (IndexedDB) são mantidos; remover a extensão os apaga.
6. Desenvolvimento: `npm run build:dev` (sourcemaps + página `selftest.html`), "Inspecionar visualizações: service worker" para o console.

## 16. Limitações conhecidas

- Só monitora com o navegador em execução (alarmes disparam ao abrir; 1 rodada de recuperação).
- Sem `User-Agent` próprio; sem seguir redirects.
- O sono do SW pode atrasar uma rodada até 15 min (granularidade do `tick`).
- Dados só no perfil do navegador; desinstalar apaga; modo anônimo não é suportado.
- Chave do provedor em texto no armazenamento local da extensão (ver `security.md` X4).
