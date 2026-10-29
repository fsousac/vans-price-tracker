# Investigação consolidada: Vans Price Watcher (vans.com.br)

Data de todas as observações: 2026-10-14. Consolida `docs/investigation/{inventory,access-policy,catalog,product-page,product-references}.md` e `tests/fixtures/vans/`. Convenção: cada achado traz evidência, origem, data (2026-10-14), confiança (alta/média/baixa) e interpretação; fato, hipótese e risco ficam separados.

Verificação própria desta consolidação (2026-10-14, origem: script Node lendo as fixtures; 1 `curl` ao vivo em `/arezzocoocc/v2/vans/products/1003800580026U/dynamic-product-fields`, 200, 18315 bytes, `price 649.99 / discountPrice 379.99 / percentualOfDiscount 41`, idêntico à fixture `occ_dynamic_1003800580026U.json`).

---

## 1. Decisões recomendadas (resumo)

| Tema | Decisão | Confiança |
|---|---|---|
| Coleta | HTTP simples + parse. Sem Playwright. Fonte primária: OCC `GET /arezzocoocc/v2/vans/products/{codigo}`; fallback 1: `__NEXT_DATA__.props.pageProps.product` do HTML `/{slug}/p/{codigo}`; fallback 2: JSON-LD `Offer`. | média-alta |
| Identidade | Produto = cor/modelo, chave `code` (ex. `1003800580026U`). Variante = tamanho, chave `code-tamanho` (`1003800580026U-34`). Slug e canonical NÃO fazem parte da identidade. | alta |
| Preço | Em centavos inteiros. original = `price.value`; atual = `discountPrice.value` se > 0, senão `price.value`. Nunca parsear `formattedValue`. | alta (campos) |
| Disponibilidade | Por variante: `sellable && stock.stockLevel > 0`. Produto disponível = OR das variantes. Ignorar `purchasable` e `stockLevelStatus`. | média-alta |
| Polling | Watchlist pequena (<= 50 SKUs): 1 GET por SKU a cada 4 h (faixa 2-6 h), 1 requisição concorrente, 2-5 s de intervalo + jitter, UA identificável. Sitemap no máximo 1x/dia. Catálogo completo no máximo semanal e só se necessário. | média (é política, não medição) |
| Parada | 403/429/503 com challenge ou 3 falhas seguidas: pausa de 24 h e alerta ao dono. Nunca contornar. | alta |

---

## 2. Ciclo Ask → Inspect & Trace → Read the Evidence → Use What You Learn

### 2.1 Ask (perguntas)

| # | Pergunta | Resposta | Estado |
|---|---|---|---|
| Q1 | É permitido/viável coletar páginas públicas sem autenticação e sem antibot? | Sim para volume baixo; ver 3.1 | respondida (restrita) |
| Q2 | Onde está o preço por SKU de forma estável e barata? | Ver 3.3 | respondida |
| Q3 | A listagem `/c/*` serve para monitorar? | Não via HTML (produtos carregados no cliente) | respondida |
| Q4 | Qual a identidade de produto e variante? | Ver 3.2 | respondida |
| Q5 | Como interpretar "em estoque"? | Ver 3.4 | parcial |
| Q6 | Qual frequência é segura? | Sem medição de limite; ver 3.6 | NÃO respondida empiricamente |
| Q7 | O preço extraído é o preço pago pelo cliente (carrinho/Pix)? | Não verificado | aberta |
| Q8 | Como produtos de referência (Keepa etc.) tratam alertas? | Ver 3.7 | respondida com baixa/média confiança |

### 2.2 Inspect & Trace e Read the Evidence (fatos por área)

#### 3.1 Acesso e política

