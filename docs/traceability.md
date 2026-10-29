# Rastreabilidade inicial: requisito, módulo, teste planejado

Versão 0.1 (2026-10-14). Estado de todos os testes: **planejado** (não existe código). Fonte dos requisitos: `docs/requirements.md`. Tipos: U unitário (offline, puro), C contrato (fixtures de `tests/fixtures/vans/`, sem rede), I integração (SQLite temporário, coletor e e-mail falsos, relógio falso), E2E (servidor local, HTTP real contra o próprio app, loja falsa), M manual. IDs de teste: `T-<área>-nn`.

Módulos: `catalog`, `price-monitor` (inclui a interface de coletor e `price-compare`), `price-history`, `alerts`, `notifications`, `scheduler`, `web`, `observability`. `config` (leitura/validação de ambiente) é transversal e fica em `web`/bootstrap.

## 1. Requisitos funcionais

| REQ | Módulo(s) | Teste planejado | Tipo | Fixture / dado |
|---|---|---|---|---|
| RF-01-AC1 | catalog | T-CAT-01 busca local por nome | U/I | `api-products-search-query-era.json`, `search.sapatos.page0.sample.json` |
| RF-01-AC2 | catalog, web | T-CAT-02 estado vazio sem chamada de rede | I | (coletor falso que falha se chamado) |
| RF-01-AC3 | catalog, scheduler | T-CAT-03 espaçamento 2-5 s e limite 1/24 h (relógio falso) | I | resposta de listagem simulada |
| RF-01-AC4 | catalog | T-CAT-04 item sem `code`/preço é ignorado e contado | C | `search.sapatos.page0.sample.json` adulterado |
| RF-01-AC5 | catalog, price-monitor | T-CAT-05 429/403 aborta e mantém catálogo | I | resposta falsa 429/403 |
| RF-01-AC6 | catalog, web | T-CAT-06 abertura usa `code`, não slug | I | listagem fixture |
| RF-02-AC1..3 | web, price-monitor | T-URL-01 extração de `code` (tabela de URLs válidas: slug, sem slug, slug errado) | U | `product_nosuffix_301.headers.txt`, `product_wrongslug_200.headers.txt` |
| RF-02-AC4 | web, price-monitor | T-URL-02 rejeição (http, host falso, `@`, porta, IP literal, sem `/p/`, credenciais); asserta zero chamadas de rede | U | tabela de URLs hostis |
| RF-02-AC5 | price-monitor | T-URL-03 sufixo de tamanho e `code` inexistente rejeitados | C | `occ_404.json`, `product_404.html`, `product_variant_url_404.headers.txt` |
| RF-02-AC8 | web, price-monitor | T-URL-06 cadastro usa o banco se lido < 2 h; senão 1 requisição via `RateGate` e orçamento | I | |
| RF-02-AC6 | catalog, price-monitor | T-URL-04 cadastro grava produto e 13-15 variantes | C/I | `occ_disc_1003800580026U.json` |
| RF-02-AC7 | web, observability | T-URL-05 query (`fbclid`, UTM) descartada e ausente em logs | U | URL com UTM |
| RF-03-AC1 | price-monitor | T-IDN-01 parse OCC: produto, variantes, `legacySKU`, `ean` null | C | `occ_disc_1003800580026U.json` |
| RF-03-AC2 | price-monitor | T-IDN-02 tamanho via `displayText`/sufixo no SSR | C | `nextdata_1003800580026U.json`, `product_disc_instock_1003800580026U.html` |
| RF-03-AC3 | price-monitor, web | T-IDN-03 Hylane 33-36 disponíveis, 37-45 não (13 variantes) | C | `occ_disc_1003800580026U.json` |
| RF-03-AC4 | alerts, web | T-IDN-04 alerta sem variante é recusado | U | |
| RF-03-AC5 | price-monitor | T-IDN-05 estrutura sem `baseOptions[0].options` vira `formato_desconhecido` | C | JSON sintético derivado da fixture |
| RF-03-AC6 | catalog | T-IDN-06 cor irmã é outro `code` | C | `colorOptions` em `occ_disc_1003800580026U.json` |
| RF-04-AC1..3 | alerts, web | T-TGT-01 parse do alvo (tabela: `379,99`, `379.99`, `1.234,50`, inválidos) | U | |
| RF-04-AC4 | alerts, web | T-TGT-02 aviso quando alvo > preço atual | I | |
| RF-04-AC5 | price-monitor | T-TGT-03 ruído de float `99.99000000000001` vira 9999 | U | `nextdata_*` / Era Navy |
| RF-05-AC1,2 | alerts | T-BND-01 padrão 3% e validação 0-50% | U | |
| RF-05-AC3..5 | price-monitor (`price-compare`) | T-BND-02 função de faixa por tabela da seção 5.4 de requirements | U | Hylane 37999 |
| RF-05-AC6 | price-monitor | T-BND-03 extremos sem overflow; teste de propriedade: faixa monotônica em P | U | |
| RF-06-AC1 | scheduler, price-monitor | T-MON-01 1 requisição por `code`, sequencial, espaçamento, UA | I | coletor falso instrumentado |
| RF-06-AC2,3 | scheduler, alerts | T-MON-02 limites de intervalo (2-6 h) e de 50 produtos | U/I | |
| RF-06-AC4 | scheduler | T-MON-03 rodada sobreposta é pulada | I | relógio falso |
| RF-06-AC5 | scheduler | T-MON-04 uma rodada de recuperação na partida | I | relógio falso |
| RF-06-AC6 | price-monitor, scheduler | T-MON-05 `FakeCollector` sem rede grava `MonitoringRun` | I | todas as fixtures |
| RF-06-AC7 | scheduler | T-MON-06 produto sem alerta ativo não é coletado | I | |
| RF-06-AC8 | price-monitor | T-MON-07 concordância OCC/SSR/dynamic (só contrato; em produção o fallback só roda quando o OCC falha) | C | `occ_disc_*`, `nextdata_*`, `occ_dynamic_1003800580026U.json` |
| RF-07-AC1,2 | price-history, web | T-HST-01 listagem e desconto % calculado (41%) | I | Hylane |
| RF-07-AC3 | price-history, price-monitor | T-HST-02 falha não cria ponto | I | respostas de falha |
| RF-07-AC4,5 | price-history | T-HST-03 mín/máx só com confirmadas | U/I | |
| RF-07-AC6 | price-history | T-HST-04 uma observação por rodada | I | |
| RF-08-AC1..3 | notifications | T-NOT-01 render do e-mail (conteúdo, link, aviso, fonte degradada, fuso) | U | snapshot textual |
| RF-08-AC4 | notifications | T-NOT-02 modo teste não abre conexão de saída; `ACEITO` simulado | I | provedor falso que falha se chamado |
| RF-08-AC5 | notifications, web | T-NOT-03 `EMAIL_MODE=real` sem credenciais falha na partida sem vazar valores | U | |
| RF-08-AC6 | notifications | T-NOT-04 inicial + 3 retentativas (5 min/30 min/2 h), `FALHA` na 4ª falha | I | provedor falso, relógio falso |
| RF-08-AC7 | observability, notifications | T-NOT-05 logs sem e-mail/corpo/segredo | I | captura de logs |
| RF-08-AC8 | web | T-NOT-06 texto "aceito pelo provedor" | I | |
| RF-08-AC9 | alerts, web | T-NOT-07 validação de sintaxe do e-mail | U | |
| RF-09-AC1 | web | T-WEB-01 colunas do dashboard | E2E | |
| RF-09-AC2 | alerts, web | T-WEB-02 edição aplica `revisao++` | I | |
| RF-09-AC3 | alerts | T-WEB-03 pausa/retoma e retenção de `PENDENTE` por 24 h | I | relógio falso |
| RF-09-AC4 | alerts, notifications | T-WEB-04 exclusão remove alerta e notificações; histórico permanece | I | |
| RF-09-AC5 | web | T-WEB-05 CSRF e `Origin` nas mutações | E2E | |
| RF-09-AC6 | web | T-WEB-06 bind em `127.0.0.1` por padrão; aviso ao mudar | I | |
| RF-09-AC7 | alerts, web | T-WEB-07 duplo envio não duplica alerta | I | |
| RF-09-AC10 | web, price-monitor | T-WEB-09 "retomar coleta" volta `removido`/`formato_desconhecido` a `ativo` | I | |
| RF-09-AC8 | web | T-WEB-08 rótulos, foco e teclado | M/E2E | |
| RF-10-AC1,2 | alerts | T-DUP-01 reavaliar a mesma observação gera 1 notificação | I | |
| RF-10-AC3,4 | alerts | T-DUP-02 rearme com cooldown de 24 h (relógio falso) | I | |
| RF-10-AC5,6 | alerts | T-DUP-03 ACIMA→ATINGIDO envia só 1; PROXIMO depois ATINGIDO envia 2 | I | |
| RF-10-AC7 | alerts | T-DUP-04 edição reabre travas | I | |
| RF-10-AC8 | alerts | T-DUP-05 indisponível não dispara nem rearma; volta ao estoque dispara | I | `product_disc_oos_1002000690063U.html`, `occ_white_1002000690063U.json` |
| RF-10-AC9 | alerts, price-monitor | T-DUP-06 dois alertas na mesma variante, 1 coleta | I | |
| RF-10-AC10 | alerts, notifications | T-DUP-07 unicidade da chave de idempotência sob concorrência | I | |
| RF-11-AC1 | price-monitor, alerts | T-FLH-01 falhas (403/429/5xx/timeout/não JSON) sem observação nem alerta | I | respostas falsas |
| RF-11-AC2 | price-monitor | T-FLH-02 preço ausente/0/negativo/NaN/`discountPrice>price` não vira observação | U/C | JSON adulterado |
| RF-11-AC3 | price-monitor, alerts | T-FLH-03 variação >70% exige 2ª leitura concordante | I | |
| RF-11-AC4 | price-monitor | T-FLH-04 fallback SSR `degradada`, aviso 1x, disparo só confirmado | C/I | `nextdata_1003800580026U.json` |
| RF-11-AC5 | price-monitor | T-FLH-05 400/404 vira `produto_removido`, `removido` após 2 rodadas | C | `occ_404.json`, `product_404.html` |
| RF-11-AC6 | price-monitor | T-FLH-06 sem estoque total não é removido; preço 149,99 | C | `product_disc_oos_1002000690063U.html` |
| RF-11-AC7 | price-monitor, notifications | T-FLH-07 3 falhas → `com_falha` e 1 `SAUDE` | I | |
| RF-11-AC8 | scheduler, price-monitor | T-FLH-08 circuito global 24 h e retomada com sonda | I | relógio falso |
| RF-11-AC9 | price-monitor | T-FLH-09 redirect para host fora da lista/`http`/>3 saltos falha | I | servidor HTTP local de redirects |
| RF-11-AC10 | price-monitor | T-FLH-10 corpo >2 MB e `Content-Type` inesperado | I | |
| RF-11-AC11 | price-monitor, observability | T-FLH-11 corpo bruto sem cookies, 1 por produto, fora dos logs | I | |
| RF-11-AC12 | price-monitor, scheduler | T-FLH-12 503/200 com `cf-mitigated`: `http_403_ou_desafio`, sem retentativa/fallback, circuito | I | respostas falsas |
| RF-11-AC13 | scheduler | T-FLH-13 3 produtos seguidos `formato_desconhecido`: rodada `partial`, evento global, sem circuito | I | JSON sintético |
| RF-11-AC14 | price-monitor | T-FLH-14 `code` divergente = `formato_desconhecido`; `stockLevel` ausente = indisponível | C | JSON sintético |
| RF-11-AC15 | price-monitor, alerts | T-FLH-15 1ª leitura incoerente ou com desconto > 70% fica não confirmada e não dispara | I | JSON sintético |
| RF-12-AC1 | web, observability, scheduler | T-SAU-01 `/saude` campos e ausência de PII | I | |
| RF-12-AC2 | scheduler | T-SAU-02 `atrasado` quando última rodada > 2*I | I | relógio falso |
| RF-12-AC3 | alerts, price-history | T-SAU-03 fresco/defasado/sem_dados nos limites 8 h e 24 h | U | relógio falso |
| RF-12-AC4 | web | T-SAU-04 dashboard mostra circuito e retomada | E2E | |
| RF-12-AC5 | web | T-SAU-05 `/saude` < 200 ms e sem rede | I | |
| RF-12-AC6 | web | T-SAU-06 aviso "só roda com o app aberto" | E2E | |

