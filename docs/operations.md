# Operação: Vans Price Watcher (esqueleto)

Versão 0.1 (2026-10-14). Esqueleto: as seções marcadas `(preencher)` são completadas pela tarefa T56 do `implementation-plan.md` quando o código existir. O que já está decidido é afirmado; o que depende de código ainda inexistente está marcado.

> **ADR-0006 (2026-10-15): o produto agora é uma extensão MV3.** Operação de servidor (porta, `.env`, backup do SQLite) é histórica; a tarefa E34 reescreve este documento para a extensão (carregar sem compactação, saúde, checklist manual).

## 1. Requisitos de ambiente

- Node.js >= 24 (verificado 24.14.0) e npm >= 11. Nada de Python, Docker ou navegador necessários.
- Windows, Linux ou macOS (o `better-sqlite3` traz binário pré-compilado para `win32-x64`, `linux-x64`, `darwin-*`; verificado no Windows).
- Rede de saída HTTPS para `www.vans.com.br` na porta 443; SMTP de saída só com `EMAIL_MODE=real`.

## 2. Instalação e primeira execução (preencher: comandos finais)

```
npm ci
copy .env.example .env      # (Windows)  /  cp .env.example .env
npm run db:migrate          # opcional: a partida também migra
npm start                   # http://127.0.0.1:3000
```

Padrão seguro: `EMAIL_MODE=test` (nenhum e-mail sai). Para enviar de verdade: preencher `SMTP_*` e `OWNER_EMAIL` no `.env` e definir `EMAIL_MODE=real`; a partida falha nomeando a variável que faltar.

## 3. Configuração

Tabela de variáveis em `docs/security.md`, seção 3. Valores padrão: intervalo 4 h (2-6), 50 produtos, 400 req/24 h (qualquer origem), bind `127.0.0.1`.

## 4. Execução contínua (preencher)

O monitor só roda **enquanto o processo está de pé** (D-13). Opções documentadas pela T56: terminal aberto; `pm2`/Agendador de Tarefas do Windows/`systemd --user` para iniciar com a máquina; Docker opcional. Ao iniciar, o app faz no máximo 1 rodada de recuperação. Rode **uma instância só** por banco: duas dobrariam a cadência de requisições (o espaçamento é por processo). O dashboard mostra o aviso.

## 5. Saúde e diagnóstico

| O quê | Como |
|---|---|
| Está vivo e fresco? | `GET http://127.0.0.1:3000/saude` (JSON sem PII): scheduler `ok`/`atrasado`/`pausado_circuito`, última rodada, circuito, frescor, modo de e-mail, contadores |
| Última rodada | tabela `monitoring_runs` / `run_items` (ou tela do dashboard) |
| Por que um produto falha? | `run_items.failure_class`, `http_status`; corpo bruto sanitizado em `failure_samples` (1 por produto) |
| Logs | stdout, JSON por linha; filtrar por `run_id`, `product_code`, `failure_class`. Sem PII |

## 6. Runbook (preencher: textos finais; decisões já tomadas)

| Situação | Sintoma | Ação |
|---|---|---|
| Circuito aberto | `/saude`: `pausado_circuito`, banner no dashboard | Esperar 24 h; retoma sozinho com 1 requisição de teste. Não reduzir intervalo, não trocar UA |
| Parser degradado | aviso `parser_degradado`; observações `degradada` | OCC mudou ou caiu; conferir `failure_samples`; capturar novas fixtures (`scripts/capture-fixtures.ts`) e ajustar `occ.source.ts` |
| `formato_desconhecido` | produto marcado, sem alerta | Produto fora do suporte (acessório, sem tamanhos) ou contrato mudou |
| Produto `removido` ou `formato_desconhecido` | aviso único ao dono; coleta parada | Alertas ficam visíveis; botão "retomar coleta" no produto (sem ele a coleta não volta sozinha) |
| Dados `defasado`/`sem_dados` | selo no dashboard | App ficou fechado ou circuito aberto |
| Notificação `FALHA` | painel mostra motivo | Corrigir SMTP/e-mail; botão "reenviar" (mesma notificação) |
| `ACEITO` sem e-mail na caixa | aceite != entrega | Ver spam, domínio do remetente; o MVP não observa bounce |
| Migração falhou | partida aborta com mensagem | Restaurar `data/backups/vans-alert-pre-NNNN-*.db` (feito antes da migração) |

## 7. Backup e restauração (preencher; RNF-REL-05, S)

Cópia a frio: parar o app e copiar `data/vans-alert.db` (e `-wal`/`-shm` se existirem; com o app parado o WAL já foi consolidado). Cópia a quente: `sqlite3 vans-alert.db "VACUUM INTO 'backup.db'"` (consistente). O arquivo contém e-mails dos alertas (PII): guardar com o mesmo cuidado do `.env`. Restaurar = substituir o arquivo com o app parado.

## 8. Atualização

`git pull`, `npm ci`, `npm run typecheck && npm test`, reiniciar. Migrações são automáticas, versionadas e com backup prévio (`data-model.md`, seção 6). Reverter código com migração já aplicada exige restaurar o backup.

## 9. Fixtures e contratos (preencher)

Quando a loja mudar, os testes de contrato com fixtures continuam verdes (são capturas antigas). Para detectar mudança real: `npm run test:live` (manual, poucas requisições, ritmo lento, nunca em CI). Captura de novas fixtures: `scripts/capture-fixtures.ts`, seguida de `scripts/sanitize-fixtures.ts` (remove `fbclid`/UTM/cookies, ver investigation C10).

## 10. Conformidade operacional

Uso pessoal; não aumentar volume; não coletar áreas `Disallow` do `robots.txt`; parar ao bloqueio. Não versionar `.env`, `data/` nem fixtures com dados de campanha. Limites de um eventual deploy público: `docs/security.md`, seção 8.

## 11. Pendências para o dono

- Escolher provedor SMTP e remetente (D-21: `OWNER_EMAIL`).
- Decidir D-11 (cooldown 24 h vs 7 dias) e D-04 (OCC vs `__NEXT_DATA__` como primária para reduzir carga à origem).
- Revisão jurídica dos termos e do uso do `/arezzocoocc` antes de qualquer exposição pública (R-02).
