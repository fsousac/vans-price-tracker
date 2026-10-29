# Segurança: Vans Price Watcher

Versão 0.1 (2026-10-14). Requisitos de origem: RNF-SEC-01..06, RNF-PRIV-01..03, RNF-LEG-01/02, riscos R-10..R-13 de `docs/requirements.md`. Arquitetura: `docs/architecture.md`. Testes: `docs/testing.md` (camada "segurança").

> **ADR-0006 (2026-10-15): o produto é uma extensão MV3.** As seções 1-8 descrevem o servidor local e ficam como histórico; **vigora a seção 9** (superfície da extensão). S1, S4, S13, S15 e S20 seguem valendo adaptadas; S3, S9, S10, S16, S18 e S19 deixam de existir; as demais foram substituídas por X-números (mapa em 9.2).

## 1. Escopo e modelo de ameaça

Ativo a proteger, em ordem: (1) a loja e o dono contra uso abusivo (não ser banido, não virar relé); (2) a integridade do alerta (nenhum falso alerta nem preço falso); (3) o e-mail do usuário (PII); (4) segredos (SMTP); (5) a máquina local do dono (SSRF, XSS, CSRF a partir de páginas maliciosas no navegador do dono).

Superfícies: entrada do usuário (URL colada, alvo, e-mail, busca), dados vindos da loja (JSON/HTML hostil ou alterado), servidor HTTP local, saída de e-mail, banco de arquivo, variáveis de ambiente, agendador.

Fora do MVP (ver seção 8): atacante remoto direto na aplicação, multiusuário, contas.

## 2. Ameaças e controles

Legenda de severidade no MVP local: A alta, M média, B baixa.

