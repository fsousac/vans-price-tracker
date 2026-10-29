# Requisitos: Vans Price Watcher

Versão 0.1 (2026-10-14). Base factual: `docs/investigation.md` e `docs/investigation/*.md`, mais `tests/fixtures/vans/`. Nada aqui inventa seletor, campo ou API que não esteja nessas fontes; o que a investigação deixou em aberto aparece como decisão padrão (seção 9) ou risco (seção 10).

Convenções: `RF-nn` requisito funcional; `RN-nn` regra de negócio; `RNF-*` não funcional; `D-nn` decisão padrão; `R-nn` risco; `J-n` jornada. Todo valor monetário é em centavos inteiros (BRL). Prioridade: **M** = MVP, **S** = melhoria, **F** = futuro.

---

## 0. Decisão de pivô: extensão de navegador (2026-10-15, ADR-0006)

O produto passa de "aplicação web local (servidor Node)" para **extensão de navegador Chrome/Edge, Manifest V3**. Regras de negócio (RN-01..21), máquinas de estado (seção 6), RF-01..12 e a política de coleta **continuam valendo**; muda o meio. Onde as seções 1-12 disserem "app", "servidor", "porta", "banco", "SMTP", "variável de ambiente" ou "painel web", leia a coluna "Adaptação" abaixo. Desenho: `docs/extension-architecture.md`; ameaças: `docs/security.md` seção 9.

| Item | Era | Passa a ser |
|---|---|---|
| Forma | Servidor local, `127.0.0.1:PORT`, SQLite, laço `tick` | Extensão MV3: service worker efêmero, `chrome.alarms`, IndexedDB, popup e página de opções |
| RF-01 catálogo | Busca local do catálogo `SAPATOS` | Igual, na aba "Catálogo"; atualização em fatias retomáveis, 1/24 h |
| RF-02 cadastro por URL | Colar URL no formulário web | Duas entradas: **popup** na aba de produto Vans (extrai o `code` da URL da aba, `activeTab`) e campo de URL na aba "Catálogo"; mesma validação (`url.ts`) |
| RF-03 variante | Escolha de tamanho na página | Escolha de tamanho no popup/dashboard, com preço e disponibilidade lidos do OCC (`tab.inspect`); sem estoque numérico |
| RF-04, RF-05 alvo e faixa | Formulário web | Idênticos (RN-10, 5.4); formulário do popup e do dashboard |
| RF-06 monitoramento | Intervalo 2-6 h, recuperação ao abrir o app, 1 rodada por vez | Igual, por alarme: `tick` de 15 min decide se a rodada venceu; rodada **retomável** em fatias; "app fechado" vira **navegador fechado** (D-13): ao abrir, alarmes vencidos disparam e há no máximo 1 rodada de recuperação |
| RF-07 histórico | Tela do alerta | Aba "Histórico" do dashboard (IndexedDB, sem alteração de regra) |
| RF-08 e-mail | Alerta por e-mail (SMTP, modo `test`/`real` por ambiente), e-mail por alerta | **Canal primário: notificação do navegador** (`chrome.notifications`). **E-mail OPCIONAL** por API HTTP de provedor transacional configurada pelo próprio usuário (v1: Resend), com **um destinatário nos ajustes** (o dono), não por alerta. O RF-08 fica atendido por esse caminho opcional; o estado final continua sendo "aceito pelo provedor", nunca "entregue" |
| RF-09 gestão e dashboard | Páginas web | Página de opções/dashboard: lista, pausar/retomar/editar/excluir, histórico, saúde, e-mail, catálogo; popup para o caso rápido |
| RF-10 deduplicação/rearme | Chave `hash(...)` | Mesma regra; chave primária composta em texto `alerta\|revisão\|tipo\|episódio` (idempotência por PK da store) |
| RF-11 falhas | Igual | Igual; mais: retomada de rodada após o service worker ser encerrado nunca grava meia observação |
| RF-12 saúde | `/saude` JSON | Aba "Saúde" (mesmos campos, sem PII); sem endpoint HTTP |
| RNF-SEC-03/04 (bind, CSRF), RNF-SEC-06 (cabeçalhos) | Servidor | Substituídos por: permissões mínimas, CSP MV3, validação de `sender` e payload (security X1-X3) |
| RNF-SEC-05 (segredo por ambiente) | `.env`/SMTP | Chave do provedor só em armazenamento local da extensão, nunca devolvida à UI (X4) |
| Identificação (RNF-LEG-02) | UA `VansPriceWatcher/0.1` | **Não controlável** em `fetch` de extensão; desvio aceito e registrado (security X14) |
| Distribuição | `npm start` | `npm run build` e "carregar sem compactação" (uso pessoal) |

**Decisão sobre o e-mail opcional (substitui D-16 e D-21 no que dependem de ambiente):**
- Padrão: e-mail **desligado**; ao ligar, o modo padrão é `teste` (não abre conexão; a notificação termina `ACEITO` com `simulado = true`, exibida como "simulado, não enviado").
- Modo `real` exige: permissão opcional de host `https://api.resend.com/*` concedida **por clique do usuário em runtime**, chave de API, remetente e destinatário válidos. Sem a permissão ou ao revogá-la, o canal é desligado e a notificação do navegador segue funcionando.
- Aviso de saúde ao dono (D-21): vai como notificação do navegador; por e-mail só se o canal estiver ligado.
- A política de retentativas (5 min / 30 min / 2 h; 4 envios; teto 20/h) vale só para o canal e-mail; a notificação do navegador não é reenviada automaticamente.

**Adaptação dos critérios de aceite afetados** (os demais permanecem literais):

| AC | Adaptação |
|---|---|
| RF-02-AC1..5, 7 | "Colar URL" também vale para a URL da aba ativa no popup; nenhuma URL do usuário é buscada (só o `code` é extraído) |
| RF-06-AC2 | Intervalo 2-6 h nos ajustes; fora da faixa é recusado na UI (antes: na partida) |
| RF-06-AC4/5 | "Rodada anterior em andamento" = lease de 90 s viva; "recuperação ao abrir" = recuperação ao acordar/abrir o navegador |
| RF-08-AC4 | Modo teste = `DryRunMailer`: nenhuma conexão, `ACEITO` simulado |
| RF-08-AC5 | Ligar o modo `real` sem permissão, chave, remetente ou destinatário é recusado, nomeando o **campo** faltante e nunca o valor |
| RF-08-AC7 | Logs e eventos sem e-mail completo, corpo ou chave |
| RF-08-AC9 | Validação do e-mail e do remetente nos ajustes (não mais por alerta) |
| RF-09-AC5/6 | Sem servidor: substituídos pela validação de `sender` e payload das mensagens (security X1) |
| RF-12-AC1 | Payload de saúde exibido na aba "Saúde"; nenhum endpoint |
| RNF-REL-05, RNF-OPS-* | Operação = checklist manual da extensão (`operations.md`, E34) |

---

## 1. Escopo e restrições

**Extensão de navegador (Chrome/Edge, MV3)**, usuário único, para acompanhar o preço de tênis da Vans Brasil (`www.vans.com.br`), com notificação do navegador (e e-mail opcional) quando o preço chega ou se aproxima do preço-alvo. Veja a seção 0; o texto abaixo da seção 1 em diante descreve o servidor original e vale com as adaptações da seção 0.

Restrições de produto (vindas do enunciado e da investigação):

- Sem Redis, microserviços ou Kubernetes. Processo único, armazenamento embarcado local.
- Módulos: `catalog`, `price-monitor`, `price-history`, `alerts`, `notifications`, `scheduler`, `web`, `observability`.
- O coletor fica atrás de uma interface substituível. A comparação de preços é função pura, testável offline.
- Coleta só por HTTP simples. Fonte primária OCC `GET /arezzocoocc/v2/vans/products/{code}`; fallback 1 `__NEXT_DATA__` do HTML `/{slug}/p/{code}`; fallback 2 JSON-LD `Offer` (investigation.md, seção 1). Sem Playwright, sem evasão de antibot, sem login/checkout/busca (robots `Disallow`).
- Dados guardados: SKU, nome, preço, URL, disponibilidade. Não copiar imagens nem descrições (termos de uso proíbem reprodução; investigation.md 3.1).
- Falha de extração nunca vira R$ 0 e nunca gera alerta.
- Segredos só por variável de ambiente. Sem PII em logs. Modo de teste de e-mail que não envia.
- Entidades: `Product`, `ProductVariant`, `PriceObservation`, `PriceAlert`, `Notification`, `MonitoringRun`.

Fora do escopo do MVP: contas/login, multiusuário, app móvel, outros canais (Telegram/webhook), outras lojas, preço de carrinho/Pix/cupom (H8 não verificada).

