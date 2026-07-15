# 结构化生长画布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 Gate 0 替换为可直接使用的结构化生长无限画布，同时保持本地持久化的主干、分支、成果回写闭环。

**Architecture:** 保留 `packages/core` 作为不可变领域命令和本地真源；新增纯 `GrowthProjection` 将领域对象投影为节点、边和默认位置。Next.js 页面保持 Server Component，浏览器交互收敛在 `WorkspaceCanvas` Client Component；画布选择、视口和拖动覆盖不写回领域状态。

**Tech Stack:** Next.js 16、React 19、TypeScript、Vitest、现有 localStorage 适配器、CSS 原生画布投影。

---

### Task 1: Growth projection

**Files:**
- Create: `packages/core/src/growth-projection.ts`
- Create: `packages/core/src/growth-projection.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing projection tests**

```ts
expect(projectGrowth(createDemoWorkspace()).nodes).toEqual(
  expect.arrayContaining([expect.objectContaining({ kind: 'trunk' })]),
);
expect(projectGrowth(workspace).edges).toContainEqual(
  expect.objectContaining({ kind: 'derives' }),
);
```

- [ ] **Step 2: Run `corepack pnpm test packages/core/src/growth-projection.test.ts` and verify failure because the module does not exist.**

- [ ] **Step 3: Implement pure projection with deterministic left-to-right positions, derives edges, feedback edges and metabolism cards.**

- [ ] **Step 4: Re-run the focused test and `corepack pnpm test`; verify both pass.**

### Task 2: Canvas interaction contract

**Files:**
- Create: `apps/web/src/components/workspace-canvas.test.tsx`
- Modify: `apps/web/src/components/workspace-prototype.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: Write failing tests for selecting a projected branch, showing a context Composer target, and rendering a ready outcome as a confirmation card.**

- [ ] **Step 2: Run the focused test and verify failure because the canvas component does not exist.**

- [ ] **Step 3: Replace the fixed panel layout with a Canvas shell, node renderers, Inspector and Composer. Preserve localStorage persistence and existing core commands.**

- [ ] **Step 4: Re-run component and whole-suite tests; verify they pass.**

### Task 3: Direct manipulation and lifecycle

**Files:**
- Modify: `apps/web/src/components/workspace-prototype.tsx`
- Modify: `apps/web/src/app/globals.css`
- Test: `apps/web/src/components/workspace-canvas.test.tsx`

- [ ] **Step 1: Write failing tests for text-selection branch creation, explicit integration and dormant/metabolized visibility.**
- [ ] **Step 2: Verify the focused test fails for missing behaviour.**
- [ ] **Step 3: Add selection action, node drag offsets, pan/zoom controls, Diff confirmation and lifecycle transitions.**
- [ ] **Step 4: Verify focused tests, `corepack pnpm typecheck`, `corepack pnpm lint` and `corepack pnpm test` all pass.**

### Task 4: Runtime verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-15-structured-growth-canvas-design.md` only if acceptance evidence uncovers an ambiguity.

- [ ] **Step 1: Build the workspace with `corepack pnpm build`.**
- [ ] **Step 2: Restart the existing loopback deployment through its Docker Compose/systemd entrypoint without changing the registered port.**
- [ ] **Step 3: Verify HTTP health, the rendered page, the Golden Path and refresh persistence in a real browser.**
- [ ] **Step 4: Commit the completed implementation with tests and documentation.**
