# AI Super Canvas / AI 超级画板

AI 超级画板是一个面向 AI 原生工作流的图谱式、有机式智能画布。它把线性 Chat 扩展为可分枝、可回流、可代谢、可重构的会话空间，并以一张统一画布承载创意、资产、任务、复盘和历史。

> **Prototype status:** The current browser UI is a **localStorage prototype**. Workspace state stays in that browser, the visible AI behavior is a deterministic demo, and the UI is not yet connected to PostgreSQL, external model providers, multi-user synchronization, or the control-plane persistence layer.

The repository also contains the database control plane and Runtime adapter contracts that are being hardened independently of the prototype UI. Do not treat the current screen as a production-ready or server-persisted application.

## Product direction

The first product slice is **Feature 01: graph-based / organic conversation canvas**. Users can select text in the trunk, create an anchored branch, explore it independently, turn useful results into conclusion cards, and explicitly reintegrate those cards into a new trunk revision.

The longer-term foundation includes AI image workflows, structured asset generation, presentation workflows, CAD agents, multi-agent orchestration, and durable project memory. Focus modes change emphasis inside the same canvas; they do not create separate workspaces.

## Architecture

Each canvas Chat block is designed to become a persistent `SessionNode/Session`. A Workflow contains branchable Sessions, each execution is a distinct Run, and the control plane uses replaceable Runtime adapters.

- [Architecture index](docs/architecture/README.md)
- [Control-plane and Runtime adapter ADR](docs/architecture/adr/0001-canvas-control-plane-and-runtime-adapters.md)
- [Agent and Session domain model](docs/architecture/agent-session-domain-model.md)
- [PostgreSQL schema](docs/architecture/postgres-schema.md)
- [Runtime adapter contract](docs/architecture/runtime-adapter-contract.md)
- [Hermes ACP capability gates](docs/architecture/hermes-acp-capability-gates.md)
- [Development roadmap](docs/architecture/development-roadmap.md)
- [Deep repository review dated 2026-07-22](docs/reviews/2026-07-22-deep-repository-review.md)

## Prerequisites

- Node.js 24.18.0
- pnpm 11.15.1
- Docker Engine with Docker Compose v2
- Git

## Bootstrap for local development

```bash
git clone https://github.com/ArchitectureWorld/ai-super-canvas.git
cd ai-super-canvas
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev
```

Review `.env` before starting services. At minimum, replace `POSTGRES_PASSWORD` with a long URL-safe random value. Provider keys such as `OPENAI_API_KEY` are optional for the current prototype and must never be committed.

Open `http://127.0.0.1:3000` after the development server starts.

## Docker bootstrap

```bash
cp .env.example .env
# Replace POSTGRES_PASSWORD in .env before continuing.
docker compose up --build --detach
curl --fail http://127.0.0.1:3000/api/health
```

Stop the stack without deleting the persistent PostgreSQL volume:

```bash
docker compose down
```

The current `/api/health` route is a web liveness signal. Database-backed readiness is a documented follow-up.

## Commands and test status

| Area | Exact command | Status and purpose |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | Reproducible workspace bootstrap from the tracked lockfile |
| Development | `pnpm dev` | Starts the local Next.js UI |
| Lint | `pnpm lint` | Required static-analysis gate |
| Typecheck | `pnpm typecheck` | Required TypeScript gate |
| Unit and contract tests | `pnpm test` | Required deterministic unit/contract gate |
| Database integration | `pnpm test:integration:docker` | Authoritative disposable integration gate; requires Docker |
| Production dependency audit | `pnpm audit --prod --audit-level moderate` | Required production advisory gate |
| Build | `pnpm build` | Required workspace production build |
| Browser E2E | `pnpm test:e2e` | Defined, but not yet a required or verified passing gate |

The tracked `Quality` workflow defines `verify` and `integration` jobs. CodeQL runs JavaScript/TypeScript analysis on `main`, pull requests, and a weekly schedule. See the dated [deep repository review](docs/reviews/2026-07-22-deep-repository-review.md) for evidence counts and the distinction between local verification and public CI runs.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

For security reports, do not open a public issue. Follow [SECURITY.md](SECURITY.md) and contact [@ArchitectureWorld](https://github.com/ArchitectureWorld) through the private reporting route described there.

## Keywords

- Graph-based Conversation / 图谱式会话
- Organic Conversation / 有机式会话
- Unified Workspace / 统一工作台
- Semantic Anchor / 语义锚点
- Branching, reintegration, pruning, decay, and trunk reconstruction
