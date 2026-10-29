# Investigação: página de produto (vans.com.br)

Data de todas as observações: 2026-10-14. UA: Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/130. Volume baixo (~60 requisições, pausa de 1,5 s), apenas páginas/APIs públicas sem autenticação, sem evasão de antibot. Confiança: A=alta, M=média, B=baixa.
Fixtures em `tests/fixtures/vans/` (prefixos `product_*`, `occ_*`, `nextdata_*`). Sem dados pessoais/cookies.
Nota de ferramenta: `mcp__rea__capture_browser_scenario` falhou (provider closing); usei curl + Chrome MCP. Não há evidência obtida via REA.

## 1. Fatos

### 1.1 URL e identificadores (A)
- URL do produto: `/{slug}/p/{codigo}` (ex.: `/tenis-hylane-2-tone-khaki-green/p/1003800580026U`). Origem: `<loc>` do sitemap de produtos (2454 URLs), curl.
- `/p/{codigo}` sem slug: 301 para a URL com slug (`product_nosuffix_301.headers.txt`).
- Slug errado + SKU certo: 200, mas `rel=canonical` aponta para o slug errado (auto-canônica). Não usar canonical para identidade; usar o código.
- SKU inexistente: HTTP 404 HTML "Página não encontrada" (`product_404.html`). URL de variante (`.../p/{codigo}-40`): 404.
- Produto = cor/modelo (`1003800580026U`, tipo "ModelVariantProduct"); variante = tamanho (`1003800580026U-34`). Também `legacySKU` (`V1003800580026`) e `ean` por variante (null em alguns, ex.: tamanho 48).
- Cada cor é outro produto (outro código/slug); `colorOptions` lista cores irmãs com preço e `sellable` próprios.

### 1.2 Fontes de dados (A)
1. HTML SSR (Next.js pages router, buildId `kMbN2-iqB0i9_FlwqyUTj`): `<script id="__NEXT_DATA__">` -> `props.pageProps.product`. `Cache-Control: s-maxage=300, stale-while-revalidate`; `x-nextjs-cache` MISS/STALE/HIT (cache de até ~5 min).
2. JSON-LD: Organization, BreadcrumbList, Offer agregado (`price` string "R$99,99", `priceValidUntil` "17/10/2026" em dd/mm/aaaa) e Product com `offers[]` por variante (sku `{codigo}-{tam}`, `price` decimal em string, `availability` schema.org In/OutOfStock, `priceCurrency` BRL). Só traz o preço efetivo (com desconto), NÃO o preço "de". `color` vazio em alguns.
3. Meta tags: só og:title, og:description (texto de marketing sem preço), og:image, canonical. Não há `og:price`/`product:price`.
4. API pública OCC (SAP Commerce), sem auth, JSON, `Cache-Control: no-cache, no-store`, `cf-cache-status: DYNAMIC` (dado fresco):
   - `GET /arezzocoocc/v2/vans/products/{codigo}` (~75 KB): `baseOptions[0].options[]` = variantes com `code`, `displayText` (tamanho), `ean`, `priceData`, `discountPrice`, `sellable`, `stock{stockLevel,stockLevelStatus}`, `installments`.
   - `GET .../products/{codigo}/dynamic-product-fields` (~18 KB): XHR que a página dispara ao carregar; traz `price`, `discountPrice`, `percentualOfDiscount`, `installment`, `sellable`, `purchasable`, `isPreOrder`, `variantOptions[]`, `colorOptions[]`.
   - `GET .../products/{codigo}-{tam}?fields=FULL`: variante individual (`priceType: BUY`).
   - Código inexistente ou variante inválida: HTTP 400 `UnknownIdentifierError` (`occ_404.json`).
5. `/_next/data/{buildId}/{slug}/p/{codigo}.json`: mesmo `pageProps` do SSR; quebra a cada build.
- robots.txt: `/p/*` liberado, só `/p/*/write-answer*` bloqueado. `/arezzocoocc/` não consta em Disallow.