## 2. Personas

| ID | Persona | Perfil | O que precisa |
|---|---|---|---|
| P-1 | Marina, compradora | Quer um tênis específico em promoção; não técnica; pt-BR | Achar o modelo, escolher cor/tamanho, dizer "avise quando chegar em R$ X", receber e-mail claro com link. Confiar que o aviso é verdadeiro. |
| P-2 | Felipe, dono/operador | Roda o app na própria máquina; técnico | Saber se o monitor está vivo e se os dados estão frescos; ser avisado de bloqueio da loja; não ser banido; testar sem mandar e-mail. |
| P-3 | Visitante público (futuro) | Usuário anônimo num deploy público | Fora do MVP. Existe aqui só para registrar os limites da seção 8 (deploy público). |

## 3. Jornadas

| ID | Jornada | Passos resumidos | RFs |
|---|---|---|---|
| J-1 | Descobrir e criar alerta | Abre catálogo, busca por nome, abre produto, escolhe tamanho, informa alvo/margem/e-mail, salva. Vê o preço atual e a faixa. | RF-01, 03, 04, 05, 09 |
| J-2 | Cadastrar por URL | Cola `https://www.vans.com.br/{slug}/p/{code}`, sistema valida, mostra produto e tamanhos, segue como J-1. | RF-02, 03 |
| J-3 | Receber alerta | Preço entra na faixa "próximo" ou "atingido"; e-mail com preço, alvo, tamanho, horário da leitura, fonte, link e aviso de defasagem. Não recebe repetidos. Se o preço sobe e volta a cair, recebe de novo. | RF-08, 10 |
| J-4 | Gerenciar | Edita alvo/margem/e-mail, pausa, retoma, exclui; vê histórico e dashboard. | RF-07, 09 |
| J-5 | Diagnosticar saúde | Dashboard mostra "defasado", "falha", "pausado por bloqueio"; `/saude` responde estado do scheduler e da última rodada. | RF-11, 12 |
| J-6 | Falha da loja | Loja bloqueia ou muda formato. Nenhum preço falso aparece, nenhum alerta sai, o dono é avisado uma vez. | RF-11 |

## 4. Glossário de dados (nível de requisito)

| Entidade | Papel | Chave natural | Campos relevantes aos requisitos |
|---|---|---|---|
| Product | Cor/modelo | `code` (ex. `1003800580026U`) | nome, `legacySKU`, último slug (decorativo), estado (`ativo`, `removido`, `formato_desconhecido`) |
| ProductVariant | Tamanho | `code-tamanho` (ex. `1003800580026U-34`) | produto, tamanho (de `displayText` ou sufixo do `code`), `ean` (pode ser null) |
| PriceObservation | Leitura válida de preço | variante + instante | preço original, preço atual efetivo, `disponivel`, `confirmada`, `degradada`, fonte (`occ`/`next_data`/`json_ld`), instante UTC, `run_id` |
| PriceAlert | Intenção do usuário | id | variante, alvo (centavos), margem (pontos-base), e-mail, estado, trava de disparo por tipo, `episodio`, `revisao`, `rearm_nao_antes_de` |
| Notification | Envio de e-mail | chave de idempotência | alert, tipo (`PROXIMO`/`ATINGIDO`/`SAUDE`), estado, tentativas, id do provedor, modo (`real`/`teste`) |
| MonitoringRun | Uma rodada de coleta | id | início/fim, itens (produto, resultado, status HTTP, fonte, duração), contadores, motivo de pulo |

Falhas de extração ficam como item de `MonitoringRun`, não como `PriceObservation`. Assim nenhum consumidor de preço enxerga um "preço de falha".

---

## 5. Regras de negócio de preço

### 5.1 Valores

- **RN-01 Moeda e representação.** Só BRL. Preço = inteiro em centavos. Conversão do campo `value` (float com ruído, ex. `99.99000000000001`, `49.989999999999995`): `centavos = round(value * 100)`. Se `abs(value*100 - centavos) > 1e-6` o valor não é decimal de 2 casas: falha `preco_invalido` (RN-04). Nunca parsear `formattedValue` (formatos inconsistentes: "R$ 279,99" vs "R$99,99").
- **RN-02 Preço original ("de")** = `price.value` convertido.
- **RN-03 Preço atual efetivo** = `discountPrice.value` convertido se `discountPrice.value > 0`; senão `price.value`. Sem desconto o SSR traz `discountPrice` com `value:0` e `currencyIso:""`; o OCC omite o campo; ambos significam "sem desconto". O percentual de desconto é calculado dos dois preços, nunca lido (`percentualOfDiscount` é `""` no SSR).
- **RN-04 Preço inválido.** Se o preço efetivo for ausente, não numérico, `<= 0`, tiver mais de 2 casas decimais reais, ou se `discountPrice > price`, a leitura é falha `preco_invalido`: não cria `PriceObservation`, não toca o histórico, não gera alerta. `discountPrice == price` é válido (efetivo = `price`).
- **RN-05 Preço por variante.** Quando a variante tem `priceData`/`discountPrice` próprios (`baseOptions[0].options[]` no OCC; `variantOptions[]` no SSR), vale o da variante; senão vale o do produto. Se `hasPriceVariations:true` aparecer, o histórico já é por variante e nada muda. Estrutura sem `baseOptions[0].options` ou sem variantes: estado `formato_desconhecido` (nunca assumir; investigation 10b.3).

### 5.2 Disponibilidade

- **RN-06 Variante disponível** = `sellable == true` **e** `stock.stockLevel > 0`. Ignorar `stockLevelStatus` (há `lowStock` com nível 0) e `purchasable` (inconsistente entre fontes). No JSON-LD (fallback 2) `availability` `InStock` equivale a disponível, pois reflete `sellable`; sem nível numérico a leitura é marcada `degradada`.
- **RN-07 Produto disponível** = OR das variantes. O alerta olha só a variante escolhida.
- **RN-08 Indisponível não é removido.** Produto totalmente sem estoque responde 200 com preço (Era True White: 149,99, `sellable:false`). Registra-se a observação com `disponivel=false`. "Removido" é outra coisa: 404 HTML ou 400 `UnknownIdentifierError` no OCC (RN-19).

### 5.3 Confirmação

- **RN-09 Observação confirmada.** Uma leitura válida é `confirmada=true` quando: (a) vem do OCC (primária), existe leitura confirmada anterior e a variação em relação a ela é `<= 70%` (aritmética inteira: `abs(novo - antigo) * 100 <= 70 * antigo`, base = valor confirmado anterior, vale para alta e para queda); ou (b) é a primeira leitura da variante, vem do OCC, é **coerente** (preço da variante igual ao do produto, ou `hasPriceVariations:true`) e o desconto sobre o preço original é `<= 70%` (maior desconto observado: 64%, Era Navy); ou (c) outra leitura válida e **posterior à pendente e à última confirmada**, com o mesmo valor em centavos, existe. Caso contrário (variação > 70%, primeira leitura incoerente ou com desconto > 70%, ou leitura de fallback sem par) fica `confirmada=false`, exibida como "não confirmada". Só observações confirmadas movem faixa, disparo ou rearme. Uma leitura pendente que ficou para trás de uma confirmada mais nova nunca é confirmada retroativamente. A releitura imediata (após a cortesia de 2-5 s) só vale para leituras do OCC, que não tem cache; leitura de fallback (cache SSR de até ~5 min) só é confirmada por leitura de rodada seguinte, pois releitura imediata do mesmo cache não é evidência independente.
- **RN-09a** Observação de fonte fallback é sempre `degradada=true`; mostra aviso no painel e no e-mail ("fonte degradada, até ~5 min de defasagem"), e o dono recebe aviso de "parser degradado" (RF-11).

### 5.4 Faixa de proximidade

Dado alvo `T` (centavos, inteiro), margem `M` em pontos-base `bp` (`M = bp/100 %`, padrão 3% = 300 bp, faixa permitida 0 a 50%) e preço atual efetivo `P` (centavos):

- **ATINGIDO**: `P <= T`.
- **PROXIMO**: `T < P` e `P * 10000 <= T * (10000 + bp)` (equivale a `T <= P <= T*(1+M)` fora do ponto `P == T`, já coberto por ATINGIDO). Aritmética inteira, sem float.
- **ACIMA**: `P * 10000 > T * (10000 + bp)`.
- Com `bp = 0` a faixa PROXIMO é vazia: só existe ATINGIDO.

Exemplos verificáveis com as fixtures (Hylane `1003800580026U`, P = 37999):

