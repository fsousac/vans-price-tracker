# Investigação do catálogo vans.com.br/c/sapatos

Data de todas as observações: 2026-10-14. Origem principal: curl com UA Mozilla, Chrome MCP (aba real), leitura dos chunks JS de `secure-static.vans.com.br`. Apenas GETs públicos, baixo volume (~8 requisições à API/HTML).
Fixtures em `tests/fixtures/vans/`: `sapatos.raw.html`, `tenis.raw.html`, `*.headers.txt`, `sitemap.xml`, `search.sapatos.page0.sample.json` (3 produtos, `allImages` removido, sem cookies).

## 1. Fatos

| # | Achado | Evidência / origem | Confiança |
|---|---|---|---|
| F1 | Site é Next.js (pages router, rota `/c/[...categories]`, buildId `kMbN2-iqB0i9_FlwqyUTj`); HTML inicial traz `__NEXT_DATA__` | `curl https://www.vans.com.br/c/sapatos` -> `__NEXT_DATA__` (page `/c/[...categories]`, query `categories:[sapatos]`) | alta |
| F2 | O HTML inicial NÃO contém produtos: `pageProps` só tem `slots` (banners/CMS), `seoContent`, `isVipRoute`. 0 ocorrências de código de produto, `price`, `pagination`, `products` em `/c/sapatos` e `/c/sapatos/tenis`. | curl + parse JSON de `__NEXT_DATA__` | alta |
| F3 | Os produtos são carregados no cliente via API SAP Commerce (OCC) do mesmo domínio: `GET https://www.vans.com.br/arezzocoocc/v2/vans/products/search?category=SAPATOS&currentPage=0&pageSize=24&fields=FULL&storeFinder=false` -> 200 JSON | Chunk `_app-*.js` (função `buildGetUrl`: `products/search?category=..&currentPage=..&pageSize=..&fields=..&storeFinder=..`, pageSize padrão 24, baseURL `/arezzocoocc/v2/vans/`); chamada real feita via curl, 200, 388 KB | alta |
| F4 | Sem autenticação nem cookie necessário para essa chamada (curl sem cookies). Resposta traz `Set-Cookie: JSESSIONID` (ignorável). | curl | alta |
| F5 | Paginação: `pagination{currentPage,pageSize,totalPages,totalResults,sort}`; header `x-total-count: 1239`. Em /c/sapatos: 1239 produtos, 52 páginas de 24; `currentPage` é 0-based; página 0 e 1 sem sobreposição. `pageSize=100` aceito (13 páginas, 1,4 MB). Limite máximo de pageSize NÃO testado. | curl | alta |
| F6 | Campos por produto (FULL): `code` (ex. `1003551190001U`), `name`, `url` (`/slug/p/CODE`), `price{value,formattedValue,currencyIso,priceType}`, `channelPrices[]`, `installment` ("5x de R$109,99"), `sellable`, `sellableOmni`, `color`, `legacySKU`, `legacyEntireSKU`, `hasPriceVariations`, `categories[]`, `productType`, `sizesAvailabilityInfo[{code,size,available}]`, `variantOptions[{code,sellable}]`, `moreColors`, `moreColorsQuantity`, `stock{}` (vazio), `images`/`allImages`. Um produto = uma cor; tamanhos são variantes `CODE-<tamanho>`. | `search.sapatos.page0.sample.json` | alta |
| F7 | Ordenações (`sorts`): `creation-time` (padrão), `price-asc`, `price-desc`, `best-selling-desc`, `product-sort`, `percentual-of-discount`. | resposta JSON | alta |
| F8 | Facetas: Gênero, Tamanho Calçados, Cor, Categoria, Estilo Calçados, Preço, Material; cada valor tem `query.query.value` no formato `:creation-time:gender:FEMININO`. Subcategorias: `CHINELO` (/c/sapatos/chinelo), `TENIS` (/c/sapatos/tenis). | resposta JSON | alta |
| F9 | `/c/sapatos` no navegador redireciona no cliente para `/c/sapatos/tenis?page=1` (page= na URL do site é 1-based, API é 0-based) | Chrome MCP, URL final da aba | média |
| F10 | JSON-LD no catálogo: apenas `Organization` (sem `ItemList`/`Product`). | curl, regex `application/ld+json` (1 ocorrência) | alta |
| F11 | Cabeçalhos HTML: `Cache-Control: s-maxage=300, stale-while-revalidate`, `x-nextjs-cache: HIT`, `cf-cache-status: HIT`, Cloudflare. API: `Cache-Control: no-cache, no-store`, `cf-cache-status: DYNAMIC` (dados sempre frescos). | `catalog.headers.txt`, `search.headers.txt` | alta |
| F12 | Existem `_next/data/<buildId>/c/sapatos.json` (200, ~28 KB), mas é só o mesmo `pageProps` (CMS), sem produtos. buildId muda a cada deploy. | curl | alta |
| F13 | `sitemap.xml` é um índice com 4 sitemaps (PRODUCT, CATEGORYLANDING, CATEGORY, CONTENT) hospedados em `secure-static.vans.com.br/medias/sys_master/...xml` (nomes com hash, mudam). O de PRODUCT tem 2454 `<loc>` (todas as categorias, não só sapatos) no formato `https://www.vans.com.br/<slug>/p/<CODE>` com imagem; sem preço. `last-modified` do índice 2026-10-14 09:00 GMT. | curl | alta |
| F14 | Endpoints auxiliares chamados pela página: `/arezzocoocc/v2/vans/products/available-colors`, `web-parameters`, `searched-terms`, `dynamic-configs/*`, `POST /api/recommendation/` (202). | `performance.getEntriesByType('resource')` | alta |

