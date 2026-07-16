# Feature 01 Organic Graph Workspace Implementation Plan

> 状态：2026-07-12 历史详细计划。通用 `WorkspaceObject`、AI Run/Proposal 混合状态和 Agent 后置假设已被 [`docs/architecture`](../../architecture/README.md) 取代；未完成任务不得直接照此执行。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private-alpha MVP where a user can create a trunk conversation, select a word/sentence/paragraph as a semantic anchor, grow an independent branch, turn branch output into a conclusion card, preview and apply feedback to the trunk, metabolize the branch, and inspect the complete growth timeline.

**Architecture:** Use a renderer-independent domain package and an append-only domain-event log. React Flow is the first `CanvasAdapter`; Tiptap provides rich text and stable text selections. AI output is streamed into a typed Proposal and never mutates workspace state until an accepted Command runs in a PostgreSQL transaction.

**Tech Stack:** Next.js 16 App Router, TypeScript, React Flow 12, Tiptap/ProseMirror, Zustand, ELK.js, PostgreSQL 18, Drizzle ORM, OpenAI Responses API, IndexedDB, Vitest, React Testing Library, Playwright, Docker Compose.

## Global Constraints

- The product is one unified workspace; focus modes are projections, not separate pages or duplicated data.
- MVP implements text anchors only; image and file anchors remain typed extension points.
- Every semantic anchor references an immutable source revision.
- AI may create Proposals only; user-accepted Commands are the only path to persistent mutations.
- Every structural mutation emits a domain event and has an inverse command when technically reversible.
- Branch top-level states are exactly `active`, `review`, `integrated`, `dormant`, and `metabolized`.
- `metabolized` branches store exactly one metabolism kind: `prune`, `decay`, `humify`, or `archive`.
- PostgreSQL relational columns store identity, state, foreign keys, sequence, and timestamps; JSONB stores typed props/selectors/payloads only.
- API keys are server-only. Workspace ownership is checked on every API route.
- No multiplayer, CRDT, image generation, global knowledge graph, or automatic unconfirmed feedback in this plan.
- All UI controls must have keyboard access, tooltip text, `aria-label`, and reduced-motion behavior.
- Use `pnpm`; commit the generated lockfile and never use floating dependency versions after initial installation.

---

## Delivery Gates

| Gate | Tasks | Review Question | Exit Condition |
|---|---|---|---|
| A — Architecture Spike | 1–3 | Can domain, persistence, and renderer evolve independently? | Domain tests and PostgreSQL transaction tests pass |
| B — Canvas & Anchor | 4–6 | Can users reliably select text and trace a branch to its exact source? | Anchor re-location and branch source E2E pass |
| C — AI & Feedback | 7–9 | Can AI propose, users preview, and Commands safely apply/revert? | Stale proposal, cancel, apply, undo tests pass |
| D — Alpha Readiness | 10–12 | Is the Golden Path usable, recoverable, accessible, and deployable? | Full Playwright suite and release checklist pass |

---

### Task 1: Repository Scaffold and Quality Gates

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `.nvmrc`
- Create: `apps/web/**` via Next.js scaffold
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/db/package.json`
- Create: `packages/ai/package.json`
- Create: `vitest.workspace.ts`
- Create: `playwright.config.ts`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Produces: workspace packages `@ai-super-canvas/core`, `@ai-super-canvas/db`, `@ai-super-canvas/ai`.
- Produces: root scripts `dev`, `build`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`.