| T | M | limite (T*(1+M)) | Faixa | Observação |
|---|---|---|---|---|
| 380,00 | 3% | 391,40 | ATINGIDO | 37999 <= 38000 |
| 379,99 | 3% | 391,39 | ATINGIDO | igualdade conta |
| 379,98 | 3% | 391,38 | PROXIMO | 1 centavo acima do alvo |
| 370,00 | 3% | 381,10 | PROXIMO | |
| 350,00 | 3% | 360,50 | ACIMA | |
| 379,98 | 0% | 379,98 | ACIMA | margem zero, sem faixa próxima |

- **RN-10 Preço-alvo.** Decimal exato em BRL, aceita `,` ou `.` como separador, até 2 casas, `> 0` e `<= 99.999,99`. Mais de 2 casas é rejeitado (não arredonda silenciosamente). Alvo acima do preço atual é aceito, com aviso na tela ("já está abaixo do alvo; você receberá alerta na próxima leitura").

### 5.5 Disparo, deduplicação e rearmamento

- **RN-11 Gatilhos.** Há dois tipos: `PROXIMO` (entrada na faixa próxima vinda de ACIMA) e `ATINGIDO`. Cada tipo tem uma trava (`armado`). Um tipo dispara quando: observação `confirmada`, `disponivel`, não obsoleta (RN-17), alerta `ATIVO`, faixa correspondente e trava `armado`. Ao disparar, a trava do tipo fecha e uma `Notification` `PENDENTE` é criada na mesma transação.
  - O gatilho é por **trava**, não por transição de faixa: "vinda de ACIMA" é consequência de a trava ter sido reaberta (RN-13), não uma comparação com a faixa anterior.
  - ACIMA direto para ATINGIDO: dispara só `ATINGIDO` (um e-mail), e a trava de `PROXIMO` também fecha (não faz sentido avisar "próximo" depois de "atingido").
  - Faixa `PROXIMO` com `ATINGIDO` já disparado: nada novo.
  - Alerta recém-criado com preço já na faixa: dispara na primeira leitura confirmada (D-09), marcado "já estava na faixa ao cadastrar".
- **RN-12 Idempotência.** Chave única da notificação: `hash(alert_id, revisao, tipo, episodio)`. `episodio` só incrementa no rearme. Reprocessar a mesma leitura (rodada repetida, retry, reinício) nunca cria segunda notificação. Reenvio por falha reusa a mesma `Notification`, não cria outra.
- **RN-13 Rearmamento.** A trava de `ATINGIDO` reabre quando uma observação confirmada tem `P > T`. A de `PROXIMO` reabre quando uma confirmada tem `P > T*(1+M)`. Reabertura incrementa `episodio` e exige que a **própria observação com `P` acima do limite seja feita em ou depois de `rearm_nao_antes_de`** (24 h após o último envio do mesmo tipo; configurável, D-11): uma subida a `P > T` dentro das 24 h não é "lembrada"; se o preço desce de novo antes de existir leitura acima do limite depois das 24 h, nada é enviado (anti-flapping intencional). Quando `ATINGIDO` dispara direto e fecha também a trava de `PROXIMO` (sem envio de `PROXIMO`), `rearm_nao_antes_de` de `PROXIMO` passa a ser o instante do envio de `ATINGIDO` + 24 h. Indisponibilidade não rearma (restock ao mesmo preço baixo não duplica aviso); a volta ao estoque, porém, permite o disparo se a trava ainda estiver aberta e a faixa for a certa. Observação não confirmada, inválida ou falha de coleta nunca rearma.
- **RN-14 Edição.** Mudar alvo, margem ou variante incrementa `revisao`, reabre ambas as travas e reavalia na próxima observação confirmada. Mudar só o e-mail não reabre travas (não reenvia o que já foi enviado).
- **RN-15 Pausa/retomada.** `PAUSADO` não avalia nem envia; a coleta da variante continua se houver outro alerta ativo na mesma variante, senão para de ser coletada. Ao retomar, as travas ficam como estavam; se a condição for verdadeira e a trava estiver aberta, dispara na primeira leitura confirmada nova. Notificações `PENDENTE` de alerta pausado ficam retidas e são descartadas (estado `FALHA`, motivo `alerta_pausado`) se a pausa durar mais de 24 h, porque o preço pode ter mudado.
- **RN-16 Nunca alertar sem evidência.** Não dispara: observação `confirmada=false`; `disponivel=false`; falha de extração; produto `removido`/`formato_desconhecido`; dado obsoleto; coleta pausada por circuito.

### 5.6 Frescor ("stale") e falhas

- **RN-17 Frescor.** Idade = agora - instante da última observação confirmada da variante. Com intervalo de coleta `I` (padrão 4 h): `fresco` se idade `<= 2*I` (8 h); `defasado` (stale) se `> 2*I` e `<= 24 h`; `sem_dados` se `> 24 h` ou se nunca houve observação. Painel e `/saude` mostram o estado e o horário da última leitura. Alerta não dispara com base em dado `defasado` ou `sem_dados` (na prática só ocorre fora de rodada; uma rodada bem-sucedida cria dado novo).
- **RN-18 Falhas e circuito.** Classes de falha por item: `rede_timeout`, `http_5xx`, `http_429`, `http_403_ou_desafio`, `produto_removido` (404 HTML ou 400 OCC), `formato_desconhecido`, `preco_invalido`, `host_nao_autorizado`. Regras:
  - Respeitar `Retry-After`; backoff exponencial entre tentativas no mesmo item (no máximo 2 retentativas por rodada).
  - 3 falhas consecutivas do mesmo produto (não removido): estado `com_falha`, 1 notificação `SAUDE` ao dono por episódio; sai do estado na próxima leitura válida.
  - Precedência de classificação: cabeçalho `cf-mitigated` ou corpo de desafio vence o código de status (um `503` com desafio é `http_403_ou_desafio`, não `http_5xx`; nunca cai para fallback nem é retentado).
  - 3 produtos seguidos na mesma rodada com `formato_desconhecido`/`preco_invalido` (conteúdo, não bloqueio): a rodada termina como `partial` sem abrir circuito, com 1 evento de saúde `formato_desconhecido` global por episódio (evita dezenas de requisições inúteis se o OCC mudar de formato).
  - `403` com desafio/Cloudflare, ou `429` persistente (2 seguidos), ou 3 falhas **de transporte** (`rede_timeout`, `http_5xx`, `http_429`, `http_403_ou_desafio`, `host_nao_autorizado`) seguidas de qualquer produto na mesma rodada: circuito global aberto; toda coleta pausa por 24 h; 1 notificação `SAUDE`; nunca contornar. Retomada automática depois de 24 h com 1 requisição de teste; se falhar de novo, mais 24 h.
  - Queda de fonte primária com fallback funcionando: observação `degradada` e aviso de "parser degradado" (1 por episódio).
- **RN-19 Produto removido.** 404 HTML ou 400 `UnknownIdentifierError` confirmados em 2 rodadas seguidas: estado `removido`, coleta para, alertas ficam visíveis como "produto removido" e o dono é avisado uma vez. Retomada manual pela ação "retomar coleta" do produto (RF-09-AC10), que também vale para `formato_desconhecido` (sem ela o produto ficaria parado para sempre).

### 5.7 Identidade

- **RN-20** Produto = `code`; variante = `code-tamanho`; slug e canonical não participam da identidade (slug errado com SKU certo retorna 200). URL de variante (`.../p/{code}-40`) retorna 404 e não é aceita como entrada.
- **RN-21 Dados mínimos** (ver Constraints): sem imagens, sem descrições, sem cookies/sessão nas gravações de corpo bruto.

---

## 6. Máquinas de estado

### 6.1 Alerta

Estados persistentes: `ATIVO`, `PAUSADO`. `EXCLUIDO` é remoção física (D-14), não um estado.

| De | Evento | Para | Efeito |
|---|---|---|---|
| (novo) | criar com dados válidos | `ATIVO` | travas abertas, `episodio=1`, `revisao=1` |
| `ATIVO` | pausar | `PAUSADO` | para avaliação |
| `PAUSADO` | retomar | `ATIVO` | RN-15 |
| `ATIVO`/`PAUSADO` | editar alvo/margem/variante | mesmo | `revisao++`, travas abertas (RN-14) |
| `ATIVO`/`PAUSADO` | excluir | (removido) | remove alerta e suas notificações |
| `ATIVO` | produto `removido` | `ATIVO` (exibido como "produto removido") | sem avaliação (RN-19) |

Sub-estado derivado (não persistido, calculado da última observação confirmada): `faixa` ∈ {`ACIMA`, `PROXIMO`, `ATINGIDO`, `SEM_DADOS`} mais o selo de disponibilidade e frescor. Travas persistidas: `armado_proximo`, `armado_atingido`.

