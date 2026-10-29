# ADR-0002: Coleta por OCC com fallback em `__NEXT_DATA__` e JSON-LD

Status: aceito (2026-10-14). Reabre se H5/Q6 da investigação for refutada ou se o dono inverter C1.

## Contexto

Investigação (`docs/investigation.md`, 3.3 e 5): o preço de vitrine por `code` está em três fontes que concordam nos valores das fixtures. OCC `GET /arezzocoocc/v2/vans/products/{code}` é fresco (`no-cache`, `DYNAMIC`), 75-171 KB, com estoque por tamanho. O HTML SSR (`__NEXT_DATA__.props.pageProps.product`) vem de cache até ~5 min e tem a mesma estrutura. JSON-LD só traz preço efetivo e `availability`. A listagem `/c/*` não serve (produtos carregados no cliente). OCC é API interna sem contrato público; `robots.txt` não a proíbe; termos não foram analisados juridicamente (R-02). Playwright foi descartado.

## Decisão

1. **Fonte primária:** OCC `GET /arezzocoocc/v2/vans/products/{code}` (1 requisição por produto, sem `fields`, sem cookies).
2. **Fallback 1:** HTML `/{slug}/p/{code}` (ou `/p/{code}`, que a loja redireciona com 301) lendo `__NEXT_DATA__`.
3. **Fallback 2: JSON-LD `Offer` fica FORA do MVP** (sem preço "de", preço agregado em string, sem estoque numérico; só reabrir se o SSR sumir).
4. Toda leitura de fallback é `degraded=true` e só confirma com leitura concordante (RN-09, RN-09a); o dono é avisado 1x por episódio.
5. Cai para o próximo **somente** em `rede_timeout`, `http_5xx` (sem `cf-mitigated`), `formato_desconhecido`. **Nunca** em 403/desafio (inclusive `503` com `cf-mitigated`)/429 (isso abre o circuito de 24 h) nem em `produto_removido`.
6. Contrato do parser: preço só de `value` em centavos; preço efetivo = `discountPrice.value>0` ? ele : `price.value`; disponibilidade = `sellable && stockLevel>0` (OR por produto); tamanho de `displayText`/sufixo do `code` (nunca de `url`, que vem `""` no SSR); estrutura sem `baseOptions[0].options` = `formato_desconhecido`.
7. Descoberta: OCC `/products/search?category=SAPATOS&currentPage=N&pageSize=...`, 1x/24 h, cortesia de 2-5 s; nunca `query=:`, `q=` ou `/search*` (robots). `category=TENIS` só depois de validar H6.
8. Redirects: OCC e listagem não seguem nenhum; a página de produto só segue `/{slug}/p/{mesmo code}` no mesmo host.
9. Coletor atrás de `PriceSource`; `FakeSource` e `FakeHttpClient` servem fixtures.

## Alternativas

| Alternativa | Veredito |
|---|---|
| `__NEXT_DATA__` como primária (access-policy) | Menor carga à origem (cache CDN), mas até ~5 min defasada e formato Next pode mudar. Mantida como fallback. Se o dono preferir carga mínima, a inversão é trocar a ordem no `CompositeSource` (C1) |
| JSON-LD como primária | Sem preço "de" e sem estoque numérico |
| `/products/search` para monitorar | `stock` vazio, `query=` esbarra em robots, 13+ chamadas |
| Sitemap | Sem preço; hashes mudam; só descoberta opcional (S) |
| Playwright | Detectável, pesado, sem ganho de dado; redirect de produto esgotado o enganaria |

## Consequências

- OCC é API interna: pode mudar ou exigir token (R-01). Mitigações: fallback, testes de contrato por fixtures, `formato_desconhecido` explícito, aviso de parser degradado, `npm run test:live` manual para detectar mudança.
- 1 requisição por `code` (não por variante), 4 h por padrão, teto 400 req/24 h de qualquer origem (50 x 6 = 300 de base + catálogo + folga; 300 estourava na base): política conservadora, não medida (Q6/H5).
- Produto totalmente sem estoque continua legível (200 com preço); removido (400/404) é estado distinto.
- Sem evasão: troca de UA, IP ou desafio de Cloudflare não é contornado.