| Fato | Evidência / origem | Conf. | Interpretação |
|---|---|---|---|
| `robots.txt` para `User-agent: *` não tem `Allow`; só `Disallow`: `/*?q=:*`, `/*&q=:*`, `/login`, `/my-account`, `/wish-list`, `/cart$`, `/checkout`, `/search*.*`, `/search*text=*`, `/search*%*`, `/search/`, `/p/*/write-answer`, `/p/*/write-answer-after-login`. Sitemap: `https://www.vans.com.br/sitemap.xml`. | `tests/fixtures/vans/robots.txt` (curl) | alta | `/c/*`, `/p/*` e URLs `/{slug}/p/{code}` são permitidos por omissão. O `Disallow: /p/*/write-answer` nem casa com `/{slug}/p/{code}` (começa com `/p/`), portanto a ambiguidade levantada em catalog.md R1 está resolvida: não afeta a coleta. |
| `/arezzocoocc/` não consta em nenhum Disallow. | mesmo arquivo | alta | Não proibido por robots. Permissão contratual não analisada (ver riscos). |
| Cloudflare à frente; nenhum desafio/CAPTCHA/`cf-mitigated` visto; `/c/sapatos` 200 com UA Mozilla, UA vazio e UA `PriceWatcher/0.1`. 8 requisições sequenciais a 1/s: todas 200, sem `Retry-After`/`X-RateLimit-*`. ~40-60 chamadas OCC sem bloqueio. | `cat-sapatos.headers`, `robots.headers`; curl | alta (nesse volume) | Não há prova de limite real; só ausência de bloqueio em baixo volume. |
| Termos de uso: proíbem reprodução de textos/fotos/imagens sem autorização; sem menção explícita a robôs/scraping. | `terms-termosUso.html` (busca por palavras-chave) | média | Ausência de cláusula não é autorização. Guardar só SKU, nome, preço, URL, disponibilidade; não copiar imagens/descrições. |
| Sem feed/API oficial documentado (`/api`, `/products.json`, `/feed.xml`, `/occ/v2` -> 404). | curl | média | Só caminhos comuns testados. |

#### 3.2 Identidade de produto e variante

| Fato | Evidência / origem | Conf. | Interpretação |
|---|---|---|---|
| URL `/{slug}/p/{code}`; `/p/{code}` -> 301 para URL com slug; slug errado + SKU certo -> 200 com canonical auto-referente; SKU inexistente -> 404 HTML; `.../p/{code}-40` -> 404. | `product_nosuffix_301.headers.txt`, `product_wrongslug_200.headers`, `product_404.html`, `product_variant_url_404.headers.txt` | alta | Identidade vem do `code`; slug é decorativo. |
| Produto (`1003800580026U`, `ModelVariantProduct`) = cor; variante (`1003800580026U-34`) = tamanho; `legacySKU` (`V1003800580026`) e `ean` por variante (null em alguns). Cada cor tem outro `code`; `colorOptions` lista irmãs. | `occ_disc_1003800580026U.json`, `nextdata_*.json` | alta | Séries de preço por `code`; disponibilidade por `code-tamanho`. |
| Verificado nesta consolidação: 13 a 15 variantes por produto nos HTMLs; preço igual entre tamanhos nos 5 produtos lidos (`hasPriceVariations:false`). | script sobre `product_*.html` | alta (amostra de 5) | Não generalizar: se `hasPriceVariations:true` surgir, guardar preço por variante. |

#### 3.3 Fontes de preço

| Fonte | Conteúdo | Frescor | Conf. |
|---|---|---|---|
| OCC `/products/{code}` (75-171 KB conforme o produto: Era Navy 75 KB, Knu Skool 161 KB, Hylane 171 KB; auditoria 2026-10-14) | `baseOptions[0].options[]` por tamanho com `priceData`, `discountPrice`, `sellable`, `stock{stockLevel,stockLevelStatus}`; topo traz `price`, `discountPrice`, `percentualOfDiscount` | `no-cache, no-store`, `cf-cache-status: DYNAMIC` (fresco, bate na origem) | alta |
| OCC `/products/{code}/dynamic-product-fields` (~18 KB) | `price`, `discountPrice`, `percentualOfDiscount`, `installment`, `sellable`, `variantOptions`, `colorOptions`; sem estoque numérico | fresco | alta |
| HTML SSR `__NEXT_DATA__.pageProps.product` | `price`, `discountPrice`, `variantOptions[].priceData/discountPrice/stock` | `s-maxage=300, stale-while-revalidate`; `x-nextjs-cache` MISS/STALE/HIT (até ~5 min) | alta |
| JSON-LD `Offer` | só preço efetivo (string "R$379,99" no agregado; "379.99" por variante) e availability; sem preço "de"; `priceValidUntil` dd/mm/aaaa | igual ao SSR | alta |
| OCC `/products/search` | lista paginada (1239 itens em `category=SAPATOS`), `price`, `variantOptions`, `sizesAvailabilityInfo`; `stock` vazio | fresco | alta |
| `/c/*` HTML e `_next/data/.../c/*.json` | só slots CMS/SEO, sem produtos | cache 5 min | alta |
| `/_next/data/{buildId}/...` | mesmo `pageProps`; `buildId` (`kMbN2-iqB0i9_FlwqyUTj` hoje) muda a cada deploy | n/a | alta |