Transições de disparo e rearme (alerta `ATIVO`, observação confirmada):

| Faixa anterior → nova | Disponível? | Trava | Ação |
|---|---|---|---|
| ACIMA/SEM_DADOS → PROXIMO | sim | `armado_proximo` aberta | criar `Notification(PROXIMO)`, fechar `armado_proximo` |
| ACIMA/PROXIMO/SEM_DADOS → ATINGIDO | sim | `armado_atingido` aberta | criar `Notification(ATINGIDO)`, fechar `armado_atingido` e `armado_proximo` |
| qualquer → PROXIMO/ATINGIDO | não | n/a | só registrar; nada dispara |
| ATINGIDO → PROXIMO ou ACIMA | n/a | `P > T` | reabrir `armado_atingido` (respeitando `rearm_nao_antes_de`), `episodio++` |
| PROXIMO/ATINGIDO → ACIMA | n/a | `P > T*(1+M)` | reabrir `armado_proximo` (idem) |
| indisponível → disponível (faixa mantida) | sim | trava aberta | dispara (RN-13) |

### 6.2 Notificação

Estados do enunciado: `PENDENTE`, `ACEITO` (aceito pelo provedor), `FALHA`. **Aceite não é entrega**: `ACEITO` significa só que o provedor devolveu sucesso de aceitação; a UI diz "aceito pelo provedor", nunca "entregue". Bounce/spam não são observáveis no MVP.

| De | Evento | Para | Notas |
|---|---|---|---|
| (nova) | disparo do alerta | `PENDENTE` | criada na mesma transação que fecha a trava |
| `PENDENTE` | provedor aceita | `ACEITO` | grava id do provedor e instante |
| `PENDENTE` | erro temporário (rede, 4xx/5xx temporário) | `PENDENTE` | `tentativas` conta envios iniciados; `proxima_tentativa` com backoff 5 min, 30 min, 2 h (tentativa inicial + 3 retentativas = no máximo 4 envios) |
| `PENDENTE` | 4ª tentativa falha, ou erro permanente (e-mail inválido, credencial) | `FALHA` | motivo registrado; dono vê no painel; trava do alerta continua fechada (não reenvia sozinho) |
| `PENDENTE` | alerta excluído | (removida) | |
| `FALHA` | ação manual "reenviar" | `PENDENTE` | mesma `Notification`, mesma chave |

Modo de teste (RNF-SEC-05): em vez de chamar o provedor, a notificação vai `PENDENTE` para `ACEITO` com `modo=teste` e `simulado=true`; o corpo renderizado é gravado em log local sem PII (só tipo, alert_id, preço). A UI mostra "simulado (não enviado)".

Janela de duplicata residual: se o processo cair depois do provedor aceitar e antes de gravar `ACEITO`, o reinício reenvia (entrega pelo menos uma vez). Aceito no MVP e documentado (R-09).

---

## 7. Requisitos funcionais

Cada critério é `Dado/Quando/Então` e verificável por teste automatizado offline (fixtures) salvo onde marcado "manual".

### RF-01 Descoberta de catálogo (M)

Navegar/buscar tênis Vans BR sem digitar URL.

Notas de evidência: `/c/*` não serve (produtos carregados no cliente). Fonte: OCC `GET /products/search?category=SAPATOS&currentPage=N&pageSize=...` (1239 itens, 0-based), nunca `query=:...`, facetas `q=` ou `/search*` (robots). `category=TENIS` não testado (H6). Sitemap de produto (2454 URLs) é opcional e não é contagem de catálogo (investigation 10b.1).

- **RF-01-AC1** Dado um catálogo local populado a partir de `api-products-search-query-era.json`/`search.sapatos.page0.sample.json`, quando o usuário busca "era", então a lista mostra só itens cujo nome contém "era" (busca local, sem chamar `/search`).
- **RF-01-AC2** Dado catálogo vazio, quando o usuário abre a tela, então vê "catálogo ainda não carregado" e a opção "atualizar catálogo" (não chama a loja sozinho no carregamento da página).
- **RF-01-AC3** Dado "atualizar catálogo", quando executa, então faz requisições sequenciais com intervalo de 2-5 s, no máximo 1 atualização por 24 h (a segunda é recusada com a data da próxima permitida) e só usa `category=SAPATOS`.
- **RF-01-AC4** Dado uma resposta de listagem com item sem `code` ou sem preço, quando importar, então o item é ignorado e contado em "ignorados", sem abortar a página.
- **RF-01-AC5** Dado resposta 429 ou 403 com desafio, quando atualizar, então para a atualização, abre o circuito (RN-18) e mantém o catálogo anterior intacto.
- **RF-01-AC6** Dado item do catálogo, quando o usuário o abre, então o sistema usa o `code` para consultar a página do produto (RF-03), nunca o slug.

### RF-02 Cadastro por URL (M)

- **RF-02-AC1** Dado a URL `https://www.vans.com.br/tenis-hylane-2-tone-khaki-green/p/1003800580026U`, quando enviada, então extrai `code=1003800580026U` e abre o produto.
- **RF-02-AC2** Dado `https://www.vans.com.br/p/1003800580026U` (sem slug, que a loja redireciona com 301), quando enviada, então extrai o mesmo `code` sem seguir o redirect da loja (a consulta é montada a partir do `code`).
- **RF-02-AC3** Dado slug errado com `code` certo, quando enviada, então vale o `code`; o slug não é usado para identidade.
- **RF-02-AC4** Dado URL `http://...`, host diferente de `www.vans.com.br` (ex. `vans.com.br.evil.test`, `www.vans.com.br@evil.test`, `www.vans.com.br:8443`, IP literal), caminho sem `/p/{code}`, ou URL com credenciais embutidas, quando enviada, então é rejeitada com mensagem em pt-BR e nenhuma requisição de rede é feita.
- **RF-02-AC5** Dado URL de variante (`.../p/1003800580026U-40`) ou `code` inexistente (a loja devolve 404 HTML / 400 `UnknownIdentifierError`), quando enviada, então é rejeitada como "produto não encontrado" e nada é salvo.
- **RF-02-AC6** Dado uma URL válida cujo OCC responde 200, quando cadastrada, então `Product` e todas as `ProductVariant` são gravados (13 no Hylane, tamanhos 33-45; 13 a 15 conforme o produto) e a tela segue para escolha de tamanho.
- **RF-02-AC7** Dado URL com `fbclid`/UTM na query, quando enviada, então parâmetros de query são descartados e não são armazenados nem logados.
- **RF-02-AC8** Dado produto já lido há menos de 2 h, quando a URL é cadastrada, então usa o banco sem nova requisição; dado produto novo, então faz 1 requisição pelo `RateGate` (espaçada das demais) e só se o orçamento de 24 h permitir, senão recusa com mensagem.

### RF-03 Identidade e variante (M)

- **RF-03-AC1** Dado a fixture `occ_disc_1003800580026U.json`, quando parseada, então produz `Product.code=1003800580026U` e 13 variantes `1003800580026U-33...-45` com tamanho, `legacySKU=V1003800580026`, `ean` quando existir (null aceito).
- **RF-03-AC2** Dado SSR (`variantOptions[].url=""`, `variantOptionQualifiers=[]`), quando parseado, então o tamanho vem de `displayText` ou do sufixo do `code`, nunca de `url`.
- **RF-03-AC3** Dado o Hylane, quando exibido, então tamanhos 33-36 aparecem como disponíveis (5/11/14/4 un.) e 37-45 como indisponíveis; a tela não mostra estoque numérico como promessa (D-18).
- **RF-03-AC4** Dado um alerta, quando criado, então exige uma variante existente; sem tamanho escolhido o cadastro é recusado (D-05).
- **RF-03-AC5** Dado produto cuja estrutura não tem `baseOptions[0].options` (acessório), quando parseado, então o estado é `formato_desconhecido`, não se cria alerta e a tela explica que o produto ainda não é suportado.
- **RF-03-AC6** Dado "cor irmã" (`colorOptions`), quando o usuário a quer, então é outro `code` e outro cadastro (cores não se misturam).

### RF-04 Preço-alvo (M)

- **RF-04-AC1** Dado entrada `379,99` ou `379.99`, quando salva, então `T = 37999`.
- **RF-04-AC2** Dado `379,999`, `0`, `-5`, `abc`, vazio ou `100000`, quando salva, então é recusado com mensagem específica e nada é gravado.
- **RF-04-AC3** Dado `1.234,50` (milhar com ponto, decimal com vírgula), quando salva, então `T = 123450` (D-07).
- **RF-04-AC4** Dado alvo acima do preço atual, quando salva, então é aceito com aviso (RN-10).
- **RF-04-AC5** Dado valores com ruído de float do OCC (`99.99000000000001`), quando comparados com `T = 9999`, então a comparação usa centavos e dá ATINGIDO (RN-01).