| # | Ameaça | Cenário | Sev. | Controles | Teste |
|---|---|---|---|---|---|
| S1 | **SSRF por URL colada** | Usuário (ou página maliciosa via CSRF) cola `http://169.254.169.254/`, `https://www.vans.com.br@evil.test/`, `https://vans.com.br.evil.test/`, IP literal, porta 8443, `file:` | A | A URL do usuário **nunca é buscada**: `extractProductCode` faz `new URL()`, exige `https:`, `hostname === 'www.vans.com.br'` exato, porta vazia/443, sem `username/password`, caminho `^/(?:[a-z0-9-]+/)?p/([A-Za-z0-9]{8,20})$`; extrai só o `code`; a URL de consulta é montada pelo sistema a partir de constantes. Query e fragmento descartados (`fbclid`, UTM). | T-URL-02, T-SEC-01 |
| S2 | **SSRF por redirect** | A loja (ou um MITM) responde 30x para outro host, `http:` ou IP interno | A | `SafeHttpClient`: redirects manuais. **OCC e listagem: nenhum redirect é seguido** (3xx = falha); **página de produto: máx. 3**, cada salto revalidado pelo mesmo `validateOutboundUrl` (https, host **igual ao da requisição original** e na allowlist exata, porta 443, sem credenciais, caminho `/{slug}/p/{mesmo code}`; assim um 30x para `/login`, `/cart` ou outro subdomínio da lista não é seguido); `Location` relativo resolvido contra a URL atual; falha = `host_nao_autorizado` sem seguir. O cliente não mantém cookie jar (o OCC emite `Set-Cookie: JSESSIONID`, inclusive em respostas 400) | T-FLH-09 |
| S3 | **DNS rebinding / IP interno na saída** | `www.vans.com.br` passa a resolver para `127.0.0.1`/rede privada (ou resolução maliciosa) | M | `https.request({ lookup })` com `lookup` customizado (no Node 24 o `autoSelectFamily` padrão chama `lookup` com `all: true` e espera um array: o `lookup` deve tratar as duas formas e **rejeitar a resolução inteira se qualquer endereço retornado for proibido**, nunca filtrar e seguir): resolve, **rejeita** loopback, privado (10/8, 172.16/12, 192.168/16), CGNAT 100.64/10, link-local 169.254/16 (inclui metadados de nuvem), `::1`, `fc00::/7`, `fe80::/10`, IPv4 mapeado em IPv6, `0.0.0.0`, multicast; o IP validado **é o usado na conexão** (sem segunda resolução); SNI e `Host` mantêm o nome; TLS com verificação padrão (`rejectUnauthorized: true`, nunca desligado) | T-SEC-01 (resolvedor falso) |
| S4 | **Resposta hostil/gigante** | Corpo de GB, resposta lenta (slowloris), JSON profundo, tipo inesperado | M | Timeout de conexão 5 s e total 15 s; corpo lido em stream e abortado em 2 MB; `Content-Type` só `application/json`/`text/html`; descompressão (`gzip`/`br`) com o mesmo limite aplicado ao corpo **descomprimido**; `JSON.parse` em try/catch e profundidade limitada pelo tamanho; parser só lê campos nomeados (nada de `eval`, nada de `Object.assign` do JSON em objetos internos); `__NEXT_DATA__` extraído por delimitadores do `<script id="__NEXT_DATA__">`, não por regex gananciosa | T-FLH-10 |
| S5 | **Allowlist ampla demais** | Alguém adiciona `*.vans.com.br` | M | Lista **exata** em constante única: `www.vans.com.br` apenas no MVP (`secure-static.vans.com.br` só entra com ADR quando o sitemap, S, for implementado; hoje seria superfície sem uso). Teste de regressão fixa a lista. Mudança de lista exige ADR | T-SEC-01 |
| S6 | **Injeção SQL** | Nome de produto vindo da loja, busca de catálogo, e-mail | A | SQL só em `*.repo.ts`, sempre parametrizado (`?`/`@x`); nenhuma concatenação (teste de varredura proíbe template literal com `${` em `prepare(`/`exec(` fora de `migrations`); `LIKE` com `ESCAPE '\'` e escape dos curingas da busca; `CHECK`s no esquema como segunda barreira; tabelas `STRICT` | T-SEC-04 |
| S7 | **XSS na UI** | Nome do produto, slug, e-mail ou mensagem de erro com `<script>`; reflexão de `q`/`url` | A | `hono/html` escapa toda interpolação (nada de `raw()` com dado externo; teste de varredura proíbe `raw(`/`unsafe` fora de `views/layout.ts` com literais); CSP `default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` (sem `script-src`: **nenhum JS** é permitido, então XSS por script não executa mesmo se escapar); links externos montados só de `code` e slug filtrado `[a-z0-9-]`; `rel="noopener noreferrer"`; sem `innerHTML` (não há JS) | T-SEC-04, T-SEC-06 |
| S8 | **Injeção/XSS em e-mail** | Nome do produto com HTML ou CR/LF no assunto; destinatário `a@b.co\nBcc: x@y.z` | A | Validação de e-mail: regex simples + sem espaço, `,`, `;`, `<`, `>`, CR/LF, <= 254; assunto de **modelo fixo** + valores controlados (tipo, preço formatado, tamanho); nome do produto passa por `stripControl` e limite de 80 caracteres e só entra no corpo; HTML com escape de `& < > " '`; **sem** imagens/links remotos de terceiros (só o link do produto); `text/plain` é a parte principal; nodemailer codifica cabeçalhos | T-NOT-01, T-NOT-07 |
| S9 | **CSRF contra localhost** | Página maliciosa no navegador do dono faz `POST http://127.0.0.1:PORT/alertas/1/excluir` ou cria alertas para e-mail do atacante | M | `hono/csrf` com `origin` exato (`http://127.0.0.1:PORT`, `http://localhost:PORT`) em todo `POST`; requisição sem `Origin` válido = 403; mutação só por `POST`; `GET` sem efeito colateral; `SameSite` não se aplica (sem cookie/sessão); formulários de exclusão exigem passo de confirmação | T-WEB-05, T-SEC-04 |
| S10 | **DNS rebinding contra o servidor local** | Domínio do atacante passa a resolver para 127.0.0.1 e o navegador lê respostas | M | Bind em `127.0.0.1` por padrão; `host-guard` rejeita (421/403) qualquer `Host` fora de `127.0.0.1:PORT`/`localhost:PORT`; sem CORS (não envia `Access-Control-Allow-*`); `/saude` sem PII | T-WEB-06 |
| S11 | **Segredos expostos** | Senha SMTP em log, erro, `/saude`, fixture, `.env` versionado | A | Segredos só por variável de ambiente; `.env` no `.gitignore`; `.env.example` sem valores; `config.ts` valida na partida e, ao falhar, nomeia a **variável** ausente, nunca o valor; objeto de configuração com `SMTP_PASS` marcado `toJSON(){ return '[redacted]' }` e tipo sem passagem para o logger; `/saude` só mostra `email_mode`; varredura do repositório por padrões de segredo no portão de testes | T-SEC-05 |
| S12 | **PII (e-mail) em logs, banco e fixtures** | E-mail do alerta em log, `notifications`, backups, fixtures com `fbclid`/UTM/cookie | M | `LogFields` fechado (sem campo livre); `notifications` não guarda destinatário; log do modo teste: só `{kind, alert_id, price_cents}`; sink de arquivo é opt-in e documentado como PII local; fixtures sanitizadas e teste que falha se `fbclid`, `utm_`, `Set-Cookie`, `Cookie:` aparecerem em `tests/fixtures/`; corpo bruto de falha passa por `sanitizeBody` (remove cookies, tokens, UTM, `fbclid`), 1 por produto, 256 KiB, fora dos logs; exclusão do alerta apaga o e-mail | T-PRV-01..03, T-NOT-05 |
| S13 | **Abuso do agendador / carga sobre a loja** | Intervalo mínimo, muitos produtos, `POST /monitor/executar` ou `POST /produtos/url` ou `POST /catalogo/atualizar` em laço, bug que reinicia o laço, conflito de duas instâncias do app | A | Intervalo 2-6 h validado na partida; **mínimo de 2 h por produto** no `dueForCollection` (vale para manual também); teto 50 produtos e 400 req/24 h de **qualquer origem** (rodada, cadastro por URL, catálogo, sonda; somando retentativas e fallbacks, contadas em `outbound_requests`); 1 requisição por vez **no processo todo e espaçadas 2-5 s pelo `RateGate`**, inclusive as disparadas por rotas web (cadastro de produto lido há < 2 h usa o banco); ações web que geram requisição são recusadas com o orçamento esgotado; uma rodada por vez (índice único no banco, vale entre processos); disjuntor 24 h em 403/desafio/429 repetido/3 falhas de transporte; sem retentativa agressiva; UA identificável e **fixo** (`VansPriceWatcher/0.1 (uso pessoal)`), nunca trocado para evadir; `Retry-After` respeitado; atualização de catálogo 1/24 h; segundo processo contra o mesmo banco: o índice único impede 2 rodadas e o `claimDue` com lease impede envio duplo, mas **só 1 instância é suportada** (ambas rodam `tick`; o `RateGate` é por processo, então duas instâncias dobrariam a cadência: documentado em `operations.md`) | T-MON-02/03, T-REL-03/04, T-FLH-08 |
| S14 | **Uso como relé de e-mail** | Campo de e-mail livre + servidor exposto => spam | A (público) / B (local) | MVP: bind local, modo teste padrão (`EMAIL_MODE=test` não envia nada); limite global de 20 e-mails/h; dedupe por trava + cooldown de 24 h garante no máximo 1 e-mail por (alerta, tipo) por 24 h, salvo edição do alvo pelo próprio dono (`revision++`); apenas texto fixo (o usuário não controla o corpo); `FALHA` sem reenvio automático (D-30); para público: verificação de propriedade do e-mail, descadastro e limites (seção 8) | T-NOT-02/04 |
| S15 | **Falso preço / falso alerta (integridade)** | Campo inconsistente, `formattedValue` parseado, JSON adulterado, preço 0 | A | `value` -> centavos com rejeição de >2 casas reais; `CHECK` no banco; confirmação por leitura concordante; invariante RNF-REL-01 em teste de propriedade; falha de extração só vira `run_items` | T-RN-01, T-FLH-02, T-RN-13 |
| S16 | **TLS e transporte SMTP** | Credencial em texto claro, certificado não verificado | M | `SMTP_SECURE=true` (465) ou `requireTLS: true` (587); `tls.rejectUnauthorized` nunca `false`; porta/host validados na partida; credencial só em memória | T-NOT-03 |
| S17 | **Cadeia de suprimentos** | Dependência maliciosa/vulnerável | M | 4 dependências de produção; versões exatas e `package-lock.json` versionado; `npm ci` em ambiente limpo; `npm audit` e conferência de versões ao atualizar; nada de scripts `postinstall` próprios; `better-sqlite3` usa binário pré-compilado do pacote (verificado no ambiente) | revisão manual |
| S18 | **Path traversal / arquivo** | Nome de arquivo do sink de e-mail ou backup vindo de entrada | B | Nomes de arquivo derivados só de ids numéricos e timestamps gerados pelo sistema; diretório fixo `data/`; sem rota que leia arquivo por nome; `/static/` serve só `public/app.css` (lista fixa, não `serveStatic` de diretório) | T-SEC-04 |
| S19 | **Erros que vazam detalhes** | Stack trace, caminho do disco, SQL na resposta | B | `onError` devolve página genérica + `request_id`; detalhes só no log estruturado (sem PII); modo de depuração inexistente no MVP | T-SEC-04 |
| S20 | **Conformidade/legal** | Violar `robots.txt`, termos de uso, copiar conteúdo | M | Nunca coletar `/search*`, `?q=:`, `/cart`, `/checkout`, `/login`, `/my-account`, `/wish-list` (teste de URLs geradas); só `category=SAPATOS` e `/products/{code}`; dados mínimos (SKU, nome, preço, URL, disponibilidade), sem imagens/descrições; parar ao bloqueio sem evasão; uso pessoal; revisão jurídica antes de público (R-02) | T-SEC-01, T-RN-17 |

