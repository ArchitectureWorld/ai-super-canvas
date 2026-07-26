# PostgreSQL Control Plane Test Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a genuinely new `/control-plane-test` browser surface that creates and restores PostgreSQL-backed Sessions, starts deterministic Runs, and explains recovery states without changing the existing `/` canvas.

**Architecture:** A Server Component renders one isolated Client Component. The browser calls only the public Next.js control-plane routes, short-polls persisted JSON events, and always renders conversation history from the transcript endpoint. `localStorage` stores only the last `sessionId` and pending idempotency identifiers; messages, events, actor identity, model policy, and Runtime references remain server-owned.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, CSS Modules, PostgreSQL-backed control-plane APIs, DeterministicFakeRuntime, Playwright 1.61, Vitest 4, Docker.

---

## Scope and hard boundaries

- Create an independent `/control-plane-test`; do not add a link or button to `/`, import `WorkspacePrototype`, or change the old canvas state.
- Do not add a port, service, environment variable, schema migration, provider, SSE endpoint, direct Repository call, or direct Runtime call.
- Every browser POST uses same-origin `application/json`.
- ActorContext, account IDs, auth subject, model choice, binding policy, and tool policy never enter browser request bodies.
- Event reads consume `{ events, nextAfter, terminal }` JSON. They never parse SSE frames.
- Transcript fields use `messageId` and `runtimeAvailability`; the removed draft fields `id`, `runtimeAvailable`, `runtimeRef`, and `state` must not be used.
- A `202` response can carry `{ error, commandReceiptId? }`. The client treats any payload with `error` as an error even when `response.ok` is true.
- Pending command IDs are cleared only after a definite success DTO. Retrying reuses the stored IDs and original Run content.
- Browser storage must not contain transcript content, Run events, assistant output, ActorContext, or external Runtime references.
- A service restart may make the old in-memory Fake Runtime Session unavailable. History must remain readable and the UI must direct the user to create a new test Session.
- Preserve the existing host port `3000`; no `/home/youran/data/service-ports` update is needed because no port setting changes.

## File map

- `apps/web/src/app/control-plane-test/page.tsx`: metadata and Server Component shell.
- `apps/web/src/app/control-plane-test/control-plane-test-client.tsx`: DTOs, request boundary, idempotent browser state machine, JSON event polling, and accessible UI.
- `apps/web/src/app/control-plane-test/control-plane-test.module.css`: isolated responsive visual system; no global selectors.
- `tests/e2e/control-plane-test.spec.ts`: new-page identity, real database journey, refresh recovery, restart semantics, narrow-screen behavior, and browser-error assertions.

### Task 1: Prove and add the isolated page shell

**Files:**
- Create: `tests/e2e/control-plane-test.spec.ts`
- Create: `apps/web/src/app/control-plane-test/page.tsx`
- Create: `apps/web/src/app/control-plane-test/control-plane-test-client.tsx`
- Create: `apps/web/src/app/control-plane-test/control-plane-test.module.css`

- [ ] **Step 1: Write the failing page-identity test**

Add this first test:

```ts
import { expect, test } from '@playwright/test';

const storagePrefix = 'ai-super-canvas.control-plane-test.';

test.beforeEach(async ({ page }) => {
  await page.goto('/control-plane-test');
  await page.evaluate((prefix) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  }, storagePrefix);
  await page.reload();
});

test('shows a new PostgreSQL-backed test surface instead of the old canvas', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '真实后端闭环' })).toBeVisible();
  await expect(page.getByText('PostgreSQL', { exact: true })).toBeVisible();
  await expect(page.getByText('DeterministicFakeRuntime', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建测试 Session' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '测试消息' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '主干活文档' })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the page test and record the intended RED**

Run:

```bash
pnpm exec playwright test tests/e2e/control-plane-test.spec.ts --project=chromium
```

Expected: FAIL because `/control-plane-test` does not yet render the heading.

- [ ] **Step 3: Add the Server Component**

`page.tsx` must export route-specific metadata and render only the client:

```tsx
import type { Metadata } from 'next';

import { ControlPlaneTestClient } from './control-plane-test-client';

export const metadata: Metadata = {
  title: '真实后端闭环 · AI Super Canvas',
  description: 'PostgreSQL 与 DeterministicFakeRuntime 的本地 Alpha 验证入口。',
};