### RF-05 Faixa de proximidade (M)

- **RF-05-AC1** Dado `M` não informada, quando o alerta é criado, então `M = 3%` (300 bp).
- **RF-05-AC2** Dado `M` fora de 0-50% ou com mais de 2 casas, quando salva, então é recusada.
- **RF-05-AC3** Dado a tabela da seção 5.4, quando a função de faixa roda com cada linha, então devolve a faixa indicada (teste de tabela, sem rede).
- **RF-05-AC4** Dado `P = T` exatamente, então ATINGIDO; dado `P = T*(1+M)` exatamente (ex. T = 100,00, M = 3%, P = 103,00), então PROXIMO; dado `P = 103,01`, então ACIMA.
- **RF-05-AC5** Dado `M = 0%`, quando `P = T + 1 centavo`, então ACIMA (sem faixa próxima).
- **RF-05-AC6** Dado valores extremos (T = 1, T = 9.999.999 centavos, M = 50%), quando comparados, então não há overflow nem desvio por float (aritmética inteira de 64 bits ou BigInt).

### RF-06 Monitoramento automático (M)

- **RF-06-AC1** Dado alertas `ATIVO` em N produtos distintos, quando o scheduler dispara, então faz normalmente 1 requisição por `code` (não por variante; retentativa, fallback e releitura de confirmação são os únicos extras e entram no orçamento), 1 de cada vez, com 2-5 s de intervalo mais jitter e User-Agent identificável.
- **RF-06-AC2** Dado intervalo padrão 4 h, quando configurado fora de 2-6 h, então o sistema recusa a configuração (D-12).
- **RF-06-AC3** Dado 50 produtos distintos com alerta `ATIVO`, quando um alerta que tornaria o 51º produto distinto é criado **ou retomado**, então é recusado com explicação do limite de carga (investigation 3.6; orçamento em RNF-REL-04).
- **RF-06-AC4** Dado que a rodada anterior ainda executa, quando o gatilho seguinte chega, então a nova rodada é pulada e registrada como `pulada: anterior_em_andamento`.
- **RF-06-AC5** Dado o app ligado depois de ficar fechado mais que o intervalo, quando inicia, então faz no máximo 1 rodada de recuperação e não várias seguidas (D-13).
- **RF-06-AC6** Dado coletor falso (interface substituída) que devolve fixtures, quando a rodada executa, então grava `MonitoringRun` e observações sem nenhuma chamada de rede.
- **RF-06-AC7** Dado que não há alerta `ATIVO` para o produto, quando a rodada executa, então ele não é coletado.
- **RF-06-AC8** Dado as fixtures OCC e SSR do mesmo produto, quando parseadas, então os preços em centavos coincidem (teste de contrato). Em produção o fallback só é consultado quando o OCC falha, então não há divergência observável por rodada; a concordância é vigiada pelos testes de contrato e pelo teste live.

### RF-07 Histórico de preços (M)

- **RF-07-AC1** Dado observações de uma variante, quando o usuário abre o histórico, então vê a série (instante, preço original, preço efetivo, disponível, fonte, confirmada) em ordem decrescente de tempo, com horário em America/Sao_Paulo (armazenado em UTC).
- **RF-07-AC2** Dado preço original e efetivo, quando exibidos, então o desconto % é calculado (Hylane: 41%, `(649,99-379,99)/649,99`) e não lido de `percentualOfDiscount`.
- **RF-07-AC3** Dado falha de coleta, quando a rodada termina, então o histórico de preço não ganha ponto algum; a falha aparece no log da rodada.
- **RF-07-AC4** Dado observação `confirmada=false`, quando listada, então vem marcada "não confirmada" e é excluída de mínimo/máximo/gráfico principal.
- **RF-07-AC5** Dado o histórico, quando calculado mínimo e máximo, então só consideram observações confirmadas.
- **RF-07-AC6** Dado que nada mudou entre duas rodadas, então ainda assim há uma observação por rodada (prova de frescor); a compactação é melhoria (S).

### RF-08 Alerta por e-mail (M)

- **RF-08-AC1** Dado disparo `ATINGIDO`, quando o e-mail é montado, então contém nome do produto, tamanho, preço atual, preço-alvo, horário da leitura (America/Sao_Paulo) com fonte, link `https://www.vans.com.br/{slug}/p/{code}` (slug só decorativo; se ausente, `/p/{code}`), e aviso "o preço pode ter mudado desde a leitura".
- **RF-08-AC2** Dado disparo `PROXIMO`, então o assunto e o texto dizem "próximo do alvo" e mostram a margem usada.
- **RF-08-AC3** Dado observação `degradada`, quando o e-mail é montado, então inclui o aviso de fonte degradada.
- **RF-08-AC4** Dado `EMAIL_MODE=test` (padrão, D-16), quando uma notificação é processada, então nenhuma conexão de saída é aberta, a notificação vai a `ACEITO` com `simulado=true` e o painel mostra "simulado".
- **RF-08-AC5** Dado `EMAIL_MODE=real` sem credenciais completas no ambiente, quando o app inicia, então falha rápido com mensagem que nomeia a variável ausente, sem imprimir valores.
- **RF-08-AC6** Dado erro temporário do provedor, quando a notificação é processada, então segue a tabela 6.2 (tentativa inicial + 3 retentativas, backoff 5 min / 30 min / 2 h) e termina em `FALHA` com motivo.
- **RF-08-AC7** Dado qualquer log gerado no envio, então não contém e-mail completo, corpo do e-mail nem credencial; o e-mail aparece mascarado (`m***@g***.com`) quando necessário.
- **RF-08-AC8** Dado `ACEITO`, quando mostrado ao usuário, então o texto diz "aceito pelo provedor", nunca "entregue".
- **RF-08-AC9** Dado e-mail em formato inválido, quando o alerta é salvo, então é recusado (validação de sintaxe; não confirma propriedade, ver seção 8).

### RF-09 Gestão e dashboard (M)

- **RF-09-AC1** Dado alertas existentes, quando o usuário abre o dashboard, então vê por alerta: produto, tamanho, alvo, margem, preço atual, faixa, disponibilidade, estado (`ATIVO`/`PAUSADO`/`removido`/`com falha`), frescor e última leitura.
- **RF-09-AC2** Dado alerta, quando o usuário edita alvo/margem/e-mail com valores válidos, então salva e aplica RN-14.
- **RF-09-AC3** Dado alerta `ATIVO`, quando pausa, então vira `PAUSADO` e nenhuma notificação nova é criada; quando retoma, então RN-15.
- **RF-09-AC4** Dado alerta, quando exclui, então há confirmação explícita; depois disso alerta e notificações dele somem (D-14) e o histórico de preços permanece.
- **RF-09-AC5** Dado ações que mudam estado (criar, editar, pausar, retomar, excluir), quando enviadas, então exigem método `POST`/`PUT`/`DELETE` com proteção CSRF (token ou verificação de `Origin`) mesmo no uso local (RNF-SEC-04).
- **RF-09-AC6** Dado servidor escutando, então só aceita conexões de `127.0.0.1` por padrão (RNF-SEC-03).
- **RF-09-AC7** Dado ação repetida (duplo clique ao criar), quando processada, então não cria alerta duplicado para a mesma variante, alvo, margem e e-mail (restrição única permanente; a tela diz "alerta idêntico já existe").
- **RF-09-AC10** Dado produto `removido` ou `formato_desconhecido` com alerta, quando o usuário aciona "retomar coleta" (`POST`, CSRF), então o estado volta a `ativo`, os contadores de falha zeram e a próxima rodada o coleta.
- **RF-09-AC8** Dado interface, então todos os campos têm rótulo, erro textual associado e funcionam por teclado (RNF-ACC-01).

### RF-10 Deduplicação e rearmamento (M)

