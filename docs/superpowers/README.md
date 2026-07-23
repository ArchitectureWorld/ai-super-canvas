# Design and Implementation Index

## Current Architecture Baseline: Agent Session Graph

- `../architecture/README.md`
- `../architecture/adr/0001-canvas-control-plane-and-runtime-adapters.md`
- `../architecture/agent-session-domain-model.md`
- `../architecture/postgres-schema.md`
- `../architecture/runtime-adapter-contract.md`
- `../architecture/hermes-acp-capability-gates.md`
- `../architecture/development-roadmap.md`

Current implementation entry:

- `plans/2026-07-15-agent-session-control-plane-foundation.md`

Authority for Agent/Session work:

```text
architecture/ADR + domain + runtime contract
> 2026-07-15 control-plane foundation plan
> earlier Feature 01 plans/specs
```

Earlier Feature 01 documents remain useful for product semantics and prototype history, but cannot override the current Agent-Session architecture.

## Future Product Design: World Canvas

Product baseline:

- `../09-world-canvas.md`

Design specification awaiting user review:

- `specs/2026-07-23-world-canvas-and-multiscale-subgraphs-design.md`

The World Canvas design defines the top-level project graph, project portals, semantic zoom, typed cross-project relationships, permission boundaries, and AI relation proposals. It does not yet authorize implementation or change the current S1–S4 dependency order.

Authority for World Canvas work:

```text
architecture/ADR + Agent-Session domain invariants
> docs/09-world-canvas.md product baseline
> 2026-07-23 World Canvas design specification
> future implementation plan after user approval
```

## Historical Feature 01: Organic Graph Workspace

### Historical Design Record

- `specs/2026-07-12-unified-organic-workspace-design.md`

### Historical Implementation Records

- `plans/2026-07-12-feature-01-mvp-implementation.md`
- `plans/2026-07-12-feature-01-execution-entry.md`

### Required Review

- `../reviews/2026-07-12-feature-01-implementation-review.md`

Historical Feature 01 execution priority:

```text
execution-entry.md
> review findings
> detailed implementation plan
> design spec
```

The entry file does not replace the design; it defines mandatory corrections discovered during review.