## 2. Regras de negócio

| REQ | Módulo | Teste planejado | Tipo |
|---|---|---|---|
| RN-01 | price-monitor | T-RN-01 conversão para centavos e rejeição de >2 casas reais | U |
| RN-02, RN-03 | price-monitor | T-RN-02 preço efetivo nas 4 fixtures: Hylane 37999, Era True White 14999, Era Navy 9999, Knu Skool 69999 (sem desconto) | C |
| RN-04 | price-monitor | T-RN-03 preço inválido (ver T-FLH-02) | U |
| RN-05 | price-monitor | T-RN-04 variante vs produto; `hasPriceVariations:true` sintético | C |
| RN-06, RN-07 | price-monitor | T-RN-05 `sellable && stockLevel>0`; `lowStock` com nível 0 é indisponível; OR de variantes; Knu 33 não, 34 sim | C |
| RN-08 | price-monitor | T-RN-06 indisponível mantém preço; removido é outra classe | C |
| RN-09, RN-09a | price-monitor, alerts | T-RN-07 matriz de confirmação (primeira OCC, variação, fallback, par concordante) | U |
| RN-10 | alerts | T-RN-08 alvo (ver T-TGT-01, T-TGT-02) | U |
| RN-11 | alerts | T-RN-09 gatilhos por tipo e travas | I |
| RN-12 | alerts, notifications | T-RN-10 chave `hash(alert, revisao, tipo, episodio)` estável e única | U/I |
| RN-13 | alerts | T-RN-11 rearme (ver T-DUP-02, T-DUP-05) | I |
| RN-14, RN-15 | alerts | T-RN-12 edição e pausa (ver T-WEB-02, T-WEB-03) | I |
| RN-16 | alerts | T-RN-13 teste de propriedade: nenhuma notificação sem observação confirmada, disponível, válida e na faixa | U/I |
| RN-17 | alerts, price-history | T-RN-14 frescor (ver T-SAU-03) | U |
| RN-18, RN-19 | price-monitor, scheduler | T-RN-15 classes de falha e circuito (ver T-FLH-05, 07, 08) | I |
| RN-20 | price-monitor, catalog | T-RN-16 identidade ignora slug e canonical | C |
| RN-21 | price-monitor, observability | T-RN-17 nada de imagem/descrição/cookie persistido | I |

