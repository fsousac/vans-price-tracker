# Referências de produto: Keepa, CamelCamelCamel, Visualping, Honey

Data da pesquisa: 2026-10-14. Método: WebFetch/WebSearch em docs/FAQ/help oficiais. Nada foi testado com contas reais.

Limitações: `camelcamelcamel.com` (todas as páginas) respondeu HTTP 403 ao WebFetch; os fatos do CamelCamelCamel vêm de trechos do WebSearch que citam as URLs oficiais (confiança média). A home do Keepa é SPA e não retornou o texto de ajuda; os fatos de rearm/frequência do Keepa vêm de resumo de busca da home e de fórum antigo (confiança média/baixa).

## 1. Achados por ferramenta

Formato: fato | origem | confiança | interpretação (data de todos: 2026-10-14).

### Keepa
| Fato | Origem | Conf. | Interpretação |
|---|---|---|---|
| Alertas opt-in via email, Telegram, Web Push, apps iOS/Android | texto de Help da home https://keepa.com/ (via resumo WebSearch) | média | Canais múltiplos, escolhidos pelo usuário. |
| "Desired price" tem rearm timer; padrão 7 dias; pode ser "Never" (desliga após disparar até ser editado) ou N dias (pausa e reativa) | home Keepa; https://discuss.keepa.com/t/continuous-tracking-rearm-timer/62 (WebFetch falhou: ENOTFOUND; só resumo de busca) | média | Anti-repetição por cooldown por alvo, não só por estado. |
| Cada preço-alvo tem timer próprio; editar rearma | idem (resumo de busca; fórum antigo) | baixa/média | Estado de alerta por (produto, alvo). |
| Produtos rastreados checados de hora em hora (post de fórum antigo) | fórum Keepa via resumo de busca | baixa | Possivelmente desatualizado. |
| API: tracking tem `thresholdValues`, `notifyIf`, `notificationType`, `ttl`, `expireNotify`, `updateInterval`, `individualNotificationInterval`; re-adicionar ASIN sobrescreve tracking; notificações apagadas após 24h; webhook com 1 retry após 15 s | https://keepa.com/api-docs/tracking.html (WebFetch) | alta (campos nos exemplos; semântica não definida na página) | Modelo útil: limiar + intervalo mínimo entre notificações + TTL. |
| Histórico de preços é feature central ("price history, tracking, notifications") | https://keepa.com/#!features | baixa (só título) | Sem detalhe de armazenamento nas fontes consultadas. |

### CamelCamelCamel
| Fato | Origem | Conf. | Interpretação |
|---|---|---|---|
| Usuário define limiar de preço; site envia email quando atingido | https://camelcamelcamel.com/features (via WebSearch; WebFetch 403) | média | Fluxo base: produto + preço-alvo + email. |
| 3 tipos de preço (Amazon, 3rd party novo, 3rd party usado); form Simple esconde tipos sem estoque há muito tempo; Detailed mostra todos | /features, /support (via WebSearch) | média | Séries separadas por tipo/variante de preço. |
| Dados não são "live"; há atraso entre mudança na loja e detecção | https://camelcamelcamel.com/support/price_checks (via WebSearch) | média | Comunicar defasagem ao usuário. |
| Produto sem checagem há 8 h ou mais é enfileirado ao ser visualizado; usuário registrado pode "Request Update" | /support/price_checks e blog (via WebSearch) | média | Checagem agendada + sob demanda. |
| "Repricing": se alvo < mínimo histórico, sinaliza e sugere alvo mais realista | https://camelcamelcamel.com/support/repricing (via WebSearch) | média | Usar histórico para validar o alvo. |
| Intervalos "poucas horas / ~6 h" são de blog de ~2010 | https://camelcamelcamel.com/blog/how-our-price-checking-system-works/ | baixa (obsoleto) | Não usar como referência atual. |
| Nada obtido sobre repetição de alertas | buscas | n/a | Incógnita. |

### Visualping
| Fato | Origem | Conf. | Interpretação |
|---|---|---|---|
| Frequências: 2/5/15/30 min, 1/3/6/12 h, diário, 2 dias, semanal, quinzenal, mensal; padrão diário; Free: mínimo horário; cada checagem (inclusive falha) consome cota | https://help.visualping.io/en/articles/4441153 (WebFetch) | alta | Diário como padrão é aceitável para preço. |
| Limiar de mudança: Any, Tiny (>1%), Medium (>10%), Major (>25%), Gigantic (>50%) | https://help.visualping.io/en/articles/4441409 | alta | É % de diferença da página, não preço-alvo. |
| Seleção de área para reduzir ruído (artigo "How area selection works") | https://help.visualping.io/en/categories/1030081-job-settings (lista); https://visualping.io/blog/get-notified-when-something-goes-on-sale (marketing) | média | Monitorar só o elemento do preço. |
| Condição em linguagem natural "Alert me when" (ex.: preço abaixo de X) com IA; só blog/marketing, sem doc de help | https://visualping.io/blog/amazon-price-tracking (via WebSearch) | baixa/média | Não replicar IA; comparação numérica determinística basta. |
| Canais: email, webhook, Telegram, n8n, API gratuitos; SMS/CC/Slack etc. em planos pagos; email é padrão | https://help.visualping.io/en/articles/10305217 | alta | Webhook/Telegram como canais simples. |
| Anti-ruído: filtro "só alertas importantes", relatórios em vez de alertas, alert on error ("When failing" após 100 erros consecutivos, ou todo erro) | https://help.visualping.io/en/articles/5791937; https://visualping.io/blog/alert-on-error (via WebSearch) | alta/média | Alertar falha de coleta com limiar de erros consecutivos. |
| Existem relatórios ("Creating Visualping Reports") | https://help.visualping.io/en/categories/1029825-getting-started (só título) | baixa | Detalhes não lidos. |

