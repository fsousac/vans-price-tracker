# Fase 0 - Inventário de ambiente e ferramentas

Data: 2026-10-14. Origem geral: comandos Bash locais nesta sessão. Confiança: alta, salvo indicação.

## Fatos

| Item | Evidência (comando) | Confiança |
|---|---|---|
| Repo vazio, sem git | `ls -la` mostra só `docs/` e `tests/` (vazios, criados 10:00); sem `.git` | alta |
| Node | `node -v` = v24.14.0; npm 11.13.0; pnpm 12.11.2 | alta |
| Python | `python --version` = 3.14.7 | alta |
| Git | 2.53.0.windows.2 (instalado; repo ainda não inicializado) | alta |
| curl | 8.18.0 (Schannel) | alta |
| Docker | `docker --version` = 29.3.0 (daemon não testado) | média |
| Playwright | `npx playwright --version` baixou e rodou 1.64.1 (instalável via npx). Browsers não baixados/testados | média |
| SQLite | `require('node:sqlite')` OK: DatabaseSync, StatementSync, Session, backup. Emite ExperimentalWarning | alta |
| Shell | Bash (Git Bash) e PowerShell | alta |

## Plugin "reverse-engineering-anything" vs REA

- Nome pedido não existe. O instalado é a skill `reverse-engineer-anything` (SKILL.md, metadata version 37, tool_count 170) em `C:/Users/felipe.coelho/.claude/skills/reverse-engineer-anything/` com `references/` (android-applications, connection-and-recovery, evidence-workflows, javascript-applications, native-and-artifacts, runtime-observation). Datada 2026-10-13 22:00. Confiança alta.
- Não é plugin: `installed_plugins.json` não contém REA (grep sem resultado). É skill de diretório de usuário. Há um falso positivo "reverse-engineering" no cache de marketplace (outro plugin, War Room legado), não relacionado.
- Servidor MCP `rea` existe: `~/.claude.json` contém chave `"rea"` e a sessão expõe ~170 ferramentas `mcp__rea__*` (deferidas; carregar via ToolSearch). A própria SKILL.md diz que instalar a skill NÃO registra o MCP; fallback documentado: `npx -y rea-agents@6.4.0`. Repo `morluto/rea` aparece em SKILL.md/references (informado pela tarefa; não verifiquei o repo remoto). Confiança alta quanto ao registro, média quanto à versão do servidor.
- Ferramentas REA relevantes para web (nomes vistos na lista, não executadas ainda): `capture_browser_scenario`, `list_browser_targets`, `inspect_web_page`, `inspect_web_network_capture`, `observe_web_session`, `observe_web_execution`, `capture_web_screenshot`, `compare_web_captures`, `export_web_scripts`, `analyze_web_bundle`, `analyze_javascript_application`, `recover_javascript_sources`, `discover_webmcp_tools`, `trace_web_module_imports`. Hipótese: exigem navegador com porta de depuração (CDP); não confirmado. As demais (adb, Mach-O, firmware, JEB) são irrelevantes para o projeto.
- Interpretação: a skill diz ser para artefatos distribuídos/runtime; para uma loja web, curl/Playwright é o caminho primário, REA serve para inspecionar rede e bundles JS.

## Outras ferramentas de pesquisa disponíveis

- WebFetch e WebSearch (deferidas, carregadas via ToolSearch); Chrome MCP `mcp__claude-in-chrome__*` (navigate, read_page, get_page_text, read_network_requests, javascript_tool); curl.
- Indisponíveis nesta sessão: MCP `filesystem` (CONNECTION_CLOSED) e `sonarqube` (conexão recusada em localhost:9000, Sonar fora do ar).
- Não existe plugin "RevEng" nem skill "reverse-engineerskill": são variações de nome incorretas.

## Mecanismos de subagente

- Esta sessão é um subagente de workflow (script orquestrador). Disponíveis: ferramenta `Workflow` via skill `workflow-authoring` (não verificada aqui), `ListAgents` e `SendMessage` (deferida) para outros agentes/sessões; skills `superpowers:dispatching-parallel-agents`, `superpowers:subagent-driven-development`, `caveman:cavecrew` (investigator/builder/reviewer), `anthropic-skills:deep-research`. Não há ferramenta `Agent`/`Task` listada diretamente para este subagente; diretório `~/.claude/agents` não existe. Confiança média.

## Riscos / incógnitas

- Risco: `node:sqlite` é experimental (API pode mudar); alternativa better-sqlite3 exige build nativo no Windows.
- Risco: Python 3.14 pode ter wheels ausentes; preferir Node.
- Incógnita: daemon Docker ativo; browsers do Playwright (download necessário); se o MCP rea conecta a Chrome real.
- Hipótese: stack Node 24 + node:sqlite + fetch simples basta, se /c/* tiver JSON-LD ou `__NEXT_DATA__`/VTEX (a verificar nas fases seguintes, sem presumir).
