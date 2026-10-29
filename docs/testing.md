# Estratégia de testes: Vans Price Watcher

Versão 0.1 (2026-10-14). Requisitos: `docs/requirements.md` (critérios Dado/Quando/Então). Mapa REQ -> teste: `docs/traceability.md` (IDs `T-<área>-nn`). Arquitetura: `docs/architecture.md`.

> **ADR-0006 (2026-10-15): o produto agora é uma extensão MV3.** As camadas e os IDs `T-*` continuam; a estratégia para a extensão (API `chrome` falsa, `Db` em memória, autoteste do IndexedDB, varreduras de `dist/`) está em `docs/extension-architecture.md` seção 14; a tarefa E34 a incorpora aqui.

## 1. Princípios

1. **Offline por padrão.** `npm test` não toca a internet (RNF-TEST-01/02). Um preload (`tests/helpers/no-network.ts`) faz `net.Socket.prototype.connect`, `dns.lookup` e `tls.connect` falharem para qualquer destino que não seja `127.0.0.1`/`::1` (o e2e sobe o próprio servidor em loopback). Um teste (`T-TST-01`) prova que o bloqueio funciona.
2. **Tempo e aleatório injetados.** Código de negócio só usa `Clock` e `Random` (`architecture.md` 3.2). `ManualClock` avança sem esperar; nenhum teste usa `setTimeout` real nem `sleep`. Um teste de varredura falha se `Date.now(`, `new Date(`, `setTimeout(` ou `Math.random(` aparecerem em `src/` fora de `shared/clock.ts` e `shared/random.ts`.
3. **Coletor substituível.** Serviços testam com `FakeSource`; os parsers testam com `FakeHttpClient` servindo fixtures por URL. Nada de mock de `fetch` global.
4. **Banco real, em memória.** Integração usa `better-sqlite3` com `:memory:` e as migrações reais (`tests/helpers/db.ts`), nunca um SQLite falso. Assim as `CHECK`/`UNIQUE` do `data-model.md` são parte do que se testa.
5. **Teste do invariante, não só do exemplo.** RNF-REL-01 (nenhuma notificação sem observação confirmada, disponível, válida e na faixa) é verificado por propriedade com PRNG semeado.
6. **Cada teste cita o ID** da `traceability.md` no nome (`test('T-BND-02 ...')`). A tarefa de QA mantém a matriz atualizada e confere que todo `RF-xx-ACy` tem pelo menos um teste.

## 2. Ferramentas

| Necessidade | Escolha |
|---|---|
| Runner e asserções | `node:test`, `node:assert/strict` |
| TypeScript | execução direta pelo Node 24; `npm run typecheck` (`tsc --noEmit`) é parte do portão |
| Cobertura | `node --test --experimental-test-coverage --test-coverage-lines=80 --test-coverage-branches=80` (nativo). 100% de ramos em `price-compare.ts` e `shared/money.ts` verificado por teste que lê o relatório de cobertura por arquivo (ou execução separada com limite 100 só nesses arquivos) |
| Propriedade | `tests/helpers/prng.ts` (mulberry32 semeado, 200-1000 iterações; imprime a semente na falha) |
| HTTP do app | `app.request()` do Hono (sem porta) para integração; servidor real em porta 0 (loopback) só no e2e |
| SMTP | `FakeMailer`; `SmtpMailer` testado contra um servidor SMTP falso mínimo em loopback (só valida TLS-obrigatório/erros, sem enviar a lugar algum), S |
| Rede hostil | `https.createServer` local com certificado de teste gerado em memória, para redirects e corpo gigante (T-FLH-09/10), com `lookup` e CA de teste injetados no construtor do `SafeHttpClient` (parâmetros só de teste; nunca lidos de ambiente e sem desligar a verificação de certificado) |

Scripts: `test` (unit+contract+integration+e2e+security), `test:cov`, `test:live` (separado), `typecheck`. `npm test` sai com erro se algum teste falhar; o portão local de "pronto" é `typecheck && test:cov`.

## 3. Camadas