export default function ControlPlaneTestPage() {
  return <ControlPlaneTestClient />;
}
```

- [ ] **Step 4: Add the initial accessible client shell**

Start `control-plane-test-client.tsx` with `'use client'`. Render:

- header kicker `CONTROL PLANE · LOCAL ALPHA`;
- `h1` text `真实后端闭环`;
- a plain-language sentence explaining that this page writes to PostgreSQL;
- a backend status card with exact labels `PostgreSQL` and `DeterministicFakeRuntime`;
- button `新建测试 Session`;
- transcript region labelled `PostgreSQL 会话记录`;
- textarea labelled `测试消息`;
- submit button `发送到真实后端`;
- event region labelled `已持久化 Run 事件`.

The initial status is `正在连接真实后端`. Buttons remain disabled until their prerequisites are ready.

- [ ] **Step 5: Add isolated responsive CSS**

Use only class selectors from the CSS Module. The layout is:

- full-height dark page with a restrained green radial accent;
- maximum content width `1120px`;
- two-column desktop body (`minmax(0, 1fr) 300px`) with transcript/composer on the left and status/events on the right;
- stacked layout below `760px`;
- minimum `44px` interactive height on narrow screens;
- visible `:focus-visible`, disabled, error, warning, success, and `prefers-reduced-motion` states;
- no horizontal scrolling at `390px`.

- [ ] **Step 6: Run static gates and commit**

Run:

```bash
pnpm --filter @ai-super-canvas/web lint
pnpm --filter @ai-super-canvas/web typecheck
pnpm --filter @ai-super-canvas/web build
git diff --check
```

Expected: all exit `0`, and the build route table contains `/control-plane-test`.

Commit:

```bash
git add apps/web/src/app/control-plane-test tests/e2e/control-plane-test.spec.ts
git commit -m "feat(web): add persisted control-plane test surface"
```

### Task 2: Implement the current API contract and durable retry semantics

**Files:**
- Modify: `apps/web/src/app/control-plane-test/control-plane-test-client.tsx`
- Modify: `tests/e2e/control-plane-test.spec.ts`

- [ ] **Step 1: Define the exact browser DTOs**

Use these shapes in the client:

```ts
interface BootstrapResult {
  accountId: string;
  agentId: string;
  agentBindingId: string;
  workspaceId: string;
  workflowId: string;
  trunkRevisionId: string;
}

interface SessionMessage {
  messageId: string;
  runId: string | null;
  ordinal: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  status: string;
}

interface SessionTranscript {
  sessionId: string;
  status: string;
  messages: SessionMessage[];
  activeRun: null | { runId: string; status: string };
  reconciliationState: null | {
    kind: 'run-reconciling' | 'runtime-unavailable';
    message: string;
  };
  runtimeAvailability: 'available' | 'unavailable';
}

interface RunEvent {
  sequence: number;
  eventType: string;
  payload: unknown;
  occurredAt: string;
}

interface RunEventsPage {
  events: RunEvent[];
  nextAfter: number;
  terminal: null | { status: 'succeeded' | 'failed' | 'cancelled' };
}

interface ApiErrorPayload {
  error: { code: string; message: string; retryable: boolean };
  commandReceiptId?: string;
}

interface PendingRun {
  commandId: string;
  idempotencyKey: string;
  sessionId: string;
  content: string;
}
```

- [ ] **Step 2: Implement the safe request boundary**

`jsonRequest<T>` must:

1. send `Content-Type: application/json` only when a body is present;
2. use `cache: 'no-store'`;
3. parse JSON defensively;
4. throw a typed client error whenever `payload.error` exists, including HTTP `202`;
5. throw a sanitized fallback for a non-JSON response;
6. never display server stack traces or stringify arbitrary thrown objects.

Map stable codes to plain-language recovery:

```ts
const recoveryByCode: Record<string, string> = {
  command_requires_reconciliation:
    '服务器正在确认上次操作。请稍后点“重试上次操作”，不要重复新建。',
  command_persistence_unconfirmed:
    '服务器暂时无法确认是否已保存。请稍后重试，页面会复用同一个命令编号。',
  runtime_session_unavailable:
    '历史记录还在，但旧运行环境已断开。请新建测试 Session。',
  active_run_conflict:
    '这个 Session 仍有任务在处理中，请等待当前任务结束。',
  command_payload_conflict:
    '上次操作的内容与本次不同。请新建测试 Session 后再试。',
  run_idempotency_conflict:
    '检测到不一致的重复发送。请新建测试 Session 后再试。',
  not_found:
    '找不到这条历史记录，可能已被清理。请新建测试 Session。',
  internal_error:
    '后端暂时出错。请先点“重新连接”，如果仍失败再查看服务日志。',
};
```

- [ ] **Step 3: Implement storage with pointer-only data**

Use exactly four keys:

```ts
const bootstrapCommandKey =
  'ai-super-canvas.control-plane-test.bootstrap-command';