Valores verificados (auditoria 2026-10-14). Hylane e Era True White: concordância SSR/OCC/dynamic nas fixtures. Era Navy e Knu Skool NÃO têm fixture OCC/dynamic: só SSR em fixture; OCC e dynamic foram conferidos por `curl` ao vivo na auditoria (Navy 279.99/99.99000000000001/64/false; Knu 699.99/sem desconto/true, 9 tamanhos vendáveis com estoque >0) e batem com o SSR:

| Produto | price (de) | discountPrice (por) | % | sellable |
|---|---|---|---|---|
| Hylane 2-Tone Khaki Green `1003800580026U` | 649.99 | 379.99 | 41 | true (tam. 33-36 vendáveis, 5/11/14/4 un.) |
| Era True White `1002000690063U` | 299.99 | 149.99 | 50 | false |
| Era Navy `1002000690002U` | 279.99 | 99.99000000000001 | ~64 | false |
| Knu Skool Pig Deep Twilight `1002002760052U` | 699.99 | ausente/0 | n/a | true (tam. 33 não, 34 sim com 20) |

Observações de formato (alta; auditoria): no SSR `variantOptions[].url` é `""` e `variantOptionQualifiers` é `[]`, então o tamanho deve vir de `displayText` (ou do sufixo de `code`); no SSR `percentualOfDiscount` é `""` (calcular a partir dos preços, não ler); no OCC o `stock` do topo do produto é inútil (`stockLevel:0`, `inStock` mesmo com variantes vendáveis); `GET /products/{code}` funciona sem `fields`, sem cookies e sem sessão.

Observações de formato (alta): `value` vem com ruído de ponto flutuante (`99.99000000000001`); `price.formattedValue` "R$ 279,99" (com espaço) vs `discountPrice.formattedValue` "R$99,99" (sem espaço); sem desconto o SSR traz `discountPrice` zerado (`value:0`, `currencyIso:""`) e o OCC o omite; `priceType` FROM no produto e BUY na variante; `installment` vazio no SSR e preenchido na API dinâmica.

#### 3.4 Disponibilidade

| Fato | Evidência | Conf. | Interpretação |
|---|---|---|---|
| `stockLevelStatus` não é confiável: `lowStock` com `stockLevel:0` e `sellable:false` (Era True White, 13 tamanhos), `outOfStock` em outros. | `product_disc_oos_1002000690063U.html` (verificado), `occ_white_1002000690063U.json` | alta | Usar `sellable && stockLevel > 0`. |
| Nível numérico real (2..70) só aparece em itens vendáveis (21 produtos amostrados no OCC). | product-page.md | média | Não distingue "zero" de "oculto" (H1). |
| `purchasable` inconsistente entre fontes (SSR false com estoque; OCC true sem estoque). | product-page.md | média | Não usar. |
| Produto totalmente sem estoque: servidor devolve 200 com dados e preço; navegador real redireciona no cliente para `/c/sapatos/tenis?page=1`; curl não vê isso. | Chrome MCP (product-page.md) | média (1 caso) | Coletor HTTP não é afetado; Playwright seria enganado. |
| 404 HTML (página) ou 400 `UnknownIdentifierError` (OCC) = produto removido, distinto de sem estoque. | `product_404.html`, `occ_404.json` | alta | Estados distintos no modelo de dados. |

#### 3.5 Descoberta de catálogo

- Sitemap: `/sitemap.xml` é índice (PRODUCT, CATEGORYLANDING, CATEGORY, CONTENT) em `secure-static.vans.com.br` com nomes hashados que mudam; o de produto tem 2454 `<loc>` (verificado: 2454 `<loc>` e 2454 `/p/`), com imagem e sem preço. Origem `sitemap-product.xml`. Alta.
- Listagem OCC `/products/search?category=SAPATOS&currentPage=N&pageSize=100&fields=FULL&storeFinder=false`: 0-based, 52 páginas de 24 ou 13 de 100, `x-total-count: 1239`. Teto de `pageSize` e subcategorias (`category=TENIS`) NÃO testados. Alta (observado) / média (parâmetros por leitura de JS).
- Risco robots: evitar `query=:...`, facetas `q=` e a busca `/search*`; usar só `category=`.