## 3. Controles de segredo e configuração

Variáveis (ver `.env.example`; **nenhum valor real no repositório**):

| Variável | Padrão | Observação |
|---|---|---|
| `PORT` | `3000` | |
| `BIND_HOST` | `127.0.0.1` | Outro valor exige `ALLOW_NON_LOCAL_BIND=1` e emite aviso na partida (RNF-SEC-03). Sem autenticação: ver seção 8 |
| `DB_PATH` | `data/vans-alert.db` | |
| `MONITOR_INTERVAL_HOURS` | `4` | 2-6, senão a partida falha |
| `EMAIL_MODE` | `test` | `real` exige `SMTP_*` completos; faltando uma, falha a partida citando o nome |
| `EMAIL_TEST_SINK` | `none` | `file` grava `.eml` local (PII local) |
| `OWNER_EMAIL` | vazio | destinatário dos avisos `SAUDE`; vazio = só painel |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | vazios | segredos: `SMTP_PASS` (e `SMTP_USER`) |
| `LOG_LEVEL` | `info` | |
| `MONITOR_ENABLED` | `1` | `0` desliga o agendador (web continua) |
| `CONFIRM_REREAD` | `1` | `1` = 1 releitura imediata de leitura suspeita do OCC (RN-09); `0` = espera a rodada seguinte |