| Camada | Pasta | O que cobre | Dependências reais | Exemplos |
|---|---|---|---|---|
| Unitário | `tests/unit/` | Funções puras e validações | nenhuma | `classifyBand` (tabela de 5.4 + extremos + monotonicidade), `valueToCents` (ruído `99.99000000000001`), `parseBrlToCents` (`379,99`, `1.234,50`, `379,999`...), `decideConfirmation`, `evaluateAlert` (tabela de 6.1), `extractProductCode` (URLs válidas e hostis), `freshness`, `backoff`, `circuit`, `maskEmail`, `render` (snapshot de texto), máquina de notificação |
| Contrato | `tests/contract/` | Parsers e fontes contra as fixtures | fixtures em arquivo | `OccSource` com `occ_disc_1003800580026U.json` (13 variantes 33-45, `legacySKU`, `ean` null), SSR com `nextdata_*.json`, `occ_404.json` -> `produto_removido`, `product_disc_oos_*` -> `available=false` com preço 149,99, `hasPriceVariations:true` sintético, estrutura sem `baseOptions[0].options` -> `formato_desconhecido`, concordância OCC x SSR x dynamic (T-MON-07), todos os coletores cumprem a mesma interface (T-MNT-01), parser de listagem com `search.sapatos.page0.sample.json` |
| Integração | `tests/integration/` | Módulos juntos com banco real e relógio/coletor/e-mail falsos | SQLite `:memory:` | ciclo completo de um produto, travas e rearme, idempotência (2 avaliações = 1 notificação), atomicidade (falha injetada no meio do `TX` não deixa estado parcial), scheduler (rodada sobreposta, recuperação na partida, mínimo 2 h, orçamento, circuito), notificações (retentativas 5 min/30 min/2 h), migrações, repositórios, `/saude` |
| E2E | `tests/e2e/` | Jornadas J-1..J-6 pela HTTP do próprio app, loja falsa | servidor Hono em loopback, SQLite em arquivo temporário | cadastrar por URL -> escolher tamanho -> criar alerta -> rodada com `FakeSource` -> e-mail simulado -> dashboard mostra "aceito pelo provedor"/"simulado"; pausa/retoma/exclui; erro de validação acessível |
| Segurança | `tests/security/` | RNF-SEC/PRIV, `security.md` seção 7 | resolvedor falso, servidores locais | ver seção 6 |
| Live (separado) | `tests/live/` | Contrato real da loja | **internet** | seção 7 |

Pirâmide alvo: maioria unitária e de contrato (rápidos, sem I/O), integração para as regras com estado, e2e curto (5-8 cenários).

## 4. Fixtures

Fonte: `tests/fixtures/vans/` (já capturadas, investigation). Uso por área:

| Fixture | Usada para |
|---|---|
| `occ_disc_1003800580026U.json` | parser OCC (Hylane 649,99 -> 379,99, 33-36 disponíveis 5/11/14/4, 37-45 não (13 variantes), `legacySKU`, `ean` null), RF-02-AC6 (13-15 variantes), `colorOptions` |
| `occ_dynamic_1003800580026U.json`, `occ_dynamic_1002000690063U.json` | concordância de preço (T-MON-07) |
| `occ_nodisc_1002002760052U.json` | sem desconto (Knu 699,99; `discountPrice` ausente) |
| `occ_white_1002000690063U.json`, `occ_white_variant_40.json`, `product_disc_oos_1002000690063U.html` | sem estoque total, `lowStock` com nível 0, preço 149,99 (RN-06/08, T-FLH-06) |
| `occ_404.json`, `product_404.html` + headers | `produto_removido` |
| `nextdata_1003800580026U.json`, `nextdata_1002000690063U.json`, `product_*.html` | fallback SSR (`degradada`), `variantOptions[].url=""`, tamanho por `displayText`, `percentualOfDiscount=""` |
| `product-era-navy.html` (ou `product_disc_oos_1002000690002U.html`; manter 1) | Era Navy 99,99 com ruído de float (T-TGT-03) |
| `api-products-search-query-era.json`, `search.sapatos.page0.sample.json` | catálogo e busca local (T-CAT-01/04); `stock` é `{}` |
| `robots.txt`, `*.headers*` | teste de que nenhuma URL gerada pelo sistema cai em `Disallow` (T-SEC-01/S20); cabeçalhos de redirect 301 / slug errado 200 |
| `sitemap*.xml`, `tenis.raw.html`, `cat-sapatos.html` | não usadas na suíte do MVP (sitemap é S) |

Regras:

1. **Sanitização (investigation C10).** `scripts/sanitize-fixtures.ts` remove `fbclid`, `utm_*`, cookies e `Set-Cookie`. `tests/security/fixtures-clean.test.ts` falha se algum aparecer em `tests/fixtures/`. A fixture `product_disc_instock_1003800580026U.html` precisa ser sanitizada antes de ser usada.
2. **Duplicatas (C9).** Manter `product-era-navy.html` **ou** `product_disc_oos_1002000690002U.html`, e `cat-sapatos.html` **ou** `sapatos.raw.html`; remover a outra.
3. **Lacunas (investigation 10b.2, RNF-TEST-04).** Faltam OCC de Era Navy e Knu dynamic: capturar com `scripts/capture-fixtures.ts` (manual, 1 requisição por vez, 2-5 s) e sanitizar antes dos contratos finais. Até lá, T-TGT-03 usa o SSR.
4. **Fixtures sintéticas** (derivadas por edição mínima de JSON, em `tests/helpers/fixtures.ts`, não gravadas como arquivo novo): preço 0, negativo, `NaN`, texto, `discountPrice > price`, >2 casas, `hasPriceVariations:true`, sem `baseOptions[0].options`, variação de 80% entre leituras.
5. Nenhum teste lê `tests/fixtures/` por caminho relativo ao CWD: `tests/helpers/fixtures.ts` resolve a partir de `import.meta.url`.

