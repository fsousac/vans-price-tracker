# Acesso e política de coleta — vans.com.br (2026-10-14)

Todas as evidências: coletadas em 2026-10-14 por curl (UA Mozilla) e Chrome MCP. Fixtures em `tests/fixtures/vans/`.

## 1. Fatos

| # | Achado | Evidência / origem | Confiança |
|---|--------|--------------------|-----------|
| F1 | robots.txt: `User-agent: *` NÃO tem `Allow` explícito; só Disallow: `/*?q=:*`, `/*&q=:*`, `/login`, `/my-account`, `/wish-list`, `/cart$`, `/checkout`, `/search*.*`, `/search*text=*`, `/search*%*`, `/search/`, `/p/*/write-answer`, `/p/*/write-answer-after-login`. `BDCbot` bloqueado total. Bots de IA (GPTBot, ClaudeWeb etc.) têm Allow `/`. Por omissão `/c/*` e `/p/*` estão permitidos. | `curl https://www.vans.com.br/robots.txt` → `robots.txt` | alta |
| F2 | `/arezzocoocc/...` (API) não aparece em nenhum Disallow. | mesmo robots.txt | alta |
| F3 | Cloudflare na frente (`Server: cloudflare`, `CF-RAY`, `cf-cache-status`). Nenhum desafio/CAPTCHA/`cf-mitigated` visto. | headers em `cat-sapatos.headers`, `robots.headers` | alta |
| F4 | `GET /c/sapatos` → 200, ~95KB, com UA Mozilla, UA vazio e UA `PriceWatcher/0.1` (todos 200). `Cache-Control: s-maxage=300`, `x-nextjs-cache: HIT`. | curl | alta |
| F5 | Site é Next.js (pages router, SSG, `__NEXT_DATA__`). Página de categoria SSG traz só slots de CMS/SEO, NÃO a lista de produtos (carregada no cliente). | `cat-sapatos.html` (pageProps: slots, seoContent) | alta |
| F6 | Página de produto `/<slug>/p/<SKU>` (200; `/p/<SKU>` dá 301) contém `__NEXT_DATA__.props.pageProps.product` com `price`, `discountPrice`, `variantOptions[].priceData/discountPrice`, `stock`, `sellable`, `code`, `legacySKU`. JSON-LD tem `Offer` com preço em texto ("R$99,99") e availability; Organization e BreadcrumbList. | `product-era-navy.html` | alta |
| F7 | Rota Next data funciona: `/_next/data/<buildId>/c/sapatos.json` (200 JSON). buildId muda a cada deploy. | curl; buildId `kMbN2-iqB0i9_FlwqyUTj` | alta |
| F8 | O front chama API Hybris/OCC própria: base `https://www.vans.com.br/arezzocoocc/v2/vans` (ex.: `/products/search`, `/products/search/autocomplete`, `/products/available-colors`, `/web-parameters`). `GET /products/search?query=era&pageSize=3&currentPage=0` responde 200 JSON anônimo (sem token), `x-total-count`, paginação, `products[]` com `code`, `price`, `stock`, `variantOptions`. `Cache-Control: no-cache`, `cf-cache-status: DYNAMIC` (cada chamada chega à origem). Seta `JSESSIONID`. | Chrome MCP network + grep em chunks JS + curl → `api-products-search-query-era.json` | alta (existência), média (estabilidade/contrato) |
| F9 | Sitemap: `/sitemap.xml` é índice → PRODUCT / CATEGORYLANDING / CATEGORY / CONTENT XML em `secure-static.vans.com.br` (nginx, `cache-control: max-age=1800`). Sitemap de produtos tem 2454 `<loc>` (URL + imagem, sem preço). | `sitemap.xml`, `sitemap-product.xml` | alta |
| F10 | Rate limit: 8 requisições sequenciais (1/s) a `/c/sapatos?page=N` → todas 200; sem `Retry-After`/`X-RateLimit-*`. Não foi testada carga alta (deliberado). Nenhum 429 observado. | curl | alta (para esse volume) |
| F11 | Não existe feed/API oficial documentada: `/api`, `/products.json`, `/feed.xml`, `/occ/v2`, `/.well-known/security.txt` → 404. | curl | média (só caminhos comuns testados) |
| F12 | Termos de uso: `https://www.vans.com.br/institutional/termosUso` (200, operador "ZZAB"/AZZAS 2154). Proíbe reprodução de textos/fotos/imagens/sons sem autorização escrita (seção Direitos de Autor). Reserva direito de coibir "abusos de usuários de má-fé" (contexto: fraude em pedidos). NÃO encontrei menção explícita a robôs/scraping/crawling. Política de privacidade: `/institucional/politica-de-privacidade` (não analisada). | `terms-termosUso.html` | média (busca textual por palavras-chave, não leitura jurídica integral) |
| F13 | Scripts de terceiros (GTM, Criteo, Meta, Clarity) retornaram 503 no browser — irrelevante para coleta, ruído. | Chrome MCP | baixa |