## 3. Máquinas de estado

| REQ | Teste planejado | Tipo |
|---|---|---|
| Alerta 6.1 | T-SM-01 tabela de transições válidas/inválidas (pausar `PAUSADO` é idempotente, retomar `ATIVO` é no-op) | U |
| Notificação 6.2 | T-SM-02 tabela de transições; `ACEITO` e `FALHA` terminais salvo "reenviar" manual; modo teste simulado | U/I |
| Atomicidade | T-SM-03 falha injetada entre observação e `Notification`: nada parcial persiste | I |

## 4. Requisitos não funcionais

| REQ | Módulo | Teste planejado | Tipo |
|---|---|---|---|
| RNF-SEC-01 | price-monitor | T-SEC-01 allowlist, esquema, porta, credenciais, redirects, IP privado/loopback/metadados (resolvedor falso) | U/I |
| RNF-SEC-02 | price-monitor | T-SEC-02 timeout, tamanho e tipo de conteúdo | I |
| RNF-SEC-03 | web | T-SEC-03 bind padrão (ver T-WEB-06) | I |
| RNF-SEC-04 | web | T-SEC-04 CSRF, `Origin`/`Host`, escape de saída (payload `<script>` no nome do produto), SQL parametrizado | E2E |
| RNF-SEC-05 | notifications, web | T-SEC-05 `EMAIL_MODE=test` padrão, segredos ausentes de logs/erros/`/saude`, `.env.example` sem valores | I |
| RNF-SEC-06 | web | T-SEC-06 cabeçalhos de segurança | E2E |
| RNF-PRIV-01 | observability | T-PRV-01 varredura de logs por e-mail, corpo, credencial | I |
| RNF-PRIV-02 | price-monitor | T-PRV-02 sanitizador de corpo bruto; verificação de que fixtures versionadas não têm `fbclid`/UTM/cookies | U |
| RNF-PRIV-03 | alerts | T-PRV-03 (ver T-WEB-04) | I |
| RNF-REL-01 | alerts | T-REL-01 (ver T-RN-13) | U/I |
| RNF-REL-02 | alerts, notifications | T-REL-02 (ver T-SM-03) | I |
| RNF-REL-03 | scheduler | T-REL-03 uma requisição e uma rodada por vez | I |
| RNF-REL-04 | scheduler | T-REL-04 cortesia, mínimo 2 h, teto diário 400 | I |
| RNF-REL-03/04 | price-monitor | T-REL-06 `RateGate`: 1 em voo e espaçamento para qualquer origem (rodada, cadastro, catálogo, sonda); `outbound_requests` | I |
| RF-08-AC6 | notifications | T-NOT-08 `claimDue` com lease: dois drains não enviam a mesma linha; paused não é pego; `markAccepted` de linha removida é no-op | I |
| RNF-SEC-01 | price-monitor | T-SEC-07 `lookup` com `all: true` e endereço proibido misto; redirect só para `/{slug}/p/{mesmo code}` no mesmo host | I |
| RNF-REL-05 | web | T-REL-05 cópia a frio documentada (S) | M |
| RNF-PERF-01 | scheduler | T-PRF-01 rodada de 50 produtos com relógio falso respeita cortesia | I |
| RNF-PERF-02 | web, price-history | T-PRF-02 dashboard com 50 alertas e 10 mil observações < 1 s | I |
| RNF-PERF-03 | price-monitor | T-PRF-03 comparação pura sem I/O | U |
| RNF-OBS-01..03 | observability | T-OBS-01 formato JSON dos logs; T-OBS-02 contadores em `/saude`; T-OBS-03 evento único por episódio | I |
| RNF-TEST-01, 02 | todos | T-TST-01 suíte roda com rede bloqueada; relógio e coletor injetados | I |
| RNF-TEST-03 | todos | T-TST-02 gate de cobertura (80% linhas/ramos; 100% de ramos em faixa e conversão) | CI local |
| RNF-TEST-04 | price-monitor | T-TST-03 fixtures faltantes capturadas e sanitizadas (Era Navy OCC, Knu dynamic) | M |
| RNF-MNT-01 | price-monitor | T-MNT-01 todos os coletores cumprem o mesmo contrato (teste parametrizado) | C |
| RNF-MNT-02 | web, price-history | T-MNT-02 nenhum SQL fora do repositório (verificação estática) | U |
| RNF-MNT-03 | web | T-MNT-03 configuração inválida falha na partida com mensagem legível | U |
| RNF-ACC-01 | web | T-ACC-01 verificação automática de acessibilidade mais roteiro de teclado | E2E/M |
| RNF-I18N-01 | web, notifications | T-I18-01 formato `R$ 1.234,56` e America/Sao_Paulo | U |
| RNF-UX-01 | web | T-UX-01 estados vazios e mensagens de erro | M |
| RNF-LEG-01, 02 | price-monitor | T-LEG-01 caminhos `Disallow` nunca são chamados (lista do `robots.txt` da fixture); T-LEG-02 sem retentativa agressiva sob 403/429 | I |

