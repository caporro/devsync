# Contributing

## Setup

```bash
npm ci
npm --prefix web ci
npm --prefix web run build
npm start
```

For local development, copy `.env.example` to `.env` and use `AUTH_MODE=none`.

## Checks

Run the same checks used by CI:

```bash
npm audit --audit-level=moderate
npm run check:server
npm run test:server
npm --prefix web audit --audit-level=moderate
npm --prefix web run lint
npm --prefix web test -- --run
npm --prefix web run build
```

## Code Style

- Keep changes small and local to the touched path.
- Prefer simple filesystem-first code over new infrastructure.
- Keep APIs explicit and predictable.
- Do not add dependencies unless they remove real risk or complexity.
- Update tests for security-sensitive behavior.
- Update README when data contracts, auth, env vars, or release behavior change.

## Pull Requests

Before opening a PR:

- verify no secrets or local vault data are included;
- keep `npm audit` clean for backend and frontend;
- include reproduction steps for bug fixes;
- include migration notes for data-format changes;
- avoid unrelated formatting churn.