#### 3.6 Frequência e limites

- Fato (média): SSG com `s-maxage=300`; OCC sem cache; nenhum 429 em ~60 chamadas a >= 1/s.
- Fato: nenhum limite publicado. Nada medido acima desse volume (deliberado).
- Interpretação: 4 h é política conservadora, não valor medido. Preço de varejo de moda muda em campanhas (dias), então checar a cada 4 h com preço fresco do OCC é suficiente e custa ~6 req/dia/SKU. Teto sugerido: ~300 req/dia total.

#### 3.7 Referências de produto (Keepa, CamelCamelCamel, Visualping, Honey)

Fonte: `product-references.md` (WebFetch/WebSearch; CamelCamelCamel deu 403, Keepa via resumo de busca). Confiança global média/baixa, exceto Visualping e Honey (alta onde há help oficial).
Princípios adotáveis (interpretação): alvo em valor absoluto comparado deterministicamente; estado de alerta por (produto, alvo) com re-arme por cooldown ou quando o preço volta acima; alerta com preço, timestamp, link e aviso de defasagem; alertar falha de coleta após N falhas consecutivas (N pequeno); série histórica por variante; expiração opcional do watch; canais simples (Telegram/webhook/email).

---

## 4. Hipóteses não comprovadas

| # | Hipótese | Conf. | Como validar |
|---|---|---|---|
| H1 | `stockLevel` é ocultado (0) quando não vendável. | média | Observar um item que passa de vendável para esgotado em série temporal. |
| H2 | `lowStock` com nível 0 reflete estoque omni/loja (`sellableOmni`). | baixa | Comparar `sellableOmni` nas fixtures; nova rodada. |
| H3 | `priceValidUntil` é data móvel (hoje+3), não fim da promoção. | média | Coletar em dias distintos. |
| H4 | `isPreOrder:true` no Hylane (com estoque) é flag incorreta. | baixa | Nova rodada; hoje irrelevante ao preço. |
| H5 | OCC aguenta 1 req/1,5 s sustentado por dias sem bloqueio. | baixa | Rodar o coletor real por 1-2 semanas, registrar status HTTP. |
| H6 | `category=TENIS`/`CHINELO` filtram subcategorias. | média | 1 GET. |
| H7 | Promoções sempre aparecem como `discountPrice` (e `channelPrices`/`hasPriceVariations` têm outro uso). | média | Observar mais produtos e canais (Pix). |
| H8 | Preço de vitrine = preço do carrinho. | baixa (não testado) | Comparação manual no navegador (sem automatizar checkout, que é Disallow). |

## 5. Alternativas consideradas

| Alternativa | Prós | Contras | Veredito |
|---|---|---|---|
| OCC por produto (recomendada) | fresco, JSON estruturado, estoque por tamanho, ~75 KB | API interna não documentada; origem sem cache | primária, com baixo volume |
| `__NEXT_DATA__` do HTML | HTML atende de cache CDN (barato ao lojista); mesma estrutura | até ~5 min defasado; formato Next pode mudar | fallback 1; ou primária se o dono preferir menor carga à origem |
| JSON-LD | schema.org estável | sem preço "de", preço em string, `color` vazio às vezes | fallback 2 e checagem cruzada |
| `/products/search` por categoria | descobre e compara 100 itens por chamada | `query=` esbarra em robots; 13+ chamadas; `stock` vazio | só para descoberta ocasional |
| Sitemap | barato, sem preço | hashes mudam | descoberta de URLs, 1x/dia |
| Playwright | roda JS real | pesado, detectável como automação, redirect de OOS confunde, sem ganho de dado | descartado; só se o SSR sumir, e sem evasão |

## 6. Contradições entre os relatórios e como foram resolvidas