## 5. Relógio controlável

```ts
// tests/helpers/clock.ts (contrato)
export class ManualClock implements Clock {
  constructor(start: string | Date);        // ex. '2026-10-14T12:00:00.000Z'
  now(): Date;
  advance(ms: number): Promise<void>;       // avança e resolve, em ordem, os sleep() vencidos
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
```

Cenários que dependem dele: frescor nos limites exatos 8 h e 24 h (T-SAU-03), rearme em 24 h e anti-flapping (T-DUP-02), retentativas 5 min/30 min/2 h (T-NOT-04), circuito 24 h e sonda (T-FLH-08), rodada de recuperação (T-MON-04), orçamento diário em janela deslizante (T-REL-04), rodada de 50 produtos respeitando 2-5 s sem demorar de verdade (T-PRF-01), pausa > 24 h descarta `PENDENTE` (T-WEB-03). Todos avançam o relógio de forma determinística; a suíte inteira deve rodar em poucos segundos.

## 6. Segurança (`tests/security/`)

| Teste | Verifica | Ref. |
|---|---|---|
| Tabela de URLs hostis (`http:`, `vans.com.br.evil.test`, `www.vans.com.br@evil.test`, `:8443`, IP literal, `file:`, sem `/p/`, sufixo `-40`, credenciais, `%2e%2e`, unicode homógrafo) | rejeição e **zero** chamadas ao `HttpClient` (`FakeHttpClient` que falha se chamado) | S1 |
| `validateOutboundUrl` e allowlist exata | a lista é exatamente a prevista (regressão) | S5 |
| Resolvedor falso devolvendo IPs proibidos (todos os intervalos de S3) | `lookup` recusa; conexão não é feita | S3 |
| Servidor HTTPS local com redirect para host fora da lista, para outro host da lista, para `/login`/`/cart`, `http:`, 4 saltos; `Location` relativo; qualquer 3xx no OCC/listagem | `host_nao_autorizado`/`formato_desconhecido` sem seguir; só `/{slug}/p/{mesmo code}` no mesmo host é seguido | S2 |
| Resolvedor falso que devolve `all: true` com 1 endereço público + 1 proibido; hostname com ponto final (`www.vans.com.br.`) | conexão recusada por inteiro; URL rejeitada | S3, S1 |
| `RateGate` com `ManualClock`: 3 chamadas concorrentes (rodada + cadastro por URL + catálogo) | 1 em voo, espaço 2-5 s entre elas, 1 linha em `outbound_requests` por chamada; orçamento 400 recusa a 401ª | S13, T-REL-06 |
| `POST` com `Content-Type` diferente de form, sem `Origin` | 403/415, nenhuma mutação | S9 |
| Corpo > 2 MB (inclusive gzip bomb) e `Content-Type` inesperado; resposta que nunca termina | descartado/abortado dentro de 15 s com relógio falso | S4 |
| Varredura estática de `src/`: SQL concatenado, `raw(`, `Date.now(`, `Math.random(`, imports de `node:https`/`node:http`/`node:net`/`fetch(`/`nodemailer` fora dos arquivos permitidos, `process.env` fora de `config.ts`, `rejectUnauthorized: false` | regras de fronteira e de segurança | S6, S7, S16, arq. 2 |
| Produto com nome `<script>`/`"><img onerror>`, e-mail com `<b>`, `q=<script>` | escapado em HTML da UI e do e-mail; CSP presente | S7, S8 |
| E-mail com CR/LF, vírgula, `Bcc:` | recusado na validação; subject imune | S8 |
| `POST` sem `Origin`, com `Origin` estranho, `Host` estranho | 403/421; nenhuma mutação | S9, S10 |
| Cabeçalhos de segurança em todas as respostas | RNF-SEC-06 | S4 de security |
| `EMAIL_MODE` padrão `test`; `real` sem `SMTP_*` falha nomeando a variável, sem o valor | RNF-SEC-05 | S11 |
| Captura de todos os logs de um ciclo completo + notificação + falha | nenhum e-mail, corpo, credencial, `Cookie`; só campos de `LogFields` | S11, S12 |
| `/saude` | sem PII, sem segredo, < 200 ms, sem rede | RF-12-AC5 |
| URLs que o sistema gera (coleta, catálogo) contra o `robots.txt` da fixture | nenhuma em `Disallow` | S20 |
| Fixtures sem `fbclid`/UTM/cookies | RNF-PRIV-02 | S12 |