Regras: (1) `config.ts` é o único lugar que lê `process.env`; (2) objeto de config é congelado; (3) nada de `console.log(config)`; (4) mensagens de erro de config citam a chave, não o valor; (5) `.env` nunca é lido de caminho vindo de entrada.

## 4. Cabeçalhos de resposta (RNF-SEC-06)

`Content-Security-Policy` (acima), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `X-Frame-Options: DENY`, `Cache-Control: no-store` nas páginas com dados do usuário. Sem `Server`/`X-Powered-By` informativo.

## 5. Privacidade e retenção (LGPD no nível do MVP)

Dado pessoal tratado: e-mail do alerta (finalidade: enviar o aviso). Minimização: nada além do e-mail; sem IP de cliente, sem User-Agent do cliente, sem analytics. Retenção: enquanto o alerta existir; excluir apaga o e-mail e as notificações (cascade). Backups por cópia a frio contêm o e-mail: documentado em `operations.md`. Titular único (o próprio dono); consentimento e direitos de titular ganham fluxo só no deploy público (seção 8).

## 6. Resposta a incidente (mínimo)

| Evento | Ação |
|---|---|
| Circuito global aberto (403/desafio/429) | Nada a fazer por 24 h; revisar `run_items` por status; **não** reduzir intervalo nem trocar UA. Se persistir, parar o monitor (`MONITOR_ENABLED=0`) e avaliar manualmente |
| Suspeita de credencial SMTP vazada | Rotacionar a senha no provedor; reiniciar com a nova; revisar `data/outbox/` e logs |
| E-mails indevidos enviados | `EMAIL_MODE=test`, pausar alertas, auditar `notifications` por `idempotency_key` |
| Banco corrompido | Restaurar o backup a frio ou o `VACUUM INTO` pré-migração |

