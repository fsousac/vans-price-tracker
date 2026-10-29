# ADR-0006: Extensão de navegador (Chrome/Edge, Manifest V3) no lugar do servidor Node local

Status: aceito (2026-10-15). Decisor: dono do produto. Substitui ADR-0001 (stack), ADR-0004 (agendador) e a parte de transporte/e-mail de ADR-0002/0005; preserva ADR-0003 (dinheiro em centavos) e as decisões de coleta de ADR-0002 (OCC primário, `__NEXT_DATA__` fallback).

## Contexto

O produto era um servidor Node local (Hono + SQLite + SMTP + laço de `tick`). O dono decidiu que o produto é uma **extensão de navegador**: instala-se uma vez, monitora a aba de produto que ele já está vendo, notifica no próprio navegador e não exige processo, porta, `.env` nem terminal. O backend atual tem ~316 testes verdes de lógica pura e de adaptadores; o que é regra (preço, confirmação, deduplicação, rearmamento, "nunca alerta falso", allowlist, sem PII) continua valendo.

## Decisão

1. **Manifest V3**, alvo Chrome >= 120 e Edge equivalente; um service worker (SW), um popup, uma página de opções que faz o papel de dashboard. Sem content scripts, sem página injetada na loja.
2. **Persistência: IndexedDB** (uma base, ~12 object stores, versão por `onupgradeneeded`), não `chrome.storage.local`. Motivo: o ciclo de um produto (observação + avaliação do alerta + trava + notificação + item da rodada) precisa ser **uma transação atômica** (RNF-REL-02, hoje garantida por `BEGIN IMMEDIATE`); o histórico cresce (~100 mil linhas/ano no teto) e exige índice por variante+tempo; `storage.local` só regrava chaves inteiras e não tem transação entre chaves. Custo aceito: IndexedDB não existe no Node, então o código fala com uma porta `Db` mínima, testada em memória e verificada no navegador real por uma página de autoteste.
3. **Agendador: `chrome.alarms`** (um alarme periódico `tick` de 15 min + alarmes únicos `resume`/`outbox`). O SW é efêmero: **nenhum estado fica em memória**; a rodada é uma linha em `runs` com fila, cursor implícito (itens gravados), batimento e fatias de <= 150 s; quem acordar primeiro retoma.
4. **Rede: `fetch` do SW** com `host_permissions` apenas `https://www.vans.com.br/*`, `credentials: 'omit'`, `redirect: 'manual'` (qualquer 3xx = falha, nada segue para fora), `referrerPolicy: 'no-referrer'`, timeout 15 s, corpo <= 2 MB. A mesma política de acesso da investigação: intervalo padrão 4 h (2-6 h), 1 requisição por vez, cortesia 2-5 s com jitter, para em 403/429 (circuito 24 h), teto 400 req/24 h, só os caminhos de `/arezzocoocc` e `/{slug}/p/{code}`, `robots.txt` respeitado (nunca `/search*`, `?q=:`, `/cart`, `/checkout`, `/login`).
5. **Notificação primária: `chrome.notifications`** (local, sem rede, sem segredo). **E-mail OPCIONAL** por API HTTP de provedor transacional configurada pelo próprio usuário (v1: Resend). Chave guardada só em IndexedDB local (nunca `storage.sync`); `optional_host_permissions` de `https://api.resend.com/*` pedida em runtime por clique do usuário; modo teste (padrão) que não abre conexão. O RF-08 continua atendido por esse caminho: o estado final é "aceito pelo provedor", nunca "entregue".
6. **Build com esbuild**, a única devDependency nova (mais `@types/chrome`, só tipos). Sem framework de UI: TypeScript + DOM, `createElement`/`textContent`, nenhuma `innerHTML`.
7. **CSP estrita de MV3**: `script-src 'self'; object-src 'none'`, sem `eval`, sem código remoto, `connect-src` limitado aos dois hosts.
8. **Migração do código:** a lógica pura e os adaptadores de coleta são **reaproveitados sem reescrita**; a camada de aplicação (serviços e repositórios) ganha versões assíncronas **em arquivos novos** (`src/app/`, `src/store/`), de modo que cada onda do plano termina com typecheck e testes verdes; o backend obsoleto só é removido na última tarefa (E35), depois de substituído.

## O que fica (sem reescrita)

`shared/{money,price-compare,freshness,result,types,clock,random,mask}`; `price-monitor/{normalize,occ.source,nextdata.source,composite.source,confirm,url,sanitize,fake.source}` e `ports.ts` (tipos de domínio); `alerts/{evaluate,validation}`; `scheduler/{backoff,circuit}` (o `RoundBreaker` puro); `notifications/render` e `Mailer`/`OutgoingEmail`; `catalog/{catalog.parser,catalog.source}`; `observability/logger` (só o destino padrão passa de `process.stdout` a `console`); fixtures e testes de contrato/segurança de URL.

