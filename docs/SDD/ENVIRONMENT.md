# SDD — Fase zero: descoberta do ambiente

Data: 2026-10-29. Todas as linhas abaixo foram observadas por comando nesta sessão, salvo as marcadas "não verificado".

## Repositório

- Já existe um projeto avançado (231 arquivos em `src/` e `tests/`, 20 docs em `docs/`, ADR-0001..0006). Pivô para extensão MV3 registrado em `docs/adr/0006-extensao-navegador.md`. **Não é greenfield**: o SDD será aplicado como auditoria e fechamento de lacunas, sem reescrever stack.
- **Não é repositório Git** (`git init` pendente; sem ele não há commit candidato identificável — Gate 6). `git 2.53` instalado.
- Stack: Node 24.14, npm 11.13, TypeScript 7.0.2 (`tsc` nativo), esbuild 0.28.2, `node:test`. Sem framework de UI. Pacote `dist/` já gerado (manifest MV3, `background.js`, `popup`, `options`).
- Dependências de runtime em `package.json`: `hono`, `@hono/node-server`, `better-sqlite3`, `nodemailer` (vestígios do desenho servidor anterior; `docs/extension-architecture.md` diz que a extensão os dispensa — verificar se vazam para o bundle).

## Verificações executadas (baseline, sem alterações de código)

| Comando | Saída | Resultado |
|---|---|---|
| `npm run typecheck` | exit 0 | OK |
| `npm run test:cov` | exit 0; cobertura linhas 99.03 / branches 93.11 / funções 96.23 | OK (limiar 80/80) |
| `npm audit --omit=dev` | 1 vulnerabilidade **moderada** em `nodemailer` (corrigível só com `--force`) | ABERTO — avaliar se `nodemailer` entra no bundle da extensão |
| `npm run build` | **não executado ainda** | pendente |

## Fonte de preço da Vans Brasil

- `docs/investigation.md` (2026-10-14) documenta OCC `GET /arezzocoocc/v2/vans/products/{code}` como fonte primária, `__NEXT_DATA__` como fallback, JSON-LD como terceira.
- Reconfirmado hoje (2026-10-29) ao vivo: `GET https://www.vans.com.br/arezzocoocc/v2/vans/products/1003800580026U/dynamic-product-fields` → HTTP 200, `application/json`, `Cache-Control: no-cache, no-store`. (O corpo não foi parseado: o redirecionamento para `/tmp` falhou no Windows. Os valores de preço continuam amparados por fixtures e pela verificação de 2026-10-14.)
- `robots.txt` (lido hoje): `User-agent: *` não proíbe `/p/*`, `/c/*` nem `/arezzocoocc/`. Termos de uso proíbem reprodução de imagens/textos; sem cláusula explícita sobre robôs. Risco jurídico residual registrado em `docs/investigation.md` §7.
- Lacunas abertas da investigação: preço de vitrine vs. carrinho/Pix (H8), taxa sustentada sem bloqueio (H5), produtos sem tamanhos / `hasPriceVariations:true`.
- Nota de ambiente: no Windows corporativo o `curl` precisa de `--ssl-no-revoke` (falha `CRYPT_E_NO_REVOCATION_CHECK`).

## Orquestração e modelos

- Ferramentas de delegação realmente disponíveis nesta sessão: `Agent` (subagentes, incluindo `fork`) e `Workflow` (orquestração determinística, opt-in dado pelo modo ultracode). Seletor de modelo exposto: `sonnet`, `opus`, `haiku`, `fable`. Modelo do Master Agent: Sonnet 5.5.
- Limite de contexto e capacidade de cada modelo: **não verificado**; a seleção por tarefa será registrada em `STATUS.md` com resultado observado.
- Independência da banca: avaliadores serão rodados com `model` diferente do implementador sempre que possível; o histórico mostra que a implementação existente foi feita por sessões anteriores, o que favorece independência.

## Ferramentas de teste/segurança

- Chrome 156 instalado (`C:\Program Files\Google\Chrome`); skill `playwright-skill` e MCP `claude-in-chrome` disponíveis para teste E2E real — **não verificado** que carregar extensão descompactada funciona neste ambiente.
- SonarQube local (`localhost:9000`) **indisponível** (conexão recusada) → sem análise Sonar; usar `semgrep`/`codeql` via skills `static-analysis` se instalados (**não verificado**).
- Sem lint dedicado (ESLint) no `package.json`; análise estática atual = `tsc --noEmit` estrito.
