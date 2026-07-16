# Canvas Interaction and Model Catalog Implementation Plan

> 状态：Gate 0 原型交互计划。右键平移、鼠标中心缩放和块随行设置仍有效；`CanvasLayoutState.modelByNodeId` 只是原型过渡状态，正式实现必须迁移到 SessionConfigRevision/Run snapshot，见 [`runtime-adapter-contract.md`](../../architecture/runtime-adapter-contract.md)。

> 本文是实施计划而不是完成报告；未勾选任务、`Expected: PASS` 和示例命令都不能证明功能已开发或部署，实际状态以提交、测试和运行证据为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people pan the growth canvas with the right mouse button, operate each node from a panel that moves with it, recognize branch anchors as distinct growth points, and choose a configured model per node.

**Architecture:** Keep interaction-only state in `CanvasLayoutState`, persisted in browser storage independently from the domain workspace. Parse the public model catalog once on the server from the Compose-provided environment and pass only model names to the client; keys never cross the server/client boundary. Render the node panel inside the transformed canvas plane so it inherits every node's viewport movement and zoom.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Playwright, Docker Compose.

---

### Task 1: Test and add canvas interaction state

**Files:**
- Modify: `apps/web/src/components/canvas-state.ts`
- Modify: `apps/web/src/components/canvas-state.test.ts`

- [ ] **Step 1: Write failing state tests**

```ts
expect(panCanvas(initialCanvasLayout(), { x: 96, y: -28 }).viewport).toMatchObject({ x: 96, y: -28 });
expect(setCanvasNodeModel(initialCanvasLayout(), 'branch-1', 'gpt-5-mini').modelByNodeId).toEqual({ 'branch-1': 'gpt-5-mini' });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run apps/web/src/components/canvas-state.test.ts`

Expected: failure because `panCanvas` and `setCanvasNodeModel` are not exported.

- [ ] **Step 3: Implement immutable pan and per-node model helpers**

```ts
export function panCanvas(state: CanvasLayoutState, delta: { x: number; y: number }): CanvasLayoutState {
  return { ...state, viewport: { ...state.viewport, x: state.viewport.x + delta.x, y: state.viewport.y + delta.y } };
}

export function setCanvasNodeModel(state: CanvasLayoutState, nodeId: string, model: string): CanvasLayoutState {
  return { ...state, modelByNodeId: { ...state.modelByNodeId, [nodeId]: model } };
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm vitest run apps/web/src/components/canvas-state.test.ts`

Expected: PASS.

### Task 2: Test and add the unified model catalog

**Files:**
- Modify: `packages/ai/src/index.ts`
- Create: `packages/ai/src/index.test.ts`
- Modify: `apps/web/src/app/page.tsx`
- Modify: `.env.example`
- Modify: `compose.yaml`

- [ ] **Step 1: Write failing parser tests**

```ts
expect(getModelCatalog({ AI_AVAILABLE_MODELS: 'gpt-5, deepseek-chat', AI_DEFAULT_MODEL: 'deepseek-chat' })).toEqual({
  models: ['gpt-5', 'deepseek-chat'],
  defaultModel: 'deepseek-chat',
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run packages/ai/src/index.test.ts`

Expected: failure because `getModelCatalog` is not exported.

- [ ] **Step 3: Implement server-safe catalog parsing and server-page injection**

```ts
export function getModelCatalog(environment: NodeJS.ProcessEnv = process.env): ModelCatalog { /* trim CSV, fall back safely */ }
// page.tsx: <WorkspacePrototype modelCatalog={getModelCatalog()} />
```

- [ ] **Step 4: Document and forward one config source**

```dotenv
AI_AVAILABLE_MODELS=gpt-5,gpt-5-mini,deepseek-chat
AI_DEFAULT_MODEL=gpt-5
```

Pass both values through the app service in `compose.yaml`; do not expose API keys to the browser.

- [ ] **Step 5: Run the focused test and verify it passes**

Run: `pnpm vitest run packages/ai/src/index.test.ts`

Expected: PASS.

### Task 3: Render the block-following controls and anchor growth tokens

**Files:**
- Modify: `apps/web/src/components/workspace-prototype.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: Replace the fixed inspector with a selected-node panel inside `canvas-plane`**

```tsx
<aside className="node-popover" aria-label="节点设置" style={{ transform: `translate(${popoverX}px, ${popoverY}px)` }}>
  <label>模型<select value={nodeModel} onChange={changeModel}>{modelCatalog.models.map((model) => <option key={model}>{model}</option>)}</select></label>
</aside>
```

- [ ] **Step 2: Keep a short right-click as a menu, and make long-press-plus-drag pan**

```tsx
onPointerDown={(event) => {
  if (event.button !== 2) return;
  setPan({
    pointerStartX: event.clientX,
    pointerStartY: event.clientY,
    baseViewportX: layout.viewport.x,
    baseViewportY: layout.viewport.y,
    startedAt: event.timeStamp,
  });
}}
// After 260ms, derive each viewport from the fixed gesture origin and current pointer.
// Releasing before the threshold selects the node and opens its menu.
```

`pointermove` 不得基于上一次 render 的 `lastX/lastY` 做增量累加，否则连续事件可能复用陈旧状态；应始终使用 `baseViewport + currentPointer - pointerStart`。

- [ ] **Step 3: Render the current revision anchors as growth-point tokens in the trunk node**

```tsx
<div className="anchor-rail" aria-label="主干生长点">
  <span className="anchor-token"><i />锚点 · “{anchor.selector.exact}”</span>
</div>
```

- [ ] **Step 4: Style the popover, pan cursor, and anchor tokens**

The popover uses absolute positioning within the canvas plane; it follows the plane transform and therefore the selected block. Anchor tokens use a green bud marker, a separate surface, and a quoted source representation.

### Task 4: Prove the user path and deploy

**Files:**
- Modify: `tests/e2e/structured-growth-canvas.spec.ts`

- [ ] **Step 1: Add browser assertions**

```ts
await page.mouse.down({ button: 'right' });
await page.waitForTimeout(280);
await page.mouse.move(1330, 650);
await page.mouse.up({ button: 'right' });
await expect(page.getByTestId('canvas-plane')).not.toHaveAttribute('style', /translate\(0px, 0px\)/);
await expect(page.getByLabel('节点设置')).toBeVisible();
await expect(page.getByLabel('主干生长点')).toBeVisible();
```

- [ ] **Step 2: Run all verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e`

Expected: all commands pass.

- [ ] **Step 3: Rebuild and restart the existing service**

Run: `systemctl --user restart ai-super-canvas.service && curl --fail http://127.0.0.1:3000/api/health`

Expected: service is active and health endpoint returns HTTP 200.