- **RF-10-AC1** Dado alerta com trava `ATINGIDO` aberta e observação confirmada disponível com `P <= T`, quando a avaliação roda 2 vezes sobre a mesma observação, então existe exatamente 1 `Notification`.
- **RF-10-AC2** Dado duas rodadas seguidas com `P <= T`, então só a primeira notifica (trava fechada).
- **RF-10-AC3** Dado ATINGIDO notificado, depois `P > T` confirmado e passadas 24 h, depois `P <= T` confirmado, então há uma 2ª notificação com `episodio=2`.
- **RF-10-AC4** Dado `P` voltando acima de `T` mas antes de 24 h do envio, quando cair de novo, então não notifica; notifica só depois de `rearm_nao_antes_de` (anti-flapping, RN-13).
- **RF-10-AC5** Dado ACIMA para ATINGIDO direto, então 1 e-mail `ATINGIDO` e nenhum `PROXIMO`.
- **RF-10-AC6** Dado `PROXIMO` notificado e depois `ATINGIDO`, então são 2 notificações distintas.
- **RF-10-AC7** Dado alvo editado (`revisao++`), então travas reabrem e uma nova leitura na faixa dispara de novo.
- **RF-10-AC8** Dado variante indisponível com preço na faixa, quando permanece indisponível, então nada dispara e nada rearma; quando volta a `disponivel` com trava aberta, então dispara (RN-13).
- **RF-10-AC9** Dado dois alertas na mesma variante (e-mails ou alvos diferentes), então cada um tem seu estado e notificações independentes; a coleta é uma só.
- **RF-10-AC10** Dado a mesma chave de idempotência inserida duas vezes (concorrência), então a restrição de unicidade impede a segunda.

### RF-11 Tratamento de falhas sem falso preço ou alerta (M)

- **RF-11-AC1** Dado resposta 403, 429, 5xx, timeout ou corpo não JSON, quando coletada, então não cria `PriceObservation`, o último preço confirmado permanece como está e nenhum alerta dispara.
- **RF-11-AC2** Dado preço ausente, 0, negativo, `NaN`, texto ou `discountPrice > price`, então falha `preco_invalido`; o sistema nunca grava R$ 0,00 (RN-04).
- **RF-11-AC3** Dado variação > 70% entre leituras consecutivas, quando a primeira chega, então fica `confirmada=false` e não dispara; quando a 2ª concorda, então confirma e pode disparar.
- **RF-11-AC4** Dado OCC falhando e `__NEXT_DATA__` OK (use `nextdata_1003800580026U.json`), então observação `degradada`, aviso de parser degradado 1x por episódio, e disparo só se confirmada por 2ª leitura concordante (RN-09).
- **RF-11-AC5** Dado `occ_404.json` (400 `UnknownIdentifierError`) ou `product_404.html`, então classe `produto_removido` e, após 2 rodadas, estado `removido`; nunca "sem estoque" nem preço 0.
- **RF-11-AC6** Dado produto sem estoque total (`product_disc_oos_1002000690063U.html`, 200 com preço 149,99), então observação `disponivel=false` com preço correto, sem alerta, sem classificar como removido.
- **RF-11-AC7** Dado 3 falhas consecutivas de um produto, então estado `com_falha` e 1 notificação `SAUDE` ao dono por episódio.
- **RF-11-AC8** Dado `403` com desafio ou 2 `429` seguidos, então circuito global aberto por 24 h, sem retentativas agressivas, sem alteração de User-Agent para evasão, 1 aviso ao dono.
- **RF-11-AC9** Dado redirect para host fora da lista, ou para `http://`, ou mais de 3 redirects, então a coleta falha como `host_nao_autorizado` sem seguir (RNF-SEC-01).
- **RF-11-AC10** Dado corpo acima de 2 MB ou `Content-Type` inesperado, então é descartado como falha (RNF-SEC-02).
- **RF-11-AC11** Dado falha, quando o corpo bruto é salvo para diagnóstico, então é sem cookies/headers de sessão, limitado a 1 por produto, e sem aparecer em logs.
- **RF-11-AC12** Dado `503` (ou 200) com `cf-mitigated: challenge` ou corpo de desafio, quando coletado, então a classe é `http_403_ou_desafio`: 0 retentativas, sem fallback, circuito aberto (RN-18).
- **RF-11-AC13** Dado 3 produtos seguidos com `formato_desconhecido` na mesma rodada, então a rodada termina `partial`, 1 evento de saúde global, sem circuito e sem mais requisições naquela rodada.
- **RF-11-AC14** Dado resposta do OCC cujo `code` difere do solicitado, ou variante cujo `code` não começa com `{code}-`, ou `stock`/`stockLevel` ausente (variante tratada como indisponível, sem erro), então: `code` divergente = `formato_desconhecido`; `stockLevel` ausente = `available=false`.
- **RF-11-AC15** Dado primeira leitura de variante incoerente (preço da variante diferente do produto sem `hasPriceVariations`) ou com desconto > 70%, então `confirmada=false` e nenhum alerta dispara até a 2ª leitura concordante (RN-09).

### RF-12 Saúde e frescor (M)

- **RF-12-AC1** Dado o app ligado, quando `GET /saude`, então responde JSON com: status do scheduler (`ok`/`atrasado`/`pausado_circuito`), início/fim e resultado da última rodada, contagem de alertas por frescor, estado do circuito, modo de e-mail (`real`/`teste`) e versão. Sem PII.
- **RF-12-AC2** Dado haver alerta `ATIVO` e a última rodada **não pulada** (`skipped`) concluída há mais de `2*I` (ou nunca, com o app no ar há mais de `2*I`), então scheduler `atrasado` e banner no dashboard; sem alertas ativos o status é `ok`; circuito aberto tem precedência (`pausado_circuito`).
- **RF-12-AC3** Dado variante cuja última observação confirmada tem idade > 8 h (e `<= 24 h`), então "defasado"; > 24 h ou nunca, "sem dados" (RN-17); testado com relógio falso.
- **RF-12-AC4** Dado circuito aberto, então o dashboard mostra o motivo e quando a coleta volta.
- **RF-12-AC5** Dado `/saude`, então responde em menos de 200 ms com a base local e não faz requisições à loja.
- **RF-12-AC6** Dado que o app esteve fechado, quando abre, então o dashboard deixa claro "monitoramento só roda com o app aberto" (limite do MVP, D-13).

---

## 8. Requisitos não funcionais

### Segurança