## 7. Verificações automáticas (portão de segurança)

`tests/security/` roda no `npm test` (sem rede): tabela de URLs hostis (S1), allowlist e IP (S2/S3), limites de corpo e tipo (S4), varredura de SQL concatenado (S6), varredura de `raw(` (S7), CRLF e HTML em e-mail (S8), `Origin`/`Host` (S9/S10), logs sem PII e sem segredo (S11/S12), fixtures sem `fbclid`/UTM/cookie (S12), cabeçalhos (RNF-SEC-06), imports de rede restritos a `safe-http.ts` e `mailer.smtp.ts` (fronteira 5 de `architecture.md`). Detalhe em `testing.md`.

## 8. Limites para deploy público (documentar, não implementar)

O MVP é de usuário único, local, **sem autenticação** (D-29). Expor `BIND_HOST` fora de `127.0.0.1` sem o que segue é inseguro. Antes de qualquer deploy público (requirements, seção 8):

1. **Autenticação e autorização** por usuário; coluna `user_id` em `price_alerts` e filtro em toda consulta (hoje não há; qualquer pessoa que alcance a porta administra tudo). IDs inteiros sequenciais nas rotas (`/alertas/:id`) seriam IDOR sem isso.
2. **Verificação de propriedade do e-mail** (dupla confirmação) e link de descadastro; sem isso o app é relé de spam (S14) e viola LGPD.
3. **Limite de taxa** por usuário/IP/rota; anti-bot nos formulários; limite de alertas por usuário.
4. **Coleta agregada por `code`** (já é o modelo) com **teto global** de requisições à loja; avaliação jurídica do volume (termos, `/arezzocoocc`).
5. **HTTPS obrigatório**, cookies `Secure`/`HttpOnly`/`SameSite`, CSRF por sessão; revisar CSP para o novo ambiente.
6. **Segredos em cofre** (não `.env`), rotação.
7. **Fila durável e worker fora do processo web**; monitoramento externo do agendador (hoje só roda com o app aberto).
8. **Reputação de e-mail** (SPF/DKIM/DMARC), tratamento de bounce/complaint; só então "entregue" é observável.
9. **Banco**: migrar de SQLite embarcado para servidor se houver múltiplas instâncias; backups automatizados.
10. **Política de privacidade, termos, base legal e processo de exclusão** do titular.
11. **Observabilidade externa** (alertas de erro, painel de saúde) e logs com retenção definida.

## 9. Superfície da extensão (vigente, ADR-0006)

Desenho: `docs/extension-architecture.md`. Ativos, em ordem: (1) a loja e o dono (não ser banido); (2) integridade do alerta (nenhum falso alerta); (3) segredo do provedor de e-mail e e-mail do dono (PII); (4) o navegador do dono (XSS em páginas da extensão, permissões). Sem servidor, sem porta, sem cookies da loja, sem conta: CSRF, DNS rebinding local, host-guard, SMTP, bind e SQL deixam de existir.