## 5. Jornadas

| Jornada | Teste planejado | Tipo |
|---|---|---|
| J-1 | T-J1-01 catálogo → produto → tamanho → alerta → dashboard | E2E |
| J-2 | T-J2-01 URL → produto → alerta | E2E |
| J-3 | T-J3-01 preço desce → e-mail simulado → sem repetição → sobe → desce → 2º e-mail | E2E/I |
| J-4 | T-J4-01 editar/pausar/retomar/excluir | E2E |
| J-5 | T-J5-01 dados defasados e circuito visíveis | E2E |
| J-6 | T-J6-01 loja devolve 403: nada de preço novo, nada de e-mail de preço, 1 aviso de saúde | E2E/I |

## 6. Riscos para teste

| Risco | Teste ou verificação |
|---|---|
| R-01, R-16 | T-IDN-05, T-FLH-04, T-MNT-01 |
| R-03, R-17 | T-FLH-08, T-REL-04 |
| R-04, R-08 | T-RN-01..07, T-BND-02/03, T-RN-13 |
| R-09 | T-SM-02, T-DUP-07 |
| R-11 | T-SEC-01, T-URL-02, T-FLH-09 |
| R-12 | T-SEC-04, T-WEB-05, T-WEB-06 |
| R-13 | T-PRV-01, T-PRV-02 |
| R-14 | T-SAU-02, T-SAU-03, T-SAU-06 |
| R-18 | T-TST-03 |
| R-02, R-05, R-06, R-07, R-10, R-15, R-19, R-20 | sem teste automático direto; mitigados por documentação, texto de UI (T-NOT-06, T-NOT-01) e revisão manual |

## 7. Lacunas de rastreabilidade já conhecidas

1. Não há fixture OCC para Era Navy `1002000690002U` nem dynamic de Knu Skool `1002002760052U` (investigation 10b.2); T-RN-02 usa SSR/`occ_nodisc_1002002760052U.json` para esses.
2. Não há fixtures de produto sem tamanhos, `hasPriceVariations:true` ou 429/403 reais; T-IDN-05, T-RN-04 e T-FLH-01 usam JSON sintético derivado, marcado como tal.
3. O comportamento de pausa/circuito (T-FLH-08) é política, não observada na loja.
4. Não há medida real de limite de taxa; T-REL-04 valida só a política.
5. Nenhum desafio Cloudflare (`cf-mitigated`, 503 com desafio) foi observado na loja; T-FLH-12 usa resposta sintética baseada na documentação do Cloudflare, não em evidência.
6. Os IDs T-RN-08/10/12/14/15 são apelidos que apontam para outros testes (ver a coluna Teste); não têm tarefa própria no plano.