const lastSessionKey =
  'ai-super-canvas.control-plane-test.last-session';
const pendingSessionCommandKey =
  'ai-super-canvas.control-plane-test.pending-session-command';
const pendingRunCommandKey =
  'ai-super-canvas.control-plane-test.pending-run-command';
```

Validate stored UUIDs before reuse. Invalid pointer values are removed. Parse `PendingRun`
inside `try/catch` and require four non-empty string fields; malformed data is removed.
Do not add any other storage key.

- [ ] **Step 4: Implement initialization and Session creation**

Initialization sequence:

1. `GET /api/ready`;
2. `POST /api/control-plane/bootstrap` with the stored/new UUID and display name `本地测试用户`;
3. clear the bootstrap command only after a definite success;
4. if a valid last Session exists, load its transcript;
5. on transcript `404`, remove only the stale Session pointer and show a create-Session prompt.

Session creation:

1. reuse/create `pendingSessionCommandKey`;
2. POST only `{ commandId, workflowId, agentBindingId, title }`;
3. clear the pending Session command only after `201`;
4. save only the returned `sessionId`;
5. clear displayed event labels and load the transcript.

- [ ] **Step 5: Implement idempotent Run start and JSON polling**

Run start:

1. refuse blank or over-20,000-character input;
2. reuse a valid pending Run for the current Session, including its original content;
3. otherwise persist a new `{ commandId, idempotencyKey, sessionId, content }`;
4. POST only `{ commandId, idempotencyKey, content }`;
5. clear the pending Run only after a definite `{ runId, status }` DTO;
6. poll `/api/control-plane/runs/:runId/events?after=:sequence`.

Polling:

```ts
let after = 0;
for (let attempt = 0; attempt < 80; attempt += 1) {
  const page = await jsonRequest<RunEventsPage>(
    `/api/control-plane/runs/${runId}/events?after=${after}`,
  );
  append only events whose sequence is greater than the displayed last sequence;
  after = page.nextAfter;
  await loadTranscript(sessionId);
  if (page.terminal) finish according to its status;
  await sleep(150);
}
throw a plain-language timeout error;
```

On `succeeded`, clear the composer and show `回复已写入 PostgreSQL`. On `failed` or
`cancelled`, keep the persisted transcript visible and explain the terminal state.

- [ ] **Step 6: Render recovery states**

- `runtimeAvailability === 'unavailable'`: disable sending, show `历史已恢复，但旧 Fake Runtime 已不可用。请新建测试 Session。`
- non-null `reconciliationState`: show its safe message and a warning badge.
- pending Session command: expose `重试新建 Session`.
- pending Run: expose `重试上次发送` and display its original content so the user knows what is retried.
- operation in progress: disable duplicate actions.
- unexpected client error: use `role="alert"` and keep the recovery button visible.

- [ ] **Step 7: Add mocked browser contract tests**

Use `page.route('**/api/**', ...)` to prove:

- a `202` error payload does not become success and the same pending Run IDs survive retry;
- JSON event pages advance with `nextAfter` and stop at `terminal`;
- a restored transcript uses `messageId` and `runtimeAvailability`;
- no localStorage value contains transcript text or assistant output.

Run:

```bash
pnpm exec playwright test tests/e2e/control-plane-test.spec.ts --project=chromium
```

Expected: all mocked contract tests pass without a database.

- [ ] **Step 8: Run gates and commit**

Run:

```bash
pnpm --filter @ai-super-canvas/web lint
pnpm --filter @ai-super-canvas/web typecheck
pnpm --filter @ai-super-canvas/web build
git diff --check
```

Commit:

```bash
git add apps/web/src/app/control-plane-test tests/e2e/control-plane-test.spec.ts
git commit -m "feat(web): run persisted sessions from the browser"
```

### Task 3: Prove the real beginner journey and restart truth

**Files:**
- Modify: `tests/e2e/control-plane-test.spec.ts`
- Modify: `docs/architecture/development-roadmap.md`

- [ ] **Step 1: Add the real Golden Path**

Against the real production application and PostgreSQL:

```ts
test('creates, runs, and restores a PostgreSQL-backed Session', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await expect(page.getByText('后端已就绪')).toBeVisible();
  await page.getByRole('button', { name: '新建测试 Session' }).click();
  await expect(page.getByText('Session 已连接 Fake Runtime')).toBeVisible();
  await page.getByRole('textbox', { name: '测试消息' }).fill('浏览器真实闭环');
  await page.getByRole('button', { name: '发送到真实后端' }).click();
  await expect(page.getByText('回复已写入 PostgreSQL')).toBeVisible();
  await expect(page.getByText('浏览器真实闭环', { exact: true })).toBeVisible();
  await expect(page.getByText('fake fake ', { exact: true })).toBeVisible();
  await expect(page.getByLabel('已持久化 Run 事件')).toContainText('run.completed');

  const storedSessionId = await page.evaluate(() => (
    localStorage.getItem('ai-super-canvas.control-plane-test.last-session')
  ));
  expect(storedSessionId).toMatch(/^[0-9a-f-]{36}$/i);

  await page.reload();
  await expect(page.getByText('浏览器真实闭环', { exact: true })).toBeVisible();
  await expect(page.getByText('fake fake ', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
```

- [ ] **Step 2: Add narrow-screen acceptance**

At viewport `390 × 844`, assert:

- heading, Session button, textarea, and send button are visible;
- the page has no horizontal overflow;
- the composer can be reached and used with the keyboard.

- [ ] **Step 3: Run complete verification**

Run:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
bash scripts/test-integration.sh
pnpm build
pnpm exec playwright test tests/e2e/control-plane-test.spec.ts tests/e2e/golden-path.spec.ts --project=chromium
git diff --check
```

Record actual counts; do not copy old counts.

- [ ] **Step 4: Deploy without changing ports**

Run the tracked migrations, rebuild the production image, and recreate only the existing
Compose `app` service on `127.0.0.1:3000`. Verify:

```bash
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3000/api/ready
curl --fail http://127.0.0.1:3000/control-plane-test
```

Do not change `APP_PORT`, `APP_BIND_ADDRESS`, or the Compose port mapping.

- [ ] **Step 5: Verify restart semantics manually and in the browser**

1. create a Session and complete a Run;
2. reload and confirm the same transcript;
3. restart only the existing app container/service;
4. reload and confirm the same transcript plus the unavailable-Runtime recovery message;
5. create a new Session and complete another Run.

- [ ] **Step 6: Record truthful roadmap evidence**

Document:

- final commit SHA;
- `/control-plane-test` URL;
- actual unit, integration, build, and Playwright results;
- refresh recovery;
- app-restart transcript recovery and Fake Runtime unavailability;
- unchanged `/` Golden Path;
- no port change;
- restricted application grants remain a LAN-exposure hard gate.

- [ ] **Step 7: Final review and commit**

Run independent specification and quality reviews. Fix all Critical/Important findings,
rerun affected gates, then commit:

```bash
git add tests/e2e/control-plane-test.spec.ts docs/architecture/development-roadmap.md
git commit -m "test: prove persisted browser control-plane loop"
```

## Final acceptance

- [ ] `/control-plane-test` is visibly new content and does not render the old canvas.
- [ ] A beginner can initialize, create a Session, send a message, and see the deterministic reply.
- [ ] Six persisted event rows and two transcript messages back one succeeded Run.
- [ ] Refresh recovers the transcript from PostgreSQL.
- [ ] App restart preserves history and truthfully marks the old Fake Runtime unavailable.
- [ ] Pending retries reuse their original identifiers and content.
- [ ] `202`, `409`, `404`, `500`, and `503` states have plain-language recovery.
- [ ] Narrow-screen and keyboard journeys remain usable.
- [ ] The old `/` Golden Path passes unchanged.
- [ ] No new port, service, migration, provider, or browser-owned transcript state is introduced.