- **RNF-SEC-01 Anti-SSRF.** Toda requisição de saída exige `https`, host em lista exata de autorização, porta 443, sem credenciais na URL, sem IP literal. Lista no MVP: apenas `www.vans.com.br` (produto, OCC, listagem); `secure-static.vans.com.br` só entra com ADR quando o sitemap (S) for implementado. A URL colada pelo usuário nunca é buscada: só se extrai o `code`, e a URL de consulta é montada pelo sistema. Redirects: o OCC e a listagem não seguem nenhum (qualquer 3xx é falha `formato_desconhecido`); a página de produto segue no máximo 3, cada salto revalidado (esquema, host **igual ao da requisição original**, porta, caminho `/{slug}/p/{mesmo code}`); resolução DNS recusa loopback, privado, link-local e metadados de nuvem antes de conectar.
- **RNF-SEC-02 Limites de resposta.** Timeout total 15 s (conexão 5 s), corpo máximo 2 MB (OCC observado: 75-171 KB), tipo esperado `application/json` ou `text/html`.
- **RNF-SEC-03 Exposição local.** Escuta em `127.0.0.1` por padrão; escutar em outro endereço exige variável explícita e emite aviso na inicialização.
- **RNF-SEC-04 Requisições de mudança.** Proteção CSRF e verificação de `Origin`/`Host` nas ações que mudam estado (ataque a localhost por página maliciosa); escape de saída em todo conteúdo vindo da loja ou do usuário (XSS); consultas parametrizadas (SQL injection).
- **RNF-SEC-05 Segredos e modo de teste.** Credenciais do provedor de e-mail e `OWNER_EMAIL` só por variáveis de ambiente (`.env` local fora do versionamento, com `.env.example` sem valores reais). `EMAIL_MODE` padrão `test`. Nenhum segredo em log, em mensagem de erro, em `/saude` ou em fixture.
- **RNF-SEC-06 Cabeçalhos web.** `Content-Security-Policy` restritiva, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`.

### Privacidade

- **RNF-PRIV-01 Sem PII em logs.** E-mail do usuário, corpo de e-mail, destinatário e IP de cliente não entram em logs; usar `alert_id` e e-mail mascarado.
- **RNF-PRIV-02 Minimização.** Só e-mail e dados de preço de produto. Corpos brutos de falha sem cookies, UTMs ou `fbclid` (a fixture `product_disc_instock_1003800580026U.html` os contém no JSON-LD; sanitizar antes de versionar, investigation C10).
- **RNF-PRIV-03 Exclusão.** Excluir alerta remove e-mail e notificações associadas (D-14).

### Confiabilidade

- **RNF-REL-01 Sem falso positivo.** Invariante: nenhuma notificação de preço existe sem uma observação confirmada, disponível, válida e com a faixa correspondente (verificado por teste de propriedade, seção de traceability).
- **RNF-REL-02 Atomicidade.** Observação, avaliação do alerta, fecho de trava e criação de `Notification` na mesma transação; retomada segura após queda.
- **RNF-REL-03 Concorrência.** 1 requisição à loja por vez **em todo o processo** (rodada, cadastro por URL, atualização de catálogo e sonda passam pelo mesmo `RateGate` que serializa e espaça); uma rodada por vez (trava de rodada).
- **RNF-REL-04 Cortesia.** 2-5 s entre requisições mais jitter, UA identificável, intervalo mínimo de 2 h por produto, teto de **400 requisições por 24 h de qualquer origem** (50 produtos x 6 rodadas = 300 de base, mais atualização de catálogo e folga para retentativas/releitura; um teto de 300 estourava na base com 50 produtos), sitemap no máximo 1x/dia, catálogo no máximo 1x/24 h (D-04). Cadastro por URL de produto lido há menos de 2 h usa o banco, sem nova requisição.
- **RNF-REL-05 Backup/restauração.** O banco local é arquivo único; documentar cópia a frio (melhoria S).

### Desempenho

- **RNF-PERF-01** Rodada de 50 produtos conclui em até 10 min (limitada pela cortesia, não por CPU).
- **RNF-PERF-02** Dashboard com 50 alertas e 10 mil observações renderiza em menos de 1 s localmente.
- **RNF-PERF-03** Comparação de preço e faixa: função pura, microssegundos, sem I/O.

### Observabilidade

- **RNF-OBS-01** Logs estruturados em JSON com nível, módulo, `run_id`, `alert_id`/`product_code`, classe de falha, status HTTP, duração, fonte. Sem corpos, sem PII.
- **RNF-OBS-02** Contadores expostos em `/saude`: rodadas, itens ok/falha por classe, notificações por estado, observações por fonte, idade da última observação.
- **RNF-OBS-03** Eventos de saúde (circuito aberto, parser degradado, `com_falha`, produto removido) são registrados uma vez por episódio.

### Testabilidade e manutenção

- **RNF-TEST-01** Toda lógica de preço, faixa, confirmação, disparo/rearme e máquina de notificação roda offline com relógio injetável e coletor falso.
- **RNF-TEST-02** Testes de contrato do coletor/parser contra `tests/fixtures/vans/` (sem rede). Teste de "rede bloqueada" garante que a suíte não alcança a internet.
- **RNF-TEST-03** Cobertura mínima de 80% de linhas e ramos nos módulos `price-monitor`, `alerts`, `notifications`; 100% de ramos da função de faixa e da conversão de preço.
- **RNF-TEST-04** Captura de fixtures faltantes (OCC de Era Navy e Knu Skool dynamic) antes de testes de contrato finais (investigation 10b.2).
- **RNF-MNT-01 Coletor substituível.** Interface única de coleta com implementações `OccCollector`, `NextDataCollector`, `FakeCollector` (e `JsonLdCollector`, S, fora do MVP); trocar não toca regra de negócio.
- **RNF-MNT-02 Camada de dados isolada** (risco de `node:sqlite` experimental, investigation 7): módulo de repositório, nenhum SQL fora dele.
- **RNF-MNT-03 Configuração** por ambiente, validada na partida (falha rápida e legível).

### Usabilidade, acessibilidade, i18n

- **RNF-ACC-01** WCAG 2.1 AA no essencial: rótulos, foco visível, contraste, navegação por teclado, erros textuais.
- **RNF-I18N-01** Interface em pt-BR; moeda `R$ 1.234,56`; datas em America/Sao_Paulo; armazenamento em UTC.
- **RNF-UX-01** Mensagens de erro dizem o que fazer; estados vazios explicam o próximo passo.

### Conformidade

- **RNF-LEG-01** Respeitar `robots.txt` (não coletar `/search*`, `?q=:`, `/cart`, `/checkout`, `/login`, `/my-account`, `/wish-list`). Uso pessoal, dados mínimos, sem redistribuição. Termos integrais e permissão de uso do `/arezzocoocc` não foram analisados juridicamente (R-02).
- **RNF-LEG-02** Parar ao encontrar bloqueio e nunca contornar (sem rotação de IP/UA, sem Playwright anti-detecção).

### Limites para deploy público (documentar, não implementar)

Aplicar antes de qualquer exposição fora de `127.0.0.1`:

1. Autenticação e autorização por usuário; isolamento de dados por usuário.
2. Verificação de propriedade do e-mail (dupla confirmação) e link de descadastro, para evitar uso como relé de spam e atender LGPD; política de privacidade e retenção.
3. Limite de taxa por usuário/IP e por rota; proteção anti-bot nos formulários; limite de alertas por usuário.
4. Agregação de coleta por `code` entre usuários (já é o modelo: coleta por produto), com teto global de requisições à loja; avaliação jurídica do volume.
5. HTTPS obrigatório, cookies `Secure`/`HttpOnly`/`SameSite`, CSRF por sessão.
6. Segredos em cofre, não em `.env`; rotação.
7. Fila durável e execução fora do processo web; monitoramento externo do scheduler (hoje só roda com o app aberto).
8. Reputação de e-mail (SPF/DKIM/DMARC), tratamento de bounce/complaint; só então "entregue" passa a ser observável.
9. Backups e migração de banco embarcado para servidor.

---

## 9. Ambiguidades resolvidas e decisões padrão

| ID | Ambiguidade | Decisão padrão | Onde |
|---|---|---|---|
| D-01 | Preço atual: usar `discountPrice` quando? | `discountPrice > 0` senão `price`. `discountPrice > price` é inválido. | RN-03, RN-04 |
| D-02 | Preço "pago" vs vitrine (H8) | Só preço de vitrine. A UI e o e-mail avisam que Pix/cupom/carrinho podem diferir. | RF-08, risco R-05 |
| D-03 | Fonte primária OCC ou `__NEXT_DATA__` (C1) | OCC primária, SSR e JSON-LD fallback `degradada`. | RN-09 |
| D-04 | Frequência | 4 h por produto (2-6 h configurável), 1 requisição por `code`, 2-5 s de cortesia, teto 50 produtos / 400 req/24 h (a investigação sugeria ~300 só para a base; ver RNF-REL-04). Política, não medida (Q6/H5). | RF-06, RNF-REL-04 |
| D-05 | Alerta de produto inteiro ou de tamanho? | Por variante (tamanho obrigatório). "Qualquer tamanho" é melhoria. | RF-03-AC4 |
| D-06 | "Atingido" `P <= T` e "próximo" `T <= P <= T*(1+M)` se sobrepõem em `P = T` | `P = T` é ATINGIDO; PROXIMO é `T < P <= T*(1+M)`. | 5.4 |
| D-07 | Formato do alvo | Aceita `.` ou `,` decimal; milhar `.` só se acompanhado de decimal `,`; máx. 2 casas; sem arredondar. | RN-10 |
| D-08 | Margem | Pontos-base inteiros, 0-50%, padrão 3%. Aritmética inteira. | 5.4 |
| D-09 | Preço já na faixa ao criar alerta | Notifica na primeira leitura confirmada, marcado "já estava na faixa ao cadastrar". | RN-11 |
| D-10 | Dois tipos de aviso ou um? | Dois (`PROXIMO`, `ATINGIDO`), travas independentes; ACIMA para ATINGIDO envia só 1. | RN-11 |
| D-11 | Rearmamento | Preço confirmado volta acima do limite do tipo, mais cooldown mínimo de 24 h desde o último envio do tipo (investigation cita 7 dias do Keepa; 24 h é padrão menos silencioso). Sem lembrete periódico. | RN-13 |
| D-12 | Intervalo configurável | 2-6 h. Abaixo de 2 h é recusado. | RF-06-AC2 |
| D-13 | App fechado | Monitora só com app aberto; ao abrir, 1 rodada de recuperação. Limite documentado. | RF-06-AC5, RF-12-AC6 |
| D-14 | "Excluir" | Remoção física do alerta e suas notificações (minimiza PII). Histórico de preço da variante permanece; observações órfãs há mais de 30 dias podem ser limpas (S). | RF-09-AC4 |
| D-15 | Estados de notificação (3 do enunciado) | `PENDENTE`/`ACEITO`/`FALHA`. Retentativa é `PENDENTE` com contador. Teste de e-mail é `ACEITO` com `simulado=true`. | 6.2 |
| D-16 | Modo de e-mail padrão | `EMAIL_MODE=test` por padrão; `real` exige opt-in e credenciais. | RNF-SEC-05 |
| D-17 | Leitura suspeita | Variação absoluta > 70% ou fonte fallback exige 2 leituras concordantes em centavos (investigation 8.2). | RN-09 |
| D-18 | Estoque numérico | Não mostrado como promessa; só "disponível/indisponível" (H1 não confirmada; `stockLevel` pode ser ocultado). | RF-03-AC3 |
| D-19 | Indisponível com preço baixo | Registra, não dispara, não rearma; volta ao estoque pode disparar. | RN-13 |
| D-20 | Produto removido | 2 rodadas com 404/400 = `removido`; coleta para; retomada manual. | RN-19 |
| D-21 | Falhas: quando avisar o dono | 3 falhas por produto; circuito global em 403/desafio, 2x 429 ou 3 falhas seguidas na rodada; 1 aviso por episódio, por e-mail ao `OWNER_EMAIL` (se ausente, só painel). | RN-18 |
| D-22 | Frescor | fresco `<= 2*I` (8 h), defasado até 24 h, sem dados depois. | RN-17 |
| D-23 | URL de entrada | Só `https://www.vans.com.br/...`; extrai `code` de `/{slug}/p/{code}` ou `/p/{code}`; rejeita sufixo de tamanho; descarta query/fragmento. Apex `vans.com.br` não é aceito (host exato). | RF-02 |
| D-24 | Formato do `code` | Valida só caracteres alfanuméricos e tamanho 8-20, e confirma existência pela resposta do OCC (formato exato não está especificado na investigação, só exemplos). | RF-02 |
| D-25 | Catálogo | `category=SAPATOS` (calçados em geral), busca local por nome; `category=TENIS` só depois de validar H6. Atualização manual, máx. 1 por 24 h. | RF-01 |
| D-26 | Histórico: guarda quando? | Uma observação por variante monitorada por rodada; compactação é melhoria. | RF-07-AC6 |
| D-27 | Preço por variante vs produto | Variante quando existir; senão produto (RN-05). Amostra de 5 produtos mostrou preços iguais entre tamanhos. | RN-05 |
| D-28 | Fuso | UTC no banco, America/Sao_Paulo na tela e no e-mail. | RNF-I18N-01 |
| D-29 | Usuário único | Sem login; e-mail do alerta é livre (não verificado). Limitação documentada para deploy público. | seção 8 |
| D-30 | Falha ao enviar e-mail | Sem reenvio automático depois de 4 tentativas (inicial + 3 retentativas); a trava permanece fechada; "reenviar" manual. Evita rajadas de e-mail repetidas. | 6.2 |
| D-31 | Duplicata por queda do processo | Entrega "pelo menos uma vez"; duplicata rara aceita. | R-09 |