## 7. Testes live (separados)

`tests/live/*.live.test.ts`, executados só por `npm run test:live` (define `LIVE=1`; sem ele, os arquivos fazem `skip`). **Nunca** no `npm test`, nunca em CI.

- Objetivo: detectar mudança do contrato da loja (R-01), não validar lógica.
- Escopo: no máximo ~6 requisições por execução, sequenciais, 2-5 s de intervalo, UA do projeto, mesma allowlist (usam o `SafeHttpClient` de produção): `OCC /products/1003800580026U` (200, estrutura esperada: `baseOptions[0].options` não vazio, `price.value` numérico > 0, tamanho em `displayText`), `dynamic-product-fields`, HTML `/p/1003800580026U` (301 e `__NEXT_DATA__` presente), `robots.txt` (ainda sem `Disallow` para `/p/*` que afete a coleta).
- Asserções **estruturais**, não de valor: o preço muda; um preço fixo quebraria à toa. Compara só o conjunto de chaves esperado.
- Se o live receber 403/429/desafio: o teste **para** e falha com mensagem "não insistir"; não repete.
- Mudança detectada -> `scripts/capture-fixtures.ts` captura novas fixtures, `sanitize-fixtures.ts` limpa, atualizam-se parsers e contratos (investigation 8.5).
- Resultado informativo; registrar data e status em `operations.md`/notas. Execução sugerida: manual, no máximo 1x por dia.

## 8. Matriz de cobertura por requisito (resumo)

O detalhe linha a linha é `docs/traceability.md`. Cobertura planejada por prioridade:

| Área | Camadas | Gate |
|---|---|---|
| RN-01..05 (preço), RF-04, RF-05 | unitário + contrato | 100% de ramos em `money.ts`/`price-compare.ts` |
| RN-06..09, RF-11 | contrato + integração | invariante por propriedade |
| RN-11..16, RF-10 | unitário (máquina) + integração (banco) | >= 80% linhas/ramos em `alerts` |
| RF-06, RF-12, scheduler | integração com `ManualClock` | cenários T-MON, T-REL, T-SAU |
| Notificações RF-08 | unitário + integração + e2e | >= 80% em `notifications` |
| Web RF-09 e a11y | integração (`app.request`) + e2e | a11y: ver 9 |
| Segurança | seção 6 | todo `S*` com teste ou revisão manual declarada |

Gate geral (RNF-TEST-03): >= 80% de linhas e ramos em `price-monitor`, `alerts`, `notifications`; as exceções (código de bootstrap `main.ts`, `mailer.smtp.ts` além do que o SMTP falso cobre) precisam justificativa no PR.

## 9. Acessibilidade e UI

Automático (sem navegador): testes em `app.request()` verificam por parsing do HTML (um mini helper com regex/`node:test`, sem dependência): todo `input`/`select`/`textarea` tem `label for` correspondente; erros têm `id` referenciado por `aria-describedby` e `aria-invalid="true"`; cada página tem `lang="pt-BR"`, um `h1`, `<title>` único; tabelas têm `th scope`; botões e links têm texto. Manual (M, RF-09-AC8, RNF-ACC-01): navegação só por teclado, foco visível, contraste (checagem de tokens do CSS), zoom 200%, largura 360 px sem rolagem horizontal. Registrar o resultado no PR da tarefa de UI.

## 10. Dados de teste e organização

- `tests/helpers/db.ts`: `makeDb()` (migrado, `:memory:`), `seedProduct()`, `seedAlert()`.
- `tests/helpers/fixtures.ts`: `fixture(name)`, construtores sintéticos de JSON adulterado.
- `tests/helpers/app.ts`: monta o app Hono com `FakeSource`, `FakeMailer`, `ManualClock`.
- Nomes de arquivo `*.test.ts`; um arquivo por unidade/tema; sem estado global entre testes; cada teste cria seu banco.

## 11. Definição de pronto (QA)

Uma tarefa só está pronta quando: tipos ok (`typecheck`), testes da tarefa verdes e citando os IDs da `traceability.md`, cobertura do módulo no gate, nenhum teste live acionado, nenhuma fixture nova com PII, e a linha correspondente na matriz atualizada.