### 9.1 Ameaças e controles

| # | Ameaça | Cenário | Sev. | Controles | Teste |
|---|---|---|---|---|---|
| X1 | **Mensagem runtime hostil** | Página web, outra extensão ou script injetado envia `runtime.sendMessage` ao SW para criar/excluir alertas, ler ajustes ou disparar coleta | A | Sem `content_scripts`, sem `externally_connectable`, sem `web_accessible_resources` (páginas web não alcançam o SW); `onMessageExternal` não registrado; `onMessage` exige `sender.id === chrome.runtime.id` **e** `sender.url` com prefixo `chrome.runtime.getURL('')`; `type` fechado; payload validado campo a campo (`messages.ts`, `alerts/validation`, `url.ts`); só o SW escreve; erros pt-BR sem stack | E06, E29, E32 |
| X2 | **XSS nas páginas da extensão** | Nome de produto/slug/mensagem de erro vindo da loja, ou texto do usuário, com `<script>`/`onerror` | A | Render só por `createElement` + `textContent` (`dom.ts`); atributos por lista permitida; **proibidos** `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, atributos `on*` (varredura em `src/` e em `dist/`); CSP `default-src 'none'; script-src 'self'; object-src 'none'; style-src 'self'` (sem inline, sem eval, sem código remoto); links externos montados só de `code` validado (`https://www.vans.com.br/p/{code}`) com `rel="noopener noreferrer"`; a mesma regra no texto da `chrome.notifications` (texto puro, `stripControl`, <= 80) | E17, E32 |
| X3 | **Permissões excessivas** | Alguém adiciona `<all_urls>`, `tabs`, `cookies`, `scripting` ou `https://*/*` | M | Lista exata: `alarms`, `notifications`, `activeTab`, `unlimitedStorage`; host `https://www.vans.com.br/*`; opcional `https://api.resend.com/*`; teste do manifest fixa a lista e a CSP e proíbe chaves perigosas; mudança exige ADR. `activeTab` só dá a URL da aba quando o usuário clica no ícone | E02, E32 |
| X4 | **Segredo local (chave do provedor)** | Chave de API vaza por log, resposta de mensagem, erro, exportação ou sincronização | A | Guardada só em IndexedDB local da extensão (**nunca** `storage.sync`, nunca no manifest ou no bundle); `settings.get` devolve `apiKeySet: boolean`, jamais a chave; `Settings.toJSON` redigido; `LogFields` fechado (sem campo livre) e mensagens de erro do mailer sem cabeçalhos; campo da UI `type=password`, `autocomplete=off`, esvaziado após salvar; "Remover chave" apaga; recomendação na UI: chave Resend restrita a "envio" e domínio verificado. **Risco residual aceito:** a chave fica em claro no perfil do navegador (legível por malware local ou por quem tenha o perfil), como em qualquer extensão | E07, E13, E25, E32 |
| X5 | **SSRF, redirect e saída para host indevido** | URL colada, resposta 30x, ou bug monta URL para outro host | A | O `fetch` só recebe URL **montada pelo sistema** de constantes + `code` validado (`extractProductCode`); `validateOutboundUrl` (https, host exato, porta 443, sem credenciais) **e** allowlist de caminho antes de todo `fetch`; `redirect: 'manual'`: qualquer 3xx/`opaqueredirect` = `host_nao_autorizado`; `credentials: 'omit'`; `referrerPolicy: 'no-referrer'`; `connect-src` da CSP limita os hosts (segunda barreira); e-mail só para `https://api.resend.com/emails` (endpoint constante, não configurável, o que impede exfiltração para host arbitrário). DNS e TLS são do navegador | E05, E08, E32 |
| X6 | **Resposta hostil ou gigante** | Corpo de GB, lento, JSON profundo, tipo inesperado | M | Timeout 15 s (`AbortController`); corpo em stream abortado em 2 MB; tipos só `application/json`/`text/html`; parser só lê campos nomeados; `__NEXT_DATA__` por delimitadores; `JSON.parse` em try/catch; nada de `eval` | E05 |
| X7 | **Falso preço / falso alerta** | Campo inconsistente, `formattedValue`, JSON adulterado, preço 0, SW morto no meio do ciclo | A | Inalterado (S15): `value` -> centavos com rejeição de >2 casas; `StoreConstraintError` no lugar do `CHECK`; confirmação por leitura concordante; **ciclo de um produto em uma transação**; invariante RNF-REL-01 por propriedade; a rodada retomada nunca grava meia observação | E10, E27, E31 |
| X8 | **Carga abusiva sobre a loja** | Rodadas sobrepostas, retomadas em laço, "Executar agora" repetido, várias janelas/perfis | A | Inalterado (S13) adaptado: intervalo 2-6 h; mínimo de 2 h por produto (vale para o manual); teto 50 produtos e 400 req/24 h por perfil (`outbound_requests`), registradas **antes** da requisição; 1 requisição por vez no SW (`RateGate`) com cortesia 2-5 s + jitter; uma rodada por vez (lease de 90 s no banco); circuito 24 h em 403/desafio/2x 429/3 falhas de transporte; sem retentativa agressiva; `Retry-After` honrado; catálogo 1/24 h. Cada perfil/dispositivo com a extensão soma ao total: documentado | E09, E16, E28 |
| X9 | **PII e logs** | E-mail do dono em log, console do SW, notificação ou fixture | M | O destinatário vive só em `settings` (IndexedDB); `LogFields` fechado; logs e eventos de saúde sem e-mail/chave/corpo; amostra de falha passa por `sanitizeBody`; `notifications` não guarda destinatário; modo teste não registra destinatário; fixtures sem `fbclid`/UTM/cookie (teste existente) | E19, E32 |
| X10 | **Uso como relé de e-mail** | Extensão manda e-mail a terceiros | B | Um único destinatário (o dono) nos ajustes; corpo de modelo fixo (o usuário não controla o texto); teto 20/h; dedupe por chave + cooldown 24 h; `FALHA` sem reenvio automático; modo `teste` padrão; permissão do provedor opcional, por clique, revogável (`permissions.onRemoved` desliga o canal) | E19, E25 |
| X11 | **Injeção em e-mail** | Nome com HTML ou CR/LF; destinatário com quebra de linha e `Bcc:` | M | O corpo é JSON para a API (sem cabeçalhos SMTP montados à mão), mas mantém: `validateEmail` (sem CR/LF/`,`/espaço, <= 254), assunto de modelo fixo, nome `stripControl` <= 80, HTML com escape, sem imagens/links remotos de terceiros | E08, E32 |
| X12 | **Cadeia de suprimentos e artefato** | Dependência maliciosa; código remoto; bundle com `node:*` ou segredo | M | Zero dependências de execução; devDependencies `typescript`, `esbuild`, `@types/chrome`, `@types/node` com versões exatas e `package-lock.json`; `npm ci`; sem `postinstall` próprio; build falha em `node:*`; manifest/CSP sem código remoto; bundle legível (sem minificação) para o dono revisar; sourcemaps só em `--dev`; instalação por "carregar sem compactação" do build do próprio dono | E02, E32 |
| X13 | **Dados no perfil** | Outra pessoa com acesso ao perfil; modo anônimo; backups do SO | B | Dados só no perfil local (sem `storage.sync`, sem telemetria, sem analytics); extensão não habilitada em anônimo por padrão; desinstalar apaga tudo; excluir alerta apaga notificações; histórico guarda só SKU, nome, preço, disponibilidade (sem imagens/descrições, RN-21) | E11, E34 |
| X14 | **Conformidade com a loja** | Violar `robots.txt`/termos, evasão | M | Inalterado (S20): nunca `/search*`, `?q=:`, `/cart`, `/checkout`, `/login`, `/my-account`, `/wish-list` (teste das URLs geradas); só `category=SAPATOS` e `/products/{code}`; 403/429 param sem contornar; dados mínimos; uso pessoal. **Desvio:** o `User-Agent` não é controlável em `fetch` de extensão (cabeçalho proibido), então a identificação honesta de `access-policy.md` seção 4 item 1 não é possível; compensa-se com volume pessoal e parada em bloqueio | E05, E32 |

