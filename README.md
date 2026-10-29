# Vans Price Watcher

Monitor pessoal de precos da Vans Brasil com alertas por e-mail. Node 24, TypeScript sem build, SQLite.

```
npm ci
copy .env.example .env   # (cp no Linux/macOS); EMAIL_MODE padrao = test
npm run db:migrate
npm start                 # http://127.0.0.1:3000
npm run typecheck && npm run test:cov
```

Detalhes: `docs/operations.md`, `docs/architecture.md`.