## 2. Hipóteses (não verificadas)
- H1: `category=TENIS`/`CHINELO` (maiúsculo, igual ao código em `subCategories`) filtra subcategorias; o JS usa `category=<slug em maiúsculas>`. Não testado por chamada. (média)
- H2: filtros/ordenação na API usam o parâmetro `query=` no formato das facetas (`:sort:facet:valor`), conforme `buildGetUrl`. Teste com `sort=percentual-of-discount` como parâmetro separado foi ignorado pela API (continuou `creation-time`). (média)
- H3: promoções aparecem em `price` / `hasPriceVariations` / `channelPrices`; não observei nenhum produto com preço promocional na amostra, logo o formato "de/por" é DESCONHECIDO. (baixa)
- H4: `stock` vazio significa que o estoque numérico não é exposto; disponibilidade só via `sizesAvailabilityInfo`. (média)

## 3. Riscos
- R1 robots.txt: `Disallow: /search*` e `/*?q=:*` valem para páginas do site; o endpoint `/arezzocoocc/...` não está listado, mas a API de busca com `query=:...` pode ser interpretada como busca com filtros; preferir apenas `category=` sem `query`. `/p/*` está liberado, porém robots tem `/p/*/write-answer` disallow; URLs de produto são `/slug/p/CODE` (padrão `/p/*` não casa por prefixo; ambiguidade a validar na tarefa PDP).
- R2 A API OCC é interna/não documentada: pode mudar, exigir token ou ser bloqueada (Cloudflare). Não foi encontrado CAPTCHA/antibot nas chamadas feitas, nenhuma evasão tentada.
- R3 Volume: 1239 itens = 13 chamadas com pageSize=100 (ou 52 com 24). Sugestão: 1 execução/hora ou menos, UA identificável, backoff em 429/403/503.
- R4 Sitemap de produto cobre todas as categorias e tem URL com hash que muda; use o índice `sitemap.xml` para resolvê-lo a cada execução.
- R5 HTML renderizado por cliente: scraping de HTML não serve; depende da API.

## 4. Recomendação
Monitorar via `GET /arezzocoocc/v2/vans/products/search?category=SAPATOS&currentPage=N&pageSize=100&fields=FULL&storeFinder=false` (parar em `totalPages`), chave primária `code` (cor) + `variantOptions.code` (tamanho), preço em `price.value`. Validar com HEAD/GET adicional: teto de pageSize, forma de preço promocional, `category=TENIS`. Sitemap serve só para descoberta de URLs/PDP.
