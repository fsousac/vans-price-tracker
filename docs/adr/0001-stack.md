# ADR-0001: Stack mínima (Node 24 + TypeScript sem build + SQLite + Hono)

Status: aceito (2026-10-14). Decisor: arquitetura. Revisável pelo dono.

## Contexto

Aplicação local, usuário único, 50 produtos no máximo, ~300 a 400 requisições/24 h à loja (teto 400). Restrições: sem Redis, microserviços ou Kubernetes; coletor atrás de interface; UI simples, responsiva e acessível; driver SQLite estável; agendador in-process; e-mail por SMTP com modo de teste. A investigação dispensa Playwright (HTTP simples + parse basta).

Evidência do ambiente (2026-10-14, projeto-sonda fora do repositório):

- Node 24.14.0, npm 11.13; Docker 29.3 e Python 3.14.7 existem, mas não são necessários.
- `node:sqlite` funciona (SQLite 3.51.2) porém imprime `ExperimentalWarning: SQLite is an experimental feature and might change at any time`.
- `better-sqlite3` 13.0.3 instalou sem compilar (binário `win32-x64` no pacote), abriu banco em memória e reportou SQLite 3.53.4 em Node 24.14.
- Node 24 executa `.ts` diretamente (importando `better-sqlite3` e `hono`) sem flag e sem aviso; `tsc` 7.0.2 disponível.
- `hono` 4.13.13, `@hono/node-server` 2.1.5, `nodemailer` 10.1.1, `typescript` 7.0.2 resolvem no npm.

## Decisão

| Tema | Escolha |
|---|---|
| Linguagem | TypeScript estrito, ESM, **sem build**: `node src/main.ts`; `tsc --noEmit` como portão; sintaxe apagável (`erasableSyntaxOnly`), imports com `.ts` |
| Banco | SQLite com `better-sqlite3` (síncrono), WAL, FK ligadas, tabelas `STRICT`; acesso só em `*.repo.ts` |
| Web | Hono + `@hono/node-server`; HTML no servidor com `hono/html`; 1 CSS; sem JS no cliente |
| Rede de saída | `node:https` (stdlib) com `lookup` customizado |
| E-mail | `nodemailer` (SMTP) + `SimulatedMailer` (padrão) + `FakeMailer` (testes) |
| Testes | `node:test`, cobertura nativa, PRNG próprio para propriedades |
| Dependências | produção: `hono`, `@hono/node-server`, `better-sqlite3`, `nodemailer` |

## Alternativas

| Alternativa | Por que não |
|---|---|
| `node:sqlite` | Experimental e com aviso no 24.14; o requisito pede driver estável. A isolação por repositório reduziria o dano, mas escolher o estável custa o mesmo (um pacote com binário já incluído). Revisar quando sair de experimental: troca restrita aos `*.repo.ts` e `db/` |
| Fastify / Express | Funcionam, mas exigem plugins para CSRF, cabeçalhos e formulários (3+ pacotes). Hono traz `csrf`, `secureHeaders` e `html` com escape embutidos e `app.request()` para teste sem porta. Fastify é a alternativa se surgir necessidade de esquema/validação pesada |
| `node:http` puro | Zero dependência, mas reescreveria roteamento, parsing de formulário, CSRF e cabeçalhos: mais código de segurança próprio para manter |
| React/Next/Angular/SPA | Nada na investigação ou nos requisitos exige cliente rico; peso, superfície de XSS e acessibilidade por conta própria. Formulário + tabela cobrem RF-01..RF-12 |
| `tsx`/`ts-node`/build com `tsc` | O Node 24 já remove tipos; menos ferramenta, menos artefato (`dist/`). Custo: sintaxe limitada a "apagável" e `.ts` nos imports (aceitável) |
| `undici`/`fetch` | Precisaríamos do `lookup` para validar o IP resolvido e usar esse IP; `https.request` expõe `lookup` na stdlib |
| ORM (Drizzle, Prisma, Kysely) | 12 tabelas, SQL pequeno e revisável; ORM adiciona camada e dependência sem ganho |
| Zod/valibot | Entradas pequenas e bem conhecidas (URL, alvo, margem, e-mail, ambiente); validação à mão com testes de tabela |
| Jest/Vitest | `node:test` basta; um runner a menos |
| Playwright | A investigação mostra que HTTP + JSON resolve; Playwright seria detectável, pesado e confundido pelo redirect de produto esgotado |
| Docker obrigatório | Docker existe, mas o app é um processo Node; `Dockerfile` opcional |
| Python 3.14 | Risco de wheels (investigação, riscos); Node já cobre tudo |

## Consequências

- Positivas: 4 dependências de produção; `npm ci` e `npm start`; sem etapa de build; SQL e rede isolados; testes rápidos e offline.
- Negativas/riscos: `better-sqlite3` é addon nativo (depende de binário pré-compilado por plataforma; em plataforma sem binário exigiria toolchain C++) e a major mudou rápido; `.ts` com extensão nos imports e sem `enum`/parameter properties; TypeScript 7 é recente (só portão de tipos, não afeta a execução); Hono tem menos tempo de estrada que Express (superfície pequena mitiga).
- Reversão: trocar o driver ou o servidor web toca só `db/`, `*.repo.ts` e `web/`.