| # | Contradição | Resolução |
|---|---|---|
| C1 | access-policy recomenda `__NEXT_DATA__` como primária (H1/rec. 3); product-page recomenda OCC primária. | Ambas estão nas fixtures e concordam nos valores. Decisão: OCC primária (fresca), `__NEXT_DATA__` fallback. Se o dono quiser minimizar carga à origem, inverter. Decisão de projeto, não de evidência. |
| C2 | access-policy F8 diz que `/products/search` traz `stock`; catalog F6/H4 diz `stock{}` vazio. | Verificado em `api-products-search-query-era.json`: `stock` é `{}`. Vale catalog.md. Estoque só em `variantOptions`/`sizesAvailabilityInfo` (search) ou nos `options[]` do OCC de produto. |
| C3 | Frequência: access-policy 2-6 h por item e ~200 req/dia; catalog "1/hora ou menos" para o catálogo; product-page intervalo >= 1,5 s. | Compatíveis; adotado 4 h/SKU, 2-5 s entre requisições. Teto diário agora ~300 req. Nenhum valor é medido. |
| C4 | robots: tarefa diz "libera /c/* e /p/*"; arquivo não tem `Allow` para `*`. | Liberado por omissão; verificado. |
| C5 | catalog R1 apontava ambiguidade de `/p/*` vs `/slug/p/CODE`. | Resolvida em 3.1. |
| C6 | `Disallow` listado na tarefa como `/search*` e `/*?q=:*`; arquivo traz `/search*.*`, `/search*text=*`, `/search*%*`, `/search/`. | Vale o arquivo. Efeito prático igual: evitar busca/facetas. |
| C7 | `product-page.md` usa "A/M/B" e `access-policy.md` "alta/média/baixa". | Apenas notação. |
| C8 | Disponibilidade do Knu Skool: produto `sellable:true` mas variante 33 `sellable:false`. | Não é erro; confirma OR das variantes. |
| C9 | Fixtures duplicadas. | Auditoria com md5: `product-era-navy.html` e `product_disc_oos_1002000690002U.html` têm mesmo código/preço/variantes mas hashes DIFERENTES (131918 B cada; capturas distintas do mesmo produto), assim como `cat-sapatos.html` e `sapatos.raw.html`. Escolher uma de cada. Duplicatas byte a byte: só alguns `*.headers`/`*.headers.txt`. |
| C10 | Dois relatórios dizem "sem cookies/dados pessoais" nas fixtures. | `product_disc_instock_1003800580026U.html` contém `fbclid` e UTMs de campanha no JSON-LD (verificado); `occ_404.headers.txt` menciona Cookie. Sanitizar antes de versionar. Também o relatório de inventory conta MCP/REA como "não executado" e product-page diz que `capture_browser_scenario` falhou: **nenhuma evidência veio do REA**. |

## 7. Riscos de manutenção

| Risco | Impacto | Mitigação |
|---|---|---|
| OCC é API interna: pode mudar, exigir token ou ser bloqueada | coleta primária quebra | camadas de fallback; teste de contrato por fixtures; alerta "parser degradado" |
| `buildId` muda a cada deploy | `_next/data` quebra | nunca fixar `_next/data`; ler `__NEXT_DATA__` do HTML |
| Schema/campos inconsistentes (`formattedValue`, `purchasable`, `stockLevelStatus`) | falsos alertas | usar `value` e `sellable && stockLevel>0`; arredondar para centavos |
| Cache SSR até 5 min | preço defasado no fallback | registrar `fonte` e timestamp; preferir OCC |
| Cloudflare ativar desafio | bloqueio | parar e recuar; não contornar |
| Termos proíbem reprodução de conteúdo | risco jurídico | uso pessoal, dados mínimos, sem imagens/descrições, sem redistribuir |
| Sitemap com URL hashada | descoberta quebra | resolver pelo índice a cada execução |
| Node 24 `node:sqlite` experimental | API pode mudar | isolar acesso a dados; `better-sqlite3` como alternativa (build nativo no Windows) |
| Python 3.14: wheels | pacotes ausentes | preferir Node |

## 8. Estratégia de recuperação

