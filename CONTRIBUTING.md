# Contributing

Thank you for helping improve AI Super Canvas. Keep each pull request focused, explain the user or architecture impact, and add tests for behavior changes.

## Prerequisites

- Node.js 24.18.0
- pnpm 11.12.0
- Docker Engine with Docker Compose v2
- Git

The supported versions are also declared in `.nvmrc`, `package.json`, and the repository Dockerfile.

## Bootstrap

```bash
git clone https://github.com/ArchitectureWorld/ai-super-canvas.git
cd ai-super-canvas
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev
```

Before using Docker Compose, replace `POSTGRES_PASSWORD` in `.env` with a long URL-safe random value. Keep `.env` and all provider keys out of commits.

For the containerized application:

```bash
docker compose up --build --detach
curl --fail http://127.0.0.1:3000/api/health
docker compose down
```

The current health route proves web-process liveness only; it is not a database readiness check.

## Required checks

Run these commands from the repository root before opening a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration:docker
pnpm build
pnpm audit --prod --audit-level moderate
```

`pnpm test:integration:docker` is the authoritative integration command. It owns an isolated Docker Compose project, applies tracked migrations, runs the database integration suite, and removes its containers, network, and volume on exit.

Browser E2E is available as `pnpm test:e2e`, but it is not yet a required or verified gate. Do not report E2E as passing without a fresh successful Playwright run.

## Pull requests

1. Branch from the current `main` and use a descriptive branch name.
2. Follow test-driven development for behavior changes: demonstrate the focused RED before implementation and the GREEN after it.
3. Update operational or architecture documentation when interfaces or deployment assumptions change.
4. Include the commands and results used for verification in the pull request description.
5. Never include secrets, `.env`, generated caches, local databases, or test artifacts.

Security-sensitive findings must follow [SECURITY.md](SECURITY.md), not the public issue tracker.