### Honey (Droplist)
| Fato | Origem | Conf. | Interpretação |
|---|---|---|---|
| Adiciona item pelo ícone "h" ou botão "Add to Droplist"; sem limite de itens | https://help.joinhoney.com/article/79-what-is-droplist (WebFetch) | alta | Adição em 1 clique. |
| Alerta quando preço cai abaixo do valor escolhido; também por percentual; email, desligável em Notificações | idem | alta | Alvo em valor ou %. |
| Duração 30/60/90/120 dias, desconto mínimo, tags/tamanho/cor (Amazon) | https://help.joinhoney.com/article/46-can-i-use-honeyon-amazon, artigo 220 (via WebSearch) | média | Expiração do watch evita itens mortos. |
| Frete/imposto não entram no preço | help.joinhoney.com (via WebSearch) | média | No projeto: só preço de vitrine, declarar isso. |
| Preço pode subir antes de o usuário ler o email; Honey não garante preço; sugere ver histórico | https://help.joinhoney.com/article/94-why-did-my-droplist-item-increase-in-price (WebFetch) | alta | Alerta com preço, timestamp, link e aviso. |
| Price History 30/60/90/120 dias, só Amazon.com US | help.joinhoney.com (via WebSearch) | média | Histórico com janela limitada. |

## 2. Matriz comparativa

| Aspecto | Keepa | CamelCamelCamel | Visualping | Honey Droplist |
|---|---|---|---|---|
| Adicionar produto | ASIN/URL; API | URL/ASIN no site ou extensão (média) | URL + selecionar área | Ícone/botão na página |
| Alvo | Preço desejado por tipo de preço | Limiar em valor ou % por tipo de preço | % de mudança da página; condição textual por IA (marketing) | Valor ou % de queda |
| Armazenamento | Não publicado | Não publicado | Snapshots/relatórios (só título) | Não publicado; janelas 30-120 d |
| Frequência | ~horária (baixa conf.) | atraso, sem número atual; refresh sob demanda | 2 min a mensal; padrão diário | Não publicado |
| Canais | Email, Telegram, Web Push, apps | Email | Email, webhook, Telegram, outros | Email, push (app) |
| Anti-repetição | Rearm timer por alvo (7 d padrão, "Never"); `individualNotificationInterval` na API | Não encontrado | Limiar de mudança; filtros; digest; alert on error | Não documentado; admite que preço pode já ter subido |
| Histórico | Sim | Sim (gráfico) | Relatórios | Sim, janelas limitadas |

## 3. Fato / hipótese / risco

Fatos: seções 1 e 2, com a confiança indicada.

Hipóteses a validar:
- H1: cooldown por alvo mais re-armar quando o preço volta acima do alvo evita spam sem perder novos mínimos (inferido do rearm do Keepa).
- H2: 1 a 4 checagens por dia bastam para vans.com.br (Visualping usa diário por padrão; medir volatilidade real).

Riscos:
- R1: fontes de CamelCamelCamel/Keepa parcialmente indiretas; revalidar antes de tratar como definitivo.
- R2: Visualping e Honey são genéricos ou de outro mercado; varejo brasileiro pode diferir.
- R3: alerta defasado no momento da leitura (Honey, artigo 94).

## 4. Princípios aplicáveis ao Vans Price Watcher

1. Alvo por produto em valor absoluto (opcionalmente %), comparado de forma determinística; sem IA.
2. Guardar série histórica (produto/variante, preço, disponibilidade, timestamp, fonte) para validar alvos (estilo Repricing) e mostrar mínimo histórico.
3. Estado de alerta por (produto, alvo): dispara na transição acima para abaixo/igual; re-arma por cooldown (Keepa: 7 d padrão) ou quando o preço volta acima do alvo.
4. Alerta com preço, data/hora da leitura, link e aviso de que o preço pode ter mudado.
5. Alertar falha de coleta só após N falhas consecutivas (Visualping usa 100 no modo "when failing"; escolher N bem menor para poucas checagens por dia).
6. Baixa frequência (diário ou poucas vezes ao dia), coerente com baixo volume.
7. Séries separadas por variante (tamanho/cor), como CCC faz por tipo de preço.
8. Canais simples (webhook/Telegram/email), sem dependência de plano.
9. Expiração opcional do watch (Honey: 30 a 120 dias).

## 5. Incógnitas
- Como CamelCamelCamel evita alertas repetidos (sem fonte acessível).
- Como Keepa/CCC/Honey armazenam preços internamente (não publicado).
- Semântica exata de `individualNotificationInterval` e `ttl` do Keepa (só exemplos).
- Frequência de checagem atual de CCC e Honey.