### 9.2 Mapa das ameaças antigas

| Antiga | Situação |
|---|---|
| S1 URL colada | Vale (`extractProductCode`, `tab.inspect`); reforçada por X5 |
| S2 redirect | Substituída por X5 (`redirect: 'manual'`, sem seguir nada) |
| S3 DNS rebinding na saída | Deixa de existir (o navegador resolve; host fixo e `connect-src`) |
| S4 resposta hostil | X6 |
| S5 allowlist ampla | X3 e X5 (host e caminho exatos) |
| S6 SQL | Deixa de existir; análogo: `StoreConstraintError` e varredura de `innerHTML` |
| S7 XSS | X2 |
| S8 injeção em e-mail | X11 |
| S9, S10 CSRF/rebinding no servidor local | Deixam de existir; análogo: X1 |
| S11 segredos | X4 |
| S12 PII | X9 |
| S13 abuso do agendador | X8 |
| S14 relé de e-mail | X10 |
| S15 falso preço | X7 |
| S16 SMTP/TLS | Deixa de existir; a API usa o HTTPS do `fetch` (verificação padrão do navegador) |
| S17 cadeia de suprimentos | X12 |
| S18 path traversal, S19 erros | Deixam de existir (sem arquivo nem servidor); erros de mensagem sem stack em X1 |
| S20 conformidade | X14 |