## 2. Interpretação / hipóteses

- H1: HTTP simples (sem Playwright) basta. A fonte mais leve e estável do preço por SKU é `__NEXT_DATA__` da página do produto (F6) — 1 GET por SKU, servida de cache SSG/CDN. Confiança média-alta.
- H2: Para descoberta/listagem, usar o sitemap de produtos (F9, sem preço) + opcionalmente `/products/search` (F8). A API é interna e não documentada: pode exigir token/mudar sem aviso. Confiança média.
- H3: Ausência de menção a scraping nos termos não é autorização. O uso pessoal, baixo volume, só dados públicos de preço é o cenário de menor risco; reproduzir imagens/descrições é a parte vedada — guardar só SKU, nome, preço, URL, disponibilidade (não copiar imagens/textos).
- H4: Preço em `pageProps.product` pode refletir o SSG (revalidação) e divergir do preço real do carrinho/Pix; JSON-LD do exemplo tinha `availability=OutOfStock` com preço, `stockLevel` 0 — validar semântica de estoque antes de alertar.

## 3. Riscos

- R1 Jurídico/ToS: termos proíbem reprodução de conteúdo; sem cláusula explícita de scraping. Uso pessoal; não redistribuir dados nem imagens.
- R2 Antibot: hoje não há desafio, mas Cloudflare pode ativar a qualquer momento. Política: ao ver 403/429/503 com challenge, parar e recuar — NÃO contornar.
- R3 `/arezzocoocc` é API interna: não documentada, origem sem cache (cada chamada custa ao lojista); não usar para polling frequente. Evitar o endpoint `/arezzocoocc/oauth` (token) — não tocado.
- R4 Quebra de layout: `__NEXT_DATA__`/schema pode mudar; `buildId` muda a cada deploy (não fixar rotas `_next/data`).
- R5 robots: caminhos `/search*` e `?q=:*` proibidos — nunca usar a busca web nem facetas `q=`.

## 4. Recomendação (menos invasiva)

1. Identificação honesta: UA próprio com contato (ex.: `VansPriceWatcher/0.1 (uso pessoal; contato: <email>)`); F4 mostra que não é bloqueado.
2. Lista de SKUs/URLs observados (watchlist) obtida uma vez do sitemap de produtos (cache 1h-30min; baixar no máx. 1x/dia).
3. Polling de página de produto: GET simples (sem Playwright), parse de `__NEXT_DATA__` (fallback: JSON-LD). Respeitar `Cache-Control` (`s-maxage=300`) e usar ETag/`If-None-Match` quando houver.
4. Frequência conservadora: 1x a cada 2-6 h por item, 1 req concorrente, 2-5 s de intervalo + jitter, teto ~200 req/dia para watchlist pequena (<=50 SKUs). Nada de varrer o catálogo inteiro (2454 SKUs) mais que ocasionalmente (semanal).
5. Respeitar robots.txt (reler 1x/dia); honrar 429/`Retry-After`; backoff exponencial; circuit breaker: 3 falhas/403/challenge seguidas → pausar 24h e alertar o dono.
6. Playwright só como último recurso (se `__NEXT_DATA__` sumir) e ainda sem evasão; hoje não é necessário.

## 5. Recuperação se o site mudar

- Parser em camadas: (a) `__NEXT_DATA__.pageProps.product`; (b) JSON-LD `Offer`; (c) `/arezzocoocc/.../products/search` pontual. Se uma camada falhar e outra funcionar, alertar "parser degradado" em vez de silenciar.
- Validação de schema por fixture (`tests/fixtures/vans/`): teste de contrato quebra visivelmente; preço fora de faixa (<=0 ou variação >70%) vai para quarentena, sem alerta de preço.
- Salvar HTML bruto da última falha para depuração (sem cookies).
- Se vier bloqueio/challenge: parar, reduzir frequência; não contornar. Alternativa: contato com a Vans (`atendimento.vans.com.br`) ou monitor manual.

## 6. Incógnitas

- Limite real de rate (não testado acima de 1 req/s por poucos pedidos).
- Se `/arezzocoocc` é permitido contratualmente (não coberto por robots nem termos lidos).
- Política de privacidade e termos de AZZAS não lidos integralmente por jurista.
- Frequência real de revalidação do SSG do produto (preço pode estar defasado até minutos/horas).