Perguntas ainda abertas (decididas por padrão, mas dependem do dono): D-11 (24 h vs 7 dias), D-21 (destinatário `OWNER_EMAIL`), D-04 (inverter para SSR como primária para reduzir carga à origem, investigation C1).

---

## 10. Priorização

| Item | Prioridade | Motivo |
|---|---|---|
| RF-02 cadastro por URL | M | Caminho mais curto, menor risco de coleta |
| RF-03 identidade/variante | M | Base do dado |
| RF-04, 05 alvo e faixa | M | Núcleo do produto |
| RF-06 monitoramento | M | Núcleo |
| RF-07 histórico | M | Pedido no enunciado |
| RF-08 e-mail (modo teste e real) | M | Núcleo |
| RF-09 gestão e dashboard | M | Pedido no enunciado |
| RF-10 dedup e rearme | M | Evita spam |
| RF-11 falhas | M | Invariante de segurança do produto |
| RF-12 saúde/frescor | M | Operação confiável |
| RF-01 catálogo por listagem OCC | M (versão enxuta) | Pedido no enunciado; uma única categoria, busca local |
| Sitemap como descoberta | S | Hashes mudam; 2454 vs 1239 não explicado |
| Gráfico de histórico | S | Tabela basta no MVP |
| Compactação de histórico | S | Volume baixo no MVP |
| Alerta "qualquer tamanho" / por produto | S | D-05 |
| Fallback JSON-LD em produção | S | Valida concordância; SSR cobre o essencial |
| Backup/exportação | S | RNF-REL-05 |
| Outros canais (Telegram, webhook) | F | Referências de mercado |
| Contas, multiusuário, verificação de e-mail | F | Seção 8 |
| Preço Pix/carrinho/cupom | F | H8 sem evidência, checkout é `Disallow` |
| Vários varejistas | F | Fora do escopo |
| Expiração de watch | F | Keepa/Honey; sem demanda |

---

## 11. Matriz de riscos

Probabilidade (P) e impacto (I): A alta, M média, B baixa.

| ID | Risco | P | I | Mitigação | Módulo / requisito |
|---|---|---|---|---|---|
| R-01 | OCC é API interna não documentada: pode mudar, exigir token ou ser bloqueada | M | A | Fallbacks, contrato por fixtures, aviso de parser degradado, estado `formato_desconhecido` | price-monitor; RF-11, RNF-TEST-02 |
| R-02 | Termos proíbem reprodução de conteúdo; permissão sobre `/arezzocoocc` não analisada | M | A | Uso pessoal, dados mínimos, sem imagens/descrições, parar ao bloqueio, revisão jurídica antes de público | RNF-LEG-01 |
| R-03 | Cloudflare ativa desafio/429 | M | M | Circuito 24 h, cortesia, UA identificável, sem evasão | RN-18, RF-11-AC8 |
| R-04 | Preço falso por campo inconsistente (`formattedValue`, `purchasable`, `stockLevelStatus`) | M | A | Só `value` em centavos, `sellable && stockLevel>0`, confirmação, invariante RNF-REL-01 | RN-01..09 |
| R-05 | Preço de vitrine difere do preço pago (Pix, cupom, carrinho) (H8) | M | M | Aviso em UI e e-mail; documentar | D-02 |
| R-06 | SSR com cache até ~5 min gera leitura defasada | A | B | OCC primária, registrar fonte/horário, aviso em `degradada` | RN-09a |
| R-07 | `stockLevel` oculto (H1) ou `isPreOrder` inconsistente (H4) gera disponibilidade errada | M | M | Usar `sellable && stockLevel>0`; não prometer estoque; nova rodada de inspeção | D-18 |
| R-08 | Falso alerta ou alerta perdido por erro de arredondamento ou de float | B | A | Inteiros em centavos e pontos-base; testes de tabela e propriedade | RN-01, RN-10, RF-05 |
| R-09 | Duplicata de e-mail por queda entre envio e gravação; ou aceite sem entrega | B | B | Chave idempotente, estado `ACEITO` honesto; documentar | 6.2, D-31 |
| R-10 | Spam/relé de e-mail via campo livre de destinatário (se exposto) | B (local) / A (público) | A | Escuta em localhost, limites da seção 8, modo teste padrão | RNF-SEC-03, seção 8 |
| R-11 | SSRF por URL colada ou redirect | B | A | Só extrai `code`, allowlist exata, revalida redirects, bloqueia IP privado | RNF-SEC-01 |
| R-12 | CSRF/DNS rebinding contra servidor em localhost | M | M | Verificação de `Origin`/`Host`, token CSRF, bind `127.0.0.1` | RNF-SEC-03/04 |
| R-13 | PII (e-mail) vaza em log ou fixture | M | M | Máscara, revisão de logs por teste, sanitizar fixtures (C10) | RNF-PRIV-01/02 |
| R-14 | Monitor parado sem o usuário notar (app fechado, crash) | A | M | Frescor/`stale`, `/saude`, aviso no dashboard, rodada de recuperação | RF-12 |
| R-15 | `node:sqlite` experimental muda API | M | B | Repositório isolado; `better-sqlite3` como alternativa | RNF-MNT-02 |
| R-16 | Produto sem tamanho, `hasPriceVariations:true` ou pré-venda não cobertos | M | M | `formato_desconhecido`; preço por variante já suportado; nova inspeção | RN-05, RF-03-AC5 |
| R-17 | Frequência real tolerada pela loja desconhecida (Q6, H5) | M | M | Política conservadora, teto 400 req/24 h, circuito; medir logs de status | RNF-REL-04 |
| R-18 | Fixtures incompletas (OCC de Era Navy/Knu dynamic) ou duplicadas | A | B | Capturar e sanitizar antes dos contratos finais | RNF-TEST-04 |
| R-19 | Descoberta incompleta (sitemap 2454 vs search 1239) e `pageSize` máx. desconhecido | M | B | Catálogo enxuto, fallback para `pageSize` menor, URL manual sempre disponível | RF-01 |
| R-20 | Usuário confunde "próximo" com "atingido" ou "aceito" com "entregue" | M | B | Textos explícitos, assunto de e-mail distinto | RF-08-AC2/AC8 |

---

## 12. Rastreabilidade

A matriz REQ para módulo e teste planejado está em `docs/traceability.md`.