### 9.3 Segredos e configuração

Não há variáveis de ambiente nem `.env`. Configuração em `kv.settings` (EA 7.3): `intervalHours` (2-6, padrão 4), `email.mode` (`teste` padrão | `real`), `email.enabled`, `email.to`, `email.from`, `email.apiKey`. `real` só salva com a permissão de host concedida e chave/remetente/destinatário válidos; a UI nomeia o campo faltante, nunca o valor.

### 9.4 Resposta a incidente

| Evento | Ação |
|---|---|
| Circuito global aberto (403/desafio/429) | Esperar 24 h; ver "Saúde"; **não** reduzir intervalo nem tentar contornar. Se persistir, pausar os monitoramentos e avaliar manualmente |
| Suspeita de chave do provedor vazada | Revogar a chave no painel do provedor; "Remover chave" na aba E-mail; criar outra com escopo só de envio |
| E-mails indevidos | Aba E-mail: modo `teste`; pausar alertas; auditar notificações por chave |
| Migração de base falhou / dados de versão mais nova | Banner de modo degradado; não apagar; atualizar a extensão para a versão compatível |
| Build adulterado | Remover; reconstruir de fonte confiável com `npm ci && npm run build`; revogar a chave do provedor |

### 9.5 Portão automático

`tests/security` (sem rede, dentro do `npm test`): manifest (X3); varredura de padrões proibidos em `src/` e `dist/` (X2, X12); fronteira de camadas e ausência de `chrome.`/`document` fora da cola; `sender` e payload (X1); URLs geradas x `robots.txt` (X14); host, caminho e redirect (X5); `apiKey` ausente de respostas, logs e erros (X4, X9); CRLF/HTML no e-mail (X11). Itens manuais: revisão da lista de permissões a cada versão e o checklist do Chrome/Edge (E34).

### 9.6 Limites

Uso pessoal, perfil único. Publicar na Chrome Web Store ou distribuir a terceiros exige: revisão jurídica da coleta (R-02) e do volume, política de privacidade, justificativa de cada permissão, reavaliação do armazenamento da chave (por exemplo, um intermediário próprio em vez de chave no cliente) e identificação honesta do cliente se a plataforma permitir.