### 1.3 Preço (A)
- Moeda `currencyIso: "BRL"`. Numérico em `value` (float com ruído: `99.99000000000001`, `49.989999999999995`; arredondar para centavos).
- "Por" = `discountPrice.value`; "de" = `price.value`. Sem desconto: `discountPrice` zerado no SSR (`currencyIso:""`, `value:0`) ou ausente no OCC; `percentualOfDiscount` vazio/ausente.
- Formato inconsistente: `price.formattedValue` "R$ 279,99" (com espaço), `discountPrice.formattedValue` "R$99,99" (sem espaço). Usar `value`, não parsear texto.
- `priceType` FROM no produto, BUY na variante. Preço igual entre tamanhos nos itens vistos (`hasPriceVariations:false`).
- `percentualOfDiscount` é string inteira arredondada ("41" para 649,99 -> 379,99).
- `installment` ("3x de R$126,66") vem vazio no SSR e preenchido na API dinâmica.
- Medidos: Era True White 299,99 -> 149,99 (sem estoque); Era Navy 279,99 -> 99,99 (sem estoque, -64%); Hylane 2-Tone Khaki Green 649,99 -> 379,99 (em estoque, -41%); Knu Skool Pig Deep Twilight 699,99 sem desconto (em estoque).

### 1.4 Disponibilidade por variante (A campos / M semântica)
- Sinal confiável: `sellable` + `stock.stockLevel` por variante.
- `stockLevelStatus` NÃO é confiável: há `lowStock` e `inStock` com `stockLevel:0` e `sellable:false` (Era True White: 13 tamanhos "lowStock" com nível 0). Usar `sellable && stockLevel>0`.
- Amostra de 21 produtos (OCC): nível real (2..70) só aparece em itens vendáveis.
- Nível de produto: `sellable`/`purchasable` inconsistentes entre fontes (SSR `purchasable:false` com produto em estoque; OCC `purchasable:true` mesmo sem estoque). Não usar `purchasable`; derivar do OR das variantes.
- Hylane: tamanhos 33-36 vendáveis (5/11/14/4 un.), 37-40 sem estoque; `isPreOrder:true` na API dinâmica (significado desconhecido).
- JSON-LD `availability` por variante reflete `sellable` (Knu Skool: 33 OutOfStock, 34+ InStock).

### 1.5 Trocar tamanho/cor (A/M)
- Clicar num tamanho não altera URL nem dispara nova requisição de dados (só `dynamic-product-fields` do load inicial e prefetch `_next/data`). M: 1 clique (tamanho 35) em 1 produto.
- Trocar cor = navegar para outro código (`colorOptions[].url`).

### 1.6 Produto indisponível (A)
- Totalmente sem estoque (Era True White): servidor devolve 200 com HTML e dados completos (preço mantido). No navegador a SPA redireciona no cliente para `/c/sapatos/tenis?page=1` (Chrome MCP; o evento view_item já disparou com value=149.99). Produto com estoque não redireciona. curl não vê o redirect.

## 2. Hipóteses
- H1: backend oculta `stockLevel` (0) quando não vendável; não se distingue "zero" de "oculto". M.
- H2: `lowStock` com nível 0 pode ser estoque omni/loja (`sellableOmni`). B.
- H3: `priceValidUntil` é data móvel gerada (hoje+3), não fim real da promoção. M.
- H4: `isPreOrder:true` no Hylane pode ser flag incorreta (há estoque). B.
- H5: limite de taxa da OCC desconhecido (~40 chamadas sem bloqueio).

## 3. Riscos
- R1: OCC não documentada; pode mudar/ser bloqueada. Usar intervalo >= 1,5 s e cache.
- R2: buildId do `_next/data` muda por deploy; preferir `__NEXT_DATA__` do HTML ou OCC.
- R3: campos inconsistentes (formato de preço, purchasable, stockLevelStatus); normalizar por `value`.
- R4: HTML SSR cacheado até 5 min; para preço atual preferir OCC (no-store). Registrar fonte e timestamp.
- R5: redirect client-side em OOS diferencia navegador de curl.

## 4. Recomendações
1. Chave: `codigo` do produto e `codigo-tamanho` por variante; ignorar slug.
2. Descobrir catálogo pelo sitemap de produtos (listagens `/c/*` são renderizadas no cliente).
3. Coletar via `GET /arezzocoocc/v2/vans/products/{codigo}`; fallback `__NEXT_DATA__`. Preço em centavos: original = `price.value`, atual = `discountPrice.value` se >0 senão `price.value`.
4. Disponibilidade = `sellable && stockLevel>0` por variante; alertar por tamanho.
5. 404 HTML ou 400 OCC = produto removido (distinto de "sem estoque").
6. Fixtures: `product_*` (SSR: disc/OOS, disc/em estoque, sem desc./em estoque, 404 + headers), `occ_*`, `nextdata_*`.