## O que muda

| Antes | Depois |
|---|---|
| SQLite síncrono, `Tx` síncrona | IndexedDB atrás da porta assíncrona `Db`; `Tx` assíncrona "ambiente" (uma por vez, mutex) |
| `node:https` + `lookup` anti-DNS-rebinding | `fetch` do SW; allowlist de host/caminho; SSRF por IP deixa de existir (o navegador resolve; o host é fixo) |
| Laço `tick` de 30 s no processo | `chrome.alarms` 15 min + rodada retomável em fatias |
| SMTP (nodemailer) | `chrome.notifications` + e-mail opcional por API HTTP (Resend) |
| Hono, CSP sem JS, CSRF, host-guard | popup + página de opções (TS + DOM), mensagens runtime validadas |
| `.env` / `config.ts` | `settings` em IndexedDB, editáveis na UI |
| E-mail por alerta | um destinatário nos ajustes (o próprio dono); alerta não guarda e-mail |
| Chave de idempotência `sha256` | chave composta em texto `alerta\|revisão\|tipo\|episódio` (é a chave primária; sem hash assíncrono) |
| UA identificável `VansPriceWatcher/0.1` | `fetch` de extensão não controla `User-Agent` (cabeçalho proibido); sai o UA do navegador do dono. Desvio documentado; compensado por volume pessoal e pelo respeito a robots/429 |
| Seguir até 3 redirects na página de produto | nenhum redirect (`manual`); o fallback usa `/{slug}/p/{code}` e uma 3xx é falha (o fallback é só degradado) |

## O que sai (na tarefa E35, nunca antes)

`src/db/*`, `migrations/`, todos os `*.repo.ts` SQLite, `src/web/*`, `public/`, `src/config.ts`, `src/main.ts`, `src/scheduler/runner.ts`, `src/price-monitor/http/safe-http.ts` (fica só o pedaço puro extraído em E05), `mailer.smtp.ts`, `mailer.simulated.ts`, `shared/hash.ts`, serviços e repositórios síncronos e os testes deles; dependências `hono`, `@hono/node-server`, `better-sqlite3`, `nodemailer` e os `@types` correspondentes.

## Alternativas

| Alternativa | Por que não |
|---|---|
| Manter o servidor e só adicionar um popup | Continua exigindo processo/porta; foi justamente o que o dono descartou |
| `chrome.storage.local` | Sem transação entre chaves, regrava o array inteiro do histórico, quota 10 MB sem `unlimitedStorage`; mais simples, mas perde a atomicidade da regra central |
| `fake-indexeddb` nos testes | Nova dependência (o dono pediu esbuild como única); a porta `Db` + memória + autoteste no navegador cobre o mesmo risco |
| Content script lendo o preço da página | Exige `scripting`/host na aba, acopla a DOM da loja e foge da fonte OCC já testada; o popup só precisa do `code` da URL (`activeTab`) |
| Offscreen document / keep-alive para rodada longa | Superfície extra; fatias de 150 s + alarme de retomada bastam |
| Framework de UI (React/Lit) | Peso e cadeia de suprimentos para duas telas simples |
| `tsc` sem bundler (ESM por arquivo) | Funciona, mas emite dezenas de módulos no SW e não barra `node:*` acidental; esbuild falha o build nesse caso |

## Consequências

- **Só monitora com o navegador aberto** (o SW acorda por alarme, mas o navegador precisa estar em execução). Ao abrir, alarmes vencidos disparam e o `tick` retoma/recupera; o frescor e a tela de saúde tornam a lacuna visível (RF-12).
- Os dados vivem no perfil do navegador: desinstalar apaga tudo; não há sincronização entre dispositivos (decisão de privacidade; exportação é melhoria futura).
- Duas execuções simultâneas (SW + popup) são tratadas por mutex de transação e lease da rodada; só o SW escreve (a UI pede por mensagem).
- A superfície de ataque muda de "porta HTTP local" para "mensagens runtime + XSS em páginas da extensão + segredo local" (ver `security.md`, seção 9).
- Distribuição: carregar sem compactação (uso pessoal). Publicar na Chrome Web Store exigiria revisão jurídica da coleta (R-02), política de privacidade e justificativa de permissões.
- Os requisitos RF/RN/RNF permanecem; as adaptações estão em `requirements.md`, seção 0.