- [ ] **Step 1: Add root workspace configuration**

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - packages/*
```

```json
{
  "name": "ai-super-canvas",
  "private": true,
  "packageManager": "pnpm@10.13.1",
  "scripts": {
    "dev": "pnpm --filter @ai-super-canvas/web dev",
    "build": "pnpm -r build",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:integration": "vitest run --project integration",
    "test:e2e": "playwright test"
  }
}
```

- [ ] **Step 2: Scaffold the web app**

Run:

```bash
pnpm create next-app@16.2.10 apps/web \
  --ts --eslint --tailwind --app --src-dir \
  --import-alias '@/*' --use-pnpm
```

Expected: `apps/web/package.json` exists and `pnpm --filter @ai-super-canvas/web dev` starts a Next.js page.

Change `apps/web/package.json` name to:

```json
"name": "@ai-super-canvas/web"
```

- [ ] **Step 3: Install runtime dependencies**

```bash
pnpm --filter @ai-super-canvas/web add \
  @xyflow/react@12.11.2 zustand @tiptap/react @tiptap/starter-kit \
  @tiptap/extension-placeholder elkjs idb-keyval zod
pnpm --filter @ai-super-canvas/db add drizzle-orm postgres zod
pnpm --filter @ai-super-canvas/ai add openai zod
pnpm add -Dw vitest @vitest/coverage-v8 jsdom \
  @testing-library/react @testing-library/user-event \
  @playwright/test typescript tsx eslint
```

Expected: all versions are pinned in `pnpm-lock.yaml`.

- [ ] **Step 4: Add package skeletons**

```json
// packages/core/package.json
{
  "name": "@ai-super-canvas/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.25.0" }
}
```

Repeat this shape for `packages/db` and `packages/ai`, adding workspace dependency `@ai-super-canvas/core: workspace:*` where required.

- [ ] **Step 5: Add PostgreSQL development service**

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: canvas
      POSTGRES_PASSWORD: canvas
      POSTGRES_DB: canvas
    ports:
      - "54329:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U canvas -d canvas"]
      interval: 3s
      timeout: 3s
      retries: 20
    volumes:
      - canvas_pg:/var/lib/postgresql/data
volumes:
  canvas_pg:
```

```dotenv
# .env.example
DATABASE_URL=postgres://canvas:canvas@localhost:54329/canvas
OPENAI_API_KEY=
OPENAI_MODEL=
SESSION_SECRET=change-this-in-development
```

- [ ] **Step 6: Verify the scaffold**

Run:

```bash
docker compose up -d postgres
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all commands exit 0; the initial test run may report “no test files found” only before Task 2.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "chore: scaffold unified workspace monorepo"
```

---

### Task 2: Renderer-Independent Domain Model

**Files:**
- Create: `packages/core/src/ids.ts`
- Create: `packages/core/src/objects.ts`
- Create: `packages/core/src/revisions.ts`
- Create: `packages/core/src/edges.ts`
- Create: `packages/core/src/anchors.ts`
- Create: `packages/core/src/branches.ts`
- Create: `packages/core/src/cards.ts`
- Create: `packages/core/src/proposals.ts`
- Create: `packages/core/src/events.ts`
- Create: `packages/core/src/focus.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/domain.test.ts`

**Interfaces:**
- Produces: branded IDs, `WorkspaceGraph`, `TextAnchorSelector`, `BranchState`, `Proposal`, `WorkspaceEvent`, `projectFocus()`.
- Consumers: every subsequent package and UI task.

- [ ] **Step 1: Write failing domain tests**

```ts
// packages/core/src/__tests__/domain.test.ts
import { describe, expect, it } from 'vitest';
import {
  createTextAnchor,
  transitionBranch,
  projectFocus,
  type WorkspaceGraph,
} from '../index';

describe('domain invariants', () => {
  it('rejects a text anchor whose quote does not match the revision', () => {
    expect(() => createTextAnchor({
      sourceObjectId: 'obj_1',
      sourceRevisionId: 'rev_1',
      sourceContent: 'alpha beta gamma',
      start: 6,
      end: 10,
      exact: 'wrong',
    })).toThrow('Anchor quote does not match source content');
  });

  it('allows dormant branches to return to active', () => {
    expect(transitionBranch('dormant', 'active')).toBe('active');
  });

  it('does not allow metabolized branches to become active', () => {
    expect(() => transitionBranch('metabolized', 'active'))
      .toThrow('Invalid branch transition');
  });

  it('changes projection without duplicating graph objects', () => {
    const graph = { objects: {}, edges: {}, anchors: {} } as WorkspaceGraph;
    const projection = projectFocus(graph, 'growth');
    expect(projection.sourceGraph).toBe(graph);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm vitest run packages/core/src/__tests__/domain.test.ts
```

Expected: FAIL because exports do not exist.

- [ ] **Step 3: Implement branded IDs and core types**

```ts
// packages/core/src/ids.ts
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type ObjectId = Brand<string, 'ObjectId'>;
export type RevisionId = Brand<string, 'RevisionId'>;
export type EdgeId = Brand<string, 'EdgeId'>;
export type AnchorId = Brand<string, 'AnchorId'>;
export type BranchId = Brand<string, 'BranchId'>;
export type CardId = Brand<string, 'CardId'>;
export type ProposalId = Brand<string, 'ProposalId'>;
export type EventId = Brand<string, 'EventId'>;
export type AiRunId = Brand<string, 'AiRunId'>;
```

Implement `WorkspaceObject`, `ObjectRevision`, `WorkspaceEdge`, `Branch`, `Card`, `ProposalEnvelope`, and `WorkspaceEvent` exactly as defined in the design spec.

- [ ] **Step 4: Implement text anchor validation**

```ts
// packages/core/src/anchors.ts
import { createHash } from 'node:crypto';
import type { ObjectId, RevisionId } from './ids';

export interface TextAnchorSelector {
  type: 'text';
  sourceObjectId: ObjectId;
  sourceRevisionId: RevisionId;
  position: { start: number; end: number };
  quote: { exact: string; prefix: string; suffix: string };
  sourceContentHash: string;
}

export function createTextAnchor(input: {
  sourceObjectId: string;
  sourceRevisionId: string;
  sourceContent: string;
  start: number;
  end: number;
  exact: string;
}): TextAnchorSelector {
  const actual = input.sourceContent.slice(input.start, input.end);
  if (actual !== input.exact) {
    throw new Error('Anchor quote does not match source content');
  }
  return {
    type: 'text',
    sourceObjectId: input.sourceObjectId as ObjectId,
    sourceRevisionId: input.sourceRevisionId as RevisionId,
    position: { start: input.start, end: input.end },
    quote: {
      exact: input.exact,
      prefix: input.sourceContent.slice(Math.max(0, input.start - 32), input.start),
      suffix: input.sourceContent.slice(input.end, input.end + 32),
    },
    sourceContentHash: createHash('sha256')
      .update(input.sourceContent)
      .digest('hex'),
  };
}
```

- [ ] **Step 5: Implement branch state machine**

```ts
// packages/core/src/branches.ts
export type BranchState =
  | 'active'
  | 'review'
  | 'integrated'
  | 'dormant'
  | 'metabolized';

const ALLOWED: Record<BranchState, BranchState[]> = {
  active: ['review', 'dormant', 'metabolized'],
  review: ['active', 'integrated', 'metabolized'],
  integrated: ['active', 'dormant', 'metabolized'],
  dormant: ['active', 'metabolized'],
  metabolized: [],
};

export function transitionBranch(
  from: BranchState,
  to: BranchState,
): BranchState {
  if (!ALLOWED[from].includes(to)) {
    throw new Error(`Invalid branch transition: ${from} -> ${to}`);
  }
  return to;
}
```

- [ ] **Step 6: Implement focus projection contract**

`projectFocus()` must return the original graph reference plus sets of visible/emphasized IDs and available actions. Implement complete rules for `growth` and `history`; return conservative projections for the four future modes.

- [ ] **Step 7: Run tests and typecheck**

```bash
pnpm vitest run packages/core/src/__tests__/domain.test.ts
pnpm --filter @ai-super-canvas/core typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core
git commit -m "feat: define organic workspace domain model"
```

---

### Task 3: PostgreSQL Schema, Migrations, and Repository Transactions

**Files:**
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/schema/workspaces.ts`
- Create: `packages/db/src/schema/objects.ts`
- Create: `packages/db/src/schema/anchors.ts`
- Create: `packages/db/src/schema/branches.ts`
- Create: `packages/db/src/schema/cards.ts`
- Create: `packages/db/src/schema/ai.ts`
- Create: `packages/db/src/schema/events.ts`
- Create: `packages/db/src/repositories/workspaceRepository.ts`
- Create: `packages/db/src/repositories/eventRepository.ts`
- Create: `packages/db/src/index.ts`
- Test: `packages/db/src/__tests__/workspaceRepository.integration.test.ts`

**Interfaces:**
- Consumes: `@ai-super-canvas/core` IDs and event types.
- Produces: `WorkspaceRepository`, `EventRepository`, `withWorkspaceTransaction()`.

- [ ] **Step 1: Write a failing transaction test**

The test must create a workspace, insert an object and revision, append two events, and verify sequences `[1, 2]`. A second transaction with stale `expectedSequence: 0` must reject with `WorkspaceSequenceConflict`.

- [ ] **Step 2: Run PostgreSQL and verify test failure**

```bash
docker compose up -d postgres
pnpm test:integration
```

Expected: FAIL because schema and repositories are missing.

- [ ] **Step 3: Create normalized schema**

Use UUID primary keys and these mandatory constraints:

```ts
// conceptual excerpt for packages/db/src/schema/events.ts
export const workspaceEvents = pgTable(
  'workspace_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    payload: jsonb('payload').notNull(),
    inversePayload: jsonb('inverse_payload'),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('workspace_event_sequence_uq')
      .on(table.workspaceId, table.sequence),
  ],
);
```

Add indexes for `workspaceId`, `sourceRevisionId`, `branchState`, `proposalStatus`, and event time.

- [ ] **Step 4: Implement optimistic transaction helper**

```ts
export async function withWorkspaceTransaction<T>(input: {
  workspaceId: string;
  expectedSequence: number;
  run: (tx: DbTransaction, nextSequence: () => number) => Promise<T>;
}): Promise<T> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute(sql`
      select id, event_sequence
      from workspaces
      where id = ${input.workspaceId}
      for update
    `);
    if (!row) throw new Error('WorkspaceNotFound');
    if (Number(row.event_sequence) !== input.expectedSequence) {
      throw new Error('WorkspaceSequenceConflict');
    }
    let sequence = input.expectedSequence;
    const result = await input.run(tx, () => ++sequence);
    await tx.update(workspaces)
      .set({ eventSequence: sequence, updatedAt: new Date() })
      .where(eq(workspaces.id, input.workspaceId));
    return result;
  });
}
```

- [ ] **Step 5: Generate and apply migrations**

```bash
pnpm --filter @ai-super-canvas/db drizzle-kit generate
pnpm --filter @ai-super-canvas/db drizzle-kit migrate
```

Expected: migration creates all core tables and constraints.

- [ ] **Step 6: Run integration tests**

```bash
pnpm test:integration
```

Expected: PASS including stale-sequence rejection and foreign-key tests.

- [ ] **Step 7: Commit**

```bash
git add packages/db drizzle
git commit -m "feat: persist workspace graph and event sequence"
```

---

### Task 4: Command Service, Event Log, Snapshots, and Workspace API

**Files:**
- Create: `packages/core/src/commands.ts`
- Create: `packages/db/src/services/commandService.ts`
- Create: `packages/db/src/services/snapshotService.ts`
- Create: `apps/web/src/app/api/workspaces/route.ts`
- Create: `apps/web/src/app/api/workspaces/[workspaceId]/route.ts`
- Create: `apps/web/src/app/api/workspaces/[workspaceId]/commands/route.ts`
- Create: `apps/web/src/app/api/workspaces/[workspaceId]/events/route.ts`
- Test: `packages/db/src/__tests__/commandService.integration.test.ts`
- Test: `apps/web/src/app/api/workspaces/__tests__/routes.test.ts`

**Interfaces:**
- Produces: `CommandEnvelope`, `CommandResult`, `executeCommand()`.
- HTTP: create/load workspace, submit command, fetch events after sequence.

- [ ] **Step 1: Define command envelope**

```ts
export interface CommandEnvelope<TPayload = unknown> {
  id: string;
  workspaceId: string;
  type: string;
  expectedSequence: number;
  actor: { type: 'user' | 'ai' | 'system'; id: string | null };
  payload: TPayload;
}

export interface CommandResult {
  workspaceSequence: number;
  emittedEvents: WorkspaceEvent[];
  affectedObjectIds: string[];
  inverseCommand: CommandEnvelope | null;
}
```

- [ ] **Step 2: Write failing command tests**

Cover:

- `CreateObjectCommand` creates object + revision + event atomically.
- `MoveObjectsCommand` emits one event for a multi-object move.
- Duplicate command ID returns the original result rather than applying twice.
- Stale sequence returns HTTP 409.

- [ ] **Step 3: Implement command handlers**

Create a registry:

```ts
const handlers: Record<string, CommandHandler> = {
  'object.create': handleCreateObject,
  'objects.move': handleMoveObjects,
  'anchor.create': handleCreateTextAnchor,
  'branch.create': handleCreateBranch,
  'branch.state-change': handleBranchStateChange,
  'card.create': handleCreateCard,
  'integration.apply': handleApplyIntegration,
  'metabolism.apply': handleApplyMetabolism,
};
```

Every handler returns domain events and an inverse command. The transaction service persists state rows and events in the same transaction.

- [ ] **Step 4: Implement snapshot policy**

Create a snapshot after either condition:

- 100 accepted structural events since the last snapshot.
- User explicitly selects “Create checkpoint”.

A snapshot stores graph object IDs, current revision IDs, positions, state, and event sequence. It does not duplicate immutable revision bodies.

- [ ] **Step 5: Implement authenticated API routes**

Use one temporary development identity adapter:

```ts
export async function requireUserId(): Promise<string> {
  const userId = process.env.DEV_USER_ID;
  if (!userId) throw new Error('AuthenticationNotConfigured');
  return userId;
}
```

Every route verifies the workspace owner before reading or mutating. Replace this adapter when production authentication is chosen; do not scatter identity logic across routes.

- [ ] **Step 6: Verify API behavior**

```bash
pnpm test:integration
pnpm --filter @ai-super-canvas/web test
```

Expected: 201 create, 200 load, 409 stale sequence, 403 wrong owner, idempotent duplicate command.

- [ ] **Step 7: Commit**

```bash
git add packages/core packages/db apps/web/src/app/api
git commit -m "feat: execute workspace commands with event history"
```

---

### Task 5: Unified Canvas Adapter and Focus Projection UI

**Files:**
- Create: `apps/web/src/features/canvas/CanvasAdapter.ts`
- Create: `apps/web/src/features/canvas/ReactFlowCanvas.tsx`
- Create: `apps/web/src/features/canvas/nodeTypes.ts`
- Create: `apps/web/src/features/canvas/edgeTypes.ts`
- Create: `apps/web/src/features/canvas/layout/layout.worker.ts`
- Create: `apps/web/src/features/canvas/layout/useAutoLayout.ts`
- Create: `apps/web/src/features/workspace/useWorkspaceStore.ts`
- Create: `apps/web/src/features/workspace/WorkspaceShell.tsx`
- Create: `apps/web/src/app/workspace/[workspaceId]/page.tsx`
- Test: `apps/web/src/features/canvas/__tests__/ReactFlowCanvas.test.tsx`

**Interfaces:**
- Consumes: `WorkspaceGraph`, `FocusProjection`, workspace APIs.
- Produces: `CanvasAdapter`, selected object state, move Commands, focus switch.

- [ ] **Step 1: Write failing projection tests**

Verify that switching `growth → history`:

- does not change object count or IDs;
- changes visible edge set and Inspector sections;
- preserves selection when selected object remains visible;
- clears selection only when the projection hides the object.

- [ ] **Step 2: Implement `CanvasAdapter`**

```ts
export interface CanvasAdapter {
  project(graph: WorkspaceGraph, focus: FocusMode): CanvasProjection;
  fitToSelection(objectIds: string[]): void;
  focusObject(objectId: string): void;
  exportViewport(): Promise<Blob>;
}
```

`CanvasProjection` converts domain objects into React Flow nodes and edges. Store renderer-specific data only in UI state.

- [ ] **Step 3: Implement `WorkspaceShell`**

Layout:

```text
TopBar
MainlinePane | CanvasViewport | InspectorPane
CardTimelineDrawer
```

Rules:

- Canvas minimum width is 55vw.
- Inspector is collapsed until selection or Proposal exists.
- Bottom drawer defaults to 48px collapsed height.
- Focus mode is a segmented control that changes projection without navigation.

- [ ] **Step 4: Implement object moves as one command**

On drag stop, batch all changed positions into a single `objects.move` command with current `expectedSequence`. Do not persist every pointer-move frame.

- [ ] **Step 5: Add ELK worker**

The worker receives only IDs, dimensions, and graph relationships and returns positions. It must never receive React components or full revision bodies.

- [ ] **Step 6: Verify canvas behavior**

```bash
pnpm --filter @ai-super-canvas/web test -- ReactFlowCanvas
pnpm --filter @ai-super-canvas/web typecheck
```

Expected: PASS; moving a node sends one command; focus switch does not duplicate domain objects.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/canvas apps/web/src/features/workspace apps/web/src/app/workspace
git commit -m "feat: render unified workspace through canvas adapter"
```

---

### Task 6: Rich Text Trunk Node and Stable Semantic Anchors

**Files:**
- Create: `apps/web/src/features/text/RichTextNode.tsx`
- Create: `apps/web/src/features/text/editorExtensions.ts`
- Create: `apps/web/src/features/anchors/AnchorFloatingMenu.tsx`
- Create: `apps/web/src/features/anchors/anchorSelection.ts`
- Create: `apps/web/src/features/anchors/reanchor.ts`
- Create: `apps/web/src/features/anchors/AnchorInspector.tsx`
- Test: `apps/web/src/features/anchors/__tests__/reanchor.test.ts`
- Test: `apps/web/src/features/anchors/__tests__/AnchorFloatingMenu.test.tsx`
- E2E: `apps/web/e2e/semantic-anchor.spec.ts`

**Interfaces:**
- Produces: `captureTextAnchor(editorState, selection)`, `reanchor(selector, newText)`.
- Produces Command: `anchor.create`.

- [ ] **Step 1: Write re-anchor tests**

```ts
it('uses the original position when exact text still matches', () => {
  const result = reanchor(selector, 'alpha beta gamma');
  expect(result).toEqual({ status: 'resolved', start: 6, end: 10 });
});

it('falls back to exact/prefix/suffix after text insertion', () => {
  const result = reanchor(selector, 'new alpha beta gamma');
  expect(result.status).toBe('resolved');
});

it('returns orphaned when the quote is ambiguous', () => {
  const result = reanchor(selectorWithNoContext, 'beta beta');
  expect(result).toEqual({ status: 'orphaned', candidates: [0, 5] });
});
```

- [ ] **Step 2: Implement edit-mode interaction contract**

- Double click or Enter enters rich-text edit mode.
- While editing, node dragging is disabled.
- Escape exits edit mode without destroying current text.
- Selection from 1 or more characters opens the floating anchor menu.
- Empty selection closes the menu.
- `prefers-reduced-motion` removes branch-growth animation but preserves relation highlight.

- [ ] **Step 3: Capture anchor selector**

`captureTextAnchor()` reads the current immutable revision ID, character offsets, exact text, 32-character prefix/suffix, and source content hash. It sends `anchor.create`; the client never invents the persisted anchor ID.

- [ ] **Step 4: Implement orphan handling**

When the latest revision cannot uniquely resolve an old selector:

- show an “Anchor needs review” badge;
- keep link to original immutable revision;
- provide “Open original” and “Retarget” actions;
- never silently choose the first match.

- [ ] **Step 5: Run unit and E2E tests**

```bash
pnpm --filter @ai-super-canvas/web test -- anchors
pnpm exec playwright test semantic-anchor.spec.ts
```

Expected: word, sentence, and paragraph anchors work; ambiguous selectors show orphaned state.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/text apps/web/src/features/anchors apps/web/e2e
git commit -m "feat: create stable semantic anchors from rich text"
```

---

### Task 7: Branch Creation, Source Trace, and Independent Conversation

**Files:**
- Create: `apps/web/src/features/branches/BranchNode.tsx`
- Create: `apps/web/src/features/branches/BranchInspector.tsx`
- Create: `apps/web/src/features/branches/CreateBranchAction.tsx`
- Create: `apps/web/src/features/conversation/ConversationPanel.tsx`
- Create: `apps/web/src/features/conversation/contextBuilder.ts`
- Create: `packages/db/src/services/branchService.ts`
- Test: `packages/db/src/__tests__/branchService.integration.test.ts`
- E2E: `apps/web/e2e/branch-growth.spec.ts`

**Interfaces:**
- Consumes: `anchor.create`, source revision, `branch.create` command.
- Produces: Branch object, derives edge, branch conversation context.

- [ ] **Step 1: Write branch service tests**

Verify:

- branch creation fails if anchor belongs to another workspace;
- branch stores source anchor and source revision;
- one `derives` edge connects source object to branch;
- branch initial state is `active`;
- transaction emits `branch.created` after `object.created`.

- [ ] **Step 2: Implement branch context builder**

```ts
export interface BranchContext {
  workspaceGoal: string;
  sourceQuote: string;
  sourcePrefix: string;
  sourceSuffix: string;
  sourceRevisionContent: unknown;
  acceptedCards: Array<{ title: string; content: string }>;
  branchMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
}
```

The default context must not include unrelated sibling branches. Users can explicitly reference additional objects later.

- [ ] **Step 3: Implement branch growth interaction**

Anchor menu action “生成分支”:

1. Opens a title preview populated from the selected quote.
2. User confirms or edits title.
3. Sends one `branch.create` command.
4. On success, highlights source anchor, derives edge, and new BranchNode.
5. Opens Branch Inspector / ConversationPanel.

- [ ] **Step 4: Implement source trace UI**

Every BranchNode and Branch Inspector shows:

- exact source quote;
- source object title;
- source revision timestamp;
- “定位来源” action;
- orphaned warning if latest text no longer resolves.

- [ ] **Step 5: Run tests**

```bash
pnpm test:integration -- branchService
pnpm exec playwright test branch-growth.spec.ts
```

Expected: branch grows from exact source; unrelated branch content is excluded from context.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/branches apps/web/src/features/conversation packages/db/src/services
git commit -m "feat: grow traceable branches from semantic anchors"
```

---

### Task 8: AI Provider Adapter, SSE Runs, and Typed Proposals

**Files:**
- Create: `packages/ai/src/provider.ts`
- Create: `packages/ai/src/openaiProvider.ts`
- Create: `packages/ai/src/schemas.ts`
- Create: `packages/ai/src/prompts.ts`
- Create: `packages/ai/src/index.ts`
- Create: `packages/db/src/services/aiRunService.ts`
- Create: `apps/web/src/app/api/ai/runs/route.ts`
- Create: `apps/web/src/app/api/ai/runs/[runId]/stream/route.ts`
- Create: `apps/web/src/app/api/ai/runs/[runId]/cancel/route.ts`
- Create: `apps/web/src/features/ai/AiRunPanel.tsx`
- Test: `packages/ai/src/__tests__/provider.contract.test.ts`
- Test: `packages/db/src/__tests__/aiRunService.integration.test.ts`

**Interfaces:**
- Produces: `AiProvider.startRun()`, `AiProvider.cancelRun()`, `ProposalEnvelope`.
- SSE events: `run.started`, `text.delta`, `proposal.ready`, `run.completed`, `run.failed`, `run.cancelled`.

- [ ] **Step 1: Define provider contract**

```ts
export interface AiRunRequest {
  workspaceId: string;
  branchId: string;
  inputRevisionIds: string[];
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  requestedProposal: 'branch-expansion' | 'card' | 'integration' | 'metabolism';
}

export interface AiProvider {
  startRun(request: AiRunRequest): Promise<{
    runId: string;
    stream: AsyncIterable<AiStreamEvent>;
  }>;
  cancelRun(runId: string): Promise<void>;
}
```

- [ ] **Step 2: Define strict proposal schemas**

Use Zod discriminated unions. Reject additional unknown keys. `IntegrationProposal` must include `targetRevisionId`; `MetabolismProposal` must include `kind` and `nutrients`.

- [ ] **Step 3: Write provider contract tests with a fake provider**

Tests must verify event order, cancellation, malformed structured output rejection, and no persistent workspace mutation before Proposal acceptance.

- [ ] **Step 4: Implement OpenAI Responses adapter**

Requirements:

- Server-only API key.
- SSE stream batches `text.delta` at 50–100ms.
- Final structured output validates against the Zod schema.
- Record model, prompt version, input revision IDs, token usage, latency, and terminal status.
- Cancel endpoint aborts the provider request and records `ai-run.cancelled`.

- [ ] **Step 5: Implement visible AI state**

The UI must display exactly these states:

```text
queued → running → awaiting-confirmation → applied
                    ↘ rejected
queued/running → cancelled
queued/running → failed
```

Failed and cancelled runs do not create Cards or modify graph objects.

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @ai-super-canvas/ai test
pnpm test:integration -- aiRunService
```

Expected: contract tests pass; cancellation stops stream; invalid Proposal is visible as failed rather than persisted.

- [ ] **Step 7: Commit**

```bash
git add packages/ai packages/db/src/services/aiRunService.ts apps/web/src/app/api/ai apps/web/src/features/ai
git commit -m "feat: stream typed ai proposals without direct mutations"
```

---

### Task 9: Conclusion Cards and Safe Feedback Integration

**Files:**
- Create: `apps/web/src/features/cards/ConclusionCardNode.tsx`
- Create: `apps/web/src/features/cards/CardDrawer.tsx`
- Create: `apps/web/src/features/integration/IntegrationPreview.tsx`
- Create: `apps/web/src/features/integration/RevisionDiff.tsx`
- Create: `packages/db/src/services/cardService.ts`
- Create: `packages/db/src/services/integrationService.ts`
- Test: `packages/db/src/__tests__/integrationService.integration.test.ts`
- E2E: `apps/web/e2e/feedback-integration.spec.ts`

**Interfaces:**
- Consumes: Card Proposal, Integration Proposal, `card.create`, `integration.apply`.
- Produces: immutable trunk revision, `feeds-back-to` edge, timeline events, inverse command.

- [ ] **Step 1: Write stale proposal tests**

Sequence:

1. Create Integration Proposal targeting `rev_1`.
2. User edits trunk, creating `rev_2`.
3. Accept old Proposal.
4. Expect `ProposalExpired` and no trunk change.

Also test successful append, replace-section, and create-linked-card operations.

- [ ] **Step 2: Implement Card acceptance**

A Card Proposal remains in Inspector until user chooses:

- Accept as Conclusion Card.
- Edit then accept.
- Reject.

Accepted Card records source branch, source AI run, author, and current revision.

- [ ] **Step 3: Implement feedback preview**

`IntegrationPreview` must show:

- source branch/card;
- target trunk revision;
- operation type;
- before/after content diff;
- relationships to create;
- AI rationale;
- stale warning.

Accept button is disabled with an explicit reason when stale or invalid.

- [ ] **Step 4: Apply integration transaction**

In one transaction:

1. lock Workspace sequence;
2. verify target current revision equals proposal target revision;
3. create new target revision;
4. update target current revision pointer;
5. create `feeds-back-to` edge;
6. mark proposal accepted;
7. emit `revision.created`, `integration.applied`, and optional `branch.state-changed`;
8. return inverse command pointing back to prior revision.

- [ ] **Step 5: Run E2E**

```bash
pnpm test:integration -- integrationService
pnpm exec playwright test feedback-integration.spec.ts
```

Expected: user sees Diff, stale proposals cannot apply, accepted feedback updates trunk and is undoable.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/cards apps/web/src/features/integration packages/db/src/services
git commit -m "feat: preview and safely integrate branch conclusions"
```

---

### Task 10: Metabolism, Branch State, and Growth Timeline

**Files:**
- Create: `apps/web/src/features/metabolism/MetabolismDialog.tsx`
- Create: `apps/web/src/features/metabolism/MetabolismBadge.tsx`
- Create: `apps/web/src/features/timeline/GrowthTimeline.tsx`
- Create: `apps/web/src/features/timeline/eventPresenters.ts`
- Create: `packages/db/src/services/metabolismService.ts`
- Create: `packages/db/src/services/timelineService.ts`
- Test: `packages/db/src/__tests__/metabolismService.integration.test.ts`
- E2E: `apps/web/e2e/metabolism-timeline.spec.ts`

**Interfaces:**
- Consumes: `branch.state-change`, `metabolism.apply`.
- Produces: `MetabolismRecord`, optional nutrient Card, timeline projection.

- [ ] **Step 1: Write state transition and metabolism tests**

Cover every allowed and forbidden transition. Add exact assertions:

- `humify` rejects empty nutrients.
- `prune` permits no nutrient card.
- `metabolized` branch cannot return active.
- inverse command restores prior branch state and removes only artifacts created by that metabolism command.

- [ ] **Step 2: Implement metabolism dialog**

Options and required fields:

| Kind | Required Input | Result |
|---|---|---|
| prune | reason | branch hidden from active growth projection |
| decay | reason | branch remains in timeline with expired label |
| humify | reason + one or more nutrients | creates nutrient/experience Card and `metabolizes-into` edge |
| archive | reason | complete branch available in history focus |

The UI explains that metabolism is reversible through undo but not through an invalid state transition.

- [ ] **Step 3: Implement event presenters**

Every domain event has a deterministic human-readable presenter. Unknown events render a safe generic entry with type, time, and aggregate ID rather than disappearing.

- [ ] **Step 4: Implement Growth Timeline**

Features:

- ordered by workspace sequence;
- filter by branch/object/event category;
- clicking an entry focuses affected object;
- integration entries open Diff;
- metabolism entries show retained nutrients;
- AI entries show status and referenced revisions, not secret prompt contents.

- [ ] **Step 5: Run tests**

```bash
pnpm test:integration -- metabolismService
pnpm exec playwright test metabolism-timeline.spec.ts
```

Expected: humification creates a traceable nutrient card; timeline reproduces the Golden Path in sequence.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/metabolism apps/web/src/features/timeline packages/db/src/services
git commit -m "feat: metabolize branches and expose growth timeline"
```

---

### Task 11: Undo/Redo, IndexedDB Recovery, Performance, and Accessibility

**Files:**
- Create: `apps/web/src/features/history/commandHistory.ts`
- Create: `apps/web/src/features/history/useUndoRedo.ts`
- Create: `apps/web/src/features/offline/workspaceCache.ts`
- Create: `apps/web/src/features/offline/useRecovery.ts`
- Create: `apps/web/src/features/a11y/keyboardNavigation.ts`
- Create: `apps/web/src/styles/motion.css`
- Test: `apps/web/src/features/history/__tests__/commandHistory.test.ts`
- Test: `apps/web/src/features/offline/__tests__/workspaceCache.test.ts`
- E2E: `apps/web/e2e/recovery-accessibility.spec.ts`
- E2E: `apps/web/e2e/performance-budget.spec.ts`

**Interfaces:**
- Consumes: accepted command results and inverse commands.
- Produces: undo/redo controls, local recovery snapshot, keyboard navigation.

- [ ] **Step 1: Write history tests**

Verify:

- only accepted structural commands enter history;
- text keystrokes are coalesced after 800ms idle;
- undo sends the persisted inverse command with current sequence;
- new command after undo clears redo stack;
- stale inverse command displays conflict and never silently overwrites.

- [ ] **Step 2: Implement IndexedDB cache**

Cache exactly:

- workspace ID and last server sequence;
- latest materialized graph projection;
- unsent command envelopes;
- open selection/focus mode UI session.

Do not cache API keys, full AI system prompts, or authentication secrets.

Recovery flow:

1. load local skeleton immediately;
2. fetch server events after local sequence;
3. reconcile acknowledged commands by command ID;
4. show a recovery dialog for unsent commands;
5. never auto-replay a stale structural command without user confirmation.

- [ ] **Step 3: Add keyboard and accessibility behavior**

Required shortcuts:

```text
Cmd/Ctrl+Z           Undo
Cmd/Ctrl+Shift+Z     Redo
Enter                Edit/open selected object
Escape               Exit edit mode, then close inspector, then clear selection
Tab / Shift+Tab      Navigate visible objects
Delete/Backspace     Open metabolism confirmation, never hard-delete immediately
```

Run `axe` via Playwright for the Workspace Golden Path page.

- [ ] **Step 4: Add performance scenario**

Generate a deterministic fixture with 200 objects and 260 edges. The Playwright test records:

- time from navigation to interactive canvas;
- anchor menu response after selection;
- maximum long task count during 10 pan/zoom operations;
- main-thread blocking during ELK layout.

Fail thresholds:

```text
interactive skeleton > 2000ms
anchor menu > 100ms
ELK main-thread task > 50ms
continuous pan/zoom long tasks > 5
```

- [ ] **Step 5: Verify quality gates**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/history apps/web/src/features/offline apps/web/src/features/a11y apps/web/src/styles apps/web/e2e
git commit -m "feat: add recovery undo accessibility and performance gates"
```

---

### Task 12: Golden Path Release Gate and Private-Alpha Deployment

**Files:**
- Create: `apps/web/e2e/golden-path.spec.ts`
- Create: `apps/web/Dockerfile`
- Create: `docs/operations/local-development.md`
- Create: `docs/operations/private-alpha-deployment.md`
- Create: `docs/operations/backup-and-restore.md`
- Create: `docs/product/feature-01-user-acceptance.md`
- Modify: `docker-compose.yml`
- Modify: `README.md`

**Interfaces:**
- Produces: reproducible deployment, release checklist, backup/restore procedure.

- [ ] **Step 1: Implement the complete Golden Path E2E**

The test must execute, in order:

1. create Workspace;
2. enter trunk question;
3. select the word “腐殖化”;
4. create anchor;
5. grow branch;
6. send branch message;
7. receive fake-provider stream;
8. accept Conclusion Card;
9. preview and apply feedback;
10. humify branch with nutrient summary;
11. inspect timeline entries;
12. undo humification;
13. redo humification;
14. reload browser and verify state survives.

Use a deterministic fake AI provider in E2E. Run one separate smoke test against the configured real provider only when `RUN_REAL_AI_SMOKE=1`.

- [ ] **Step 2: Add failure-path E2E cases**

Required cases:

- cancel AI stream;
- provider failure;
- malformed Proposal;
- stale Integration Proposal;
- orphaned anchor;
- offline command recovery;
- unauthorized Workspace access;
- database restart during read-only browsing.

- [ ] **Step 3: Create production container**

Use a multi-stage Next.js standalone build. Run as a non-root user. Health endpoint verifies web process and database connectivity without exposing secrets.

Update Compose with `web`, `postgres`, persistent volumes, and explicit environment variable names.

- [ ] **Step 4: Document operations**

`local-development.md` includes exact setup commands.

`private-alpha-deployment.md` includes:

- environment variables;
- TLS reverse proxy expectation;
- database migration command;
- health check;
- rollback to prior image;
- log locations;
- first-user bootstrap.

`backup-and-restore.md` includes tested `pg_dump` and `pg_restore` commands and a quarterly restore drill procedure.

- [ ] **Step 5: Conduct release review**

Review checklist:

```text
[ ] One workspace, no duplicated focus-mode data
[ ] Anchor references immutable revision
[ ] AI cannot mutate graph before Proposal acceptance
[ ] Stale Proposal cannot apply
[ ] Integration is undoable
[ ] Humification retains nutrients and source trace
[ ] Timeline sequence matches events
[ ] Reload and recovery preserve state
[ ] Unauthorized access returns 403/404 without data leak
[ ] Keyboard and reduced-motion flows work
[ ] Performance fixture stays within budgets
[ ] Backup and restore are tested
```

- [ ] **Step 6: Run final verification**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
docker compose build web
docker compose up -d
curl --fail http://localhost:3000/api/health
```

Expected: every command exits 0; health endpoint returns HTTP 200.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "release: prepare feature 01 private alpha"
```

---

## Implementation Review Protocol

Each task is reviewed twice before the next task starts.

### Review A — Requirements and Domain Integrity

Reviewer checks:

- exact stable product principle implemented;
- no focus-mode data duplication;
- immutable revision and anchor invariants preserved;
- AI mutation boundary preserved;
- state transition legal;
- events and inverse command complete.

### Review B — Code, Tests, and Operations

Reviewer checks:

- focused files and interfaces;
- no hidden SDK coupling in domain package;
- failing test existed before implementation;
- integration tests use real PostgreSQL;
- user-visible errors explain disabled/failed actions;
- performance and accessibility implications addressed;
- commit is independently revertible.

Review findings are recorded in the PR under headings `Domain Review` and `Engineering Review`. A task cannot merge with unresolved critical or high-severity findings.

## Recommended Branch and PR Strategy

```text
main
└─ feat/feature-01-mvp
   ├─ task/01-scaffold
   ├─ task/02-domain
   ├─ task/03-persistence
   ├─ ...
   └─ task/12-alpha-release
```

Preferred execution:

- one fresh subagent / engineer context per task;
- one commit per independently testable deliverable;
- merge task branches into `feat/feature-01-mvp` only after both reviews;
- open one draft PR from `feat/feature-01-mvp` to `main` throughout development;
- convert to ready only after Gate D.

## Plan Self-Review

### 1. Spec Coverage

- Unified workspace and focus projections: Tasks 2, 5.
- Semantic objects and stable anchors: Tasks 2, 6.
- Branch growth and independent context: Task 7.
- Visible/cancellable AI proposals: Task 8.
- Conclusion cards and feedback: Task 9.
- Metabolism and timeline: Task 10.
- Undo/recovery/history separation: Tasks 4, 10, 11.
- Performance/accessibility/security/deployment: Tasks 4, 8, 11, 12.

No stable Feature 01 requirement lacks an implementation task.

### 2. Placeholder Scan

The plan contains no `TBD`, `TODO`, “implement later”, or unspecified error-handling instruction. Future capabilities are explicitly out of scope rather than left ambiguous.

### 3. Type and Interface Consistency

- `WorkspaceGraph`, IDs, revisions, anchors, branch states, proposals, commands, and events originate in `@ai-super-canvas/core`.
- All persistence services use the same Workspace event sequence.
- `IntegrationProposal.targetRevisionId` is verified by `integrationService`.
- Canvas renderer types never enter core or database schemas.
- AI provider returns `ProposalEnvelope`; only Command handlers mutate state.

### 4. Scope Check

The plan builds one vertical slice only. Creative generation, image anchors, realtime collaboration, Agent orchestration, and global knowledge systems are intentionally excluded. This scope is suitable for one implementation program and produces testable private-alpha software.

### 5. Adversarial Review Fixes Applied

- Reduced branch states from eight to five top-level states.
- Replaced giant workspace JSON persistence with normalized rows + events + snapshots.
- Added Proposal expiry when target revision changes.
- Added orphaned-anchor state instead of silent reattachment.
- Added fake-provider E2E to avoid nondeterministic CI and cost.
- Added renderer adapter to avoid React Flow lock-in.
- Added commercial-license risk isolation for possible tldraw adoption.
- Added explicit failure, recovery, security, performance, and backup gates.