1. Parser em camadas: OCC -> `__NEXT_DATA__` -> JSON-LD. Se a primária falhar e outra funcionar, gravar como "degradado" e avisar o dono; não silenciar.
2. Quarentena: preço <= 0, não numérico, ou variação > 70% entre leituras consecutivas não dispara alerta; exige 2 leituras concordantes.
3. Salvar o corpo bruto da última falha (sem cookies/headers de sessão).
4. Erros: 404/400 = produto removido (estado próprio); 429/`Retry-After` respeitado; backoff exponencial; circuito: 3 falhas ou 403/challenge seguidos -> pausa 24 h + alerta.
5. Testes de contrato contra `tests/fixtures/vans/` em CI local; nova captura de fixtures quando o contrato mudar.
6. Alerta de falha de coleta só após N falhas consecutivas (N=3, dado o baixo número de checagens por dia).
7. Escape final: monitorar manualmente ou contatar a loja; sem evasão.

## 9. Identidade, alertas e modelo mínimo (decorrente da evidência)

- Tabelas lógicas: `produto(code, slug_ultimo, nome, legacy_sku)`, `variante(code_tamanho, produto, tamanho, ean)`, `leitura(code_tamanho ou code, preco_de_centavos, preco_por_centavos, sellable, stock_level, fonte, lida_em, http_status)`, `watch(code, tamanho?, alvo_centavos, estado, rearm_em, expira_em)`.
- Alerta: dispara na transição acima -> abaixo/igual do alvo, com `sellable && stockLevel>0` (ou do tamanho escolhido); re-arma quando o preço volta acima do alvo ou após cooldown (referência Keepa: 7 dias). Mensagem com preço, timestamp, link, fonte e aviso de que o preço pode ter mudado.

## 10. O que exige nova rodada de inspeção

1. Preço de vitrine vs preço de carrinho/Pix/cupom (H8) e significado de `channelPrices`/`cashback`/`productBenefits` (só páginas públicas; sem login/checkout).
2. Série temporal: mesmos SKUs em horários e dias distintos (frescor do SSR, `priceValidUntil`, transição de estoque, `stockLevel` oculto).
3. Produto com `hasPriceVariations:true` e produtos sem variantes (acessórios, vestuário): formato de preço e tamanhos.
4. Item em pré-venda de fato (`isPreOrder`) e relação com `sellable`.
5. Limites: teto de `pageSize`, `category=TENIS`, taxa sustentada, comportamento sob 429/Cloudflare (sem forçar).
6. Política de privacidade e termos integrais (leitura jurídica); permissão de uso do `/arezzocoocc`.
7. Evidência REA: nenhuma obtida; se quiser REA, validar conexão do MCP com um navegador com CDP. Hoje é dispensável.
8. Sanitização das fixtures (C9, C10) e remoção de duplicatas.
9. Nenhum código de coletor/parser existe no repositório: a extração foi verificada só por inspeção de fixtures e 1 chamada ao vivo.

## 10b. Lacunas adicionais da auditoria (2026-10-14)

1. Sitemap de produto tem 2454 URLs, `/products/search?category=SAPATOS` tem 1239: diferença não explicada (cores esgotadas? outras categorias? vestuário?). Não usar o sitemap como contagem de catálogo.
2. Sem fixture OCC para Era Navy e Knu Skool dynamic (hoje só ao vivo); capturar antes de escrever testes de contrato.
3. Não há exemplo de produto sem tamanhos (acessório) nem `hasPriceVariations:true`; o parser deve falhar de forma explícita (estado `formato_desconhecido`), não assumir `baseOptions[0].options`.
4. Nenhuma observação do comportamento sob 429/403 real; a regra de pausa é política.
5. Entrada do dono: extrair `code` de URL colada (`/{slug}/p/{code}`) é trivial mas não especificado/testado.

## 11. Extração real de preço comprovada?

**SIM, restrito: leitura do preço de vitrine por `code`; NÃO para "preço pago" nem para estabilidade no tempo.**

- Comprovado (alta): em 4 produtos reais com e sem desconto, `price.value` e `discountPrice.value` coincidem nas três fontes (SSR, OCC produto, OCC dinâmico) e com o JSON-LD (379.99 no Hylane); revalidado ao vivo hoje (curl 200, 649.99/379.99/41%).
- Não comprovado: (a) preço do carrinho/Pix; (b) comparação com o preço renderizado na tela; (c) comportamento ao longo de dias; (d) produtos sem tamanho ou com `hasPriceVariations:true`; (e) código de parser rodando (inexistente); (f) nenhuma evidência via REA.
