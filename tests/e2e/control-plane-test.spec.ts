import { expect, test } from '@playwright/test';

const storagePrefix = 'ai-super-canvas.control-plane-test.';
const ids = {
  accountId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  agentBindingId: '33333333-3333-4333-8333-333333333333',
  workspaceId: '44444444-4444-4444-8444-444444444444',
  workflowId: '55555555-5555-4555-8555-555555555555',
  trunkRevisionId: '66666666-6666-4666-8666-666666666666',
  sessionId: '77777777-7777-4777-8777-777777777777',
  nodeId: '88888888-8888-4888-8888-888888888888',
  runId: '99999999-9999-4999-8999-999999999999',
  userMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  assistantMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((prefix) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  }, storagePrefix);
});

test('shows a new PostgreSQL-backed test surface instead of the old canvas', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'not-ready',
        database: 'unavailable',
      }),
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/control-plane-test');

  await expect(page.getByRole('heading', { name: '真实后端闭环' })).toBeVisible();
  await expect(page.getByText('PostgreSQL', { exact: true })).toBeVisible();
  await expect(page.getByText('DeterministicFakeRuntime', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建测试 Session' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '测试消息' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '主干活文档' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
});

test('creates a Session, polls persisted JSON events, and renders the transcript', async ({
  page,
}) => {
  let hasCompletedRun = false;
  let startRunBody: unknown;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (status: number, body: unknown) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    if (request.method() === 'GET' && url.pathname === '/api/ready') {
      await json(200, { status: 'ready', database: 'ready' });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/api/control-plane/bootstrap') {
      await json(200, {
        accountId: ids.accountId,
        agentId: ids.agentId,
        agentBindingId: ids.agentBindingId,
        workspaceId: ids.workspaceId,
        workflowId: ids.workflowId,
        trunkRevisionId: ids.trunkRevisionId,
      });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/api/control-plane/sessions') {
      await json(201, {
        sessionId: ids.sessionId,
        nodeId: ids.nodeId,
        status: 'active',
      });
      return;
    }
    if (
      request.method() === 'POST'
      && url.pathname === `/api/control-plane/sessions/${ids.sessionId}/runs`
    ) {
      startRunBody = request.postDataJSON();
      await json(202, { runId: ids.runId, status: 'running' });
      return;
    }
    if (
      request.method() === 'GET'
      && url.pathname === `/api/control-plane/runs/${ids.runId}/events`
    ) {
      hasCompletedRun = true;
      await json(200, {
        events: [
          {
            sequence: 1,
            eventType: 'run.started',
            payload: {},
            occurredAt: '2026-07-26T00:00:00.000Z',
          },
          {
            sequence: 6,
            eventType: 'run.completed',
            payload: {},
            occurredAt: '2026-07-26T00:00:01.000Z',
          },
        ],
        nextAfter: 6,
        terminal: { status: 'succeeded' },
      });
      return;
    }
    if (
      request.method() === 'GET'
      && url.pathname === `/api/control-plane/sessions/${ids.sessionId}/transcript`
    ) {
      await json(200, {
        sessionId: ids.sessionId,
        status: 'active',
        messages: hasCompletedRun
          ? [
              {
                messageId: ids.userMessageId,
                runId: ids.runId,
                ordinal: 1,
                role: 'user',
                content: '浏览器真实闭环',
                status: 'completed',
              },
              {
                messageId: ids.assistantMessageId,
                runId: ids.runId,
                ordinal: 2,
                role: 'assistant',
                content: 'fake fake ',
                status: 'completed',
              },
            ]
          : [],
        activeRun: hasCompletedRun ? null : null,
        reconciliationState: null,
        runtimeAvailability: 'available',
      });
      return;
    }

    await json(404, {
      error: {
        code: 'not_found',
        message: 'Resource not found',
        retryable: false,
      },
    });
  });

  await page.goto('/control-plane-test');
  await expect(page.getByText('后端已就绪', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建测试 Session' }).click();
  await expect(page.getByText('Session 已连接 Fake Runtime', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '测试消息' }).fill('浏览器真实闭环');
  await page.getByRole('button', { name: '发送到真实后端' }).click();

  await expect(page.getByText('回复已写入 PostgreSQL', { exact: true })).toBeVisible();
  await expect(page.getByText('浏览器真实闭环', { exact: true })).toBeVisible();
  await expect(page.getByText('fake fake ', { exact: true })).toBeVisible();
  await expect(page.getByLabel('已持久化 Run 事件')).toContainText('run.completed');
  expect(startRunBody).toMatchObject({
    content: '浏览器真实闭环',
  });

  const storedValues = await page.evaluate((prefix) => Object.entries(localStorage)
    .filter(([key]) => key.startsWith(prefix)), storagePrefix);
  expect(storedValues).toEqual([
    ['ai-super-canvas.control-plane-test.last-session', ids.sessionId],
  ]);
  expect(JSON.stringify(storedValues)).not.toContain('浏览器真实闭环');
  expect(JSON.stringify(storedValues)).not.toContain('fake fake');
});

test('keeps one pending Run identity when a 202 response requires retry', async ({
  page,
}) => {
  let runAttempts = 0;
  let hasCompletedRun = false;
  const runBodies: Array<{
    commandId: string;
    idempotencyKey: string;
    content: string;
  }> = [];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (status: number, body: unknown) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    if (request.method() === 'GET' && url.pathname === '/api/ready') {
      await json(200, { status: 'ready', database: 'ready' });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/api/control-plane/bootstrap') {
      await json(200, {
        accountId: ids.accountId,
        agentId: ids.agentId,
        agentBindingId: ids.agentBindingId,
        workspaceId: ids.workspaceId,
        workflowId: ids.workflowId,
        trunkRevisionId: ids.trunkRevisionId,
      });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/api/control-plane/sessions') {
      await json(201, {
        sessionId: ids.sessionId,
        nodeId: ids.nodeId,
        status: 'active',
      });
      return;
    }
    if (
      request.method() === 'POST'
      && url.pathname === `/api/control-plane/sessions/${ids.sessionId}/runs`
    ) {
      runAttempts += 1;
      runBodies.push(request.postDataJSON());
      if (runAttempts === 1) {
        await json(202, {
          error: {
            code: 'command_persistence_unconfirmed',
            message: 'safe server message',
            retryable: true,
          },
          commandReceiptId: 'receipt-1',
        });
      } else {
        await json(202, { runId: ids.runId, status: 'running' });
      }
      return;
    }
    if (
      request.method() === 'GET'
      && url.pathname === `/api/control-plane/runs/${ids.runId}/events`
    ) {
      hasCompletedRun = true;
      await json(200, {
        events: [{
          sequence: 6,
          eventType: 'run.completed',
          payload: {},
          occurredAt: '2026-07-26T00:00:01.000Z',
        }],
        nextAfter: 6,
        terminal: { status: 'succeeded' },
      });
      return;
    }
    if (
      request.method() === 'GET'
      && url.pathname === `/api/control-plane/sessions/${ids.sessionId}/transcript`
    ) {
      await json(200, {
        sessionId: ids.sessionId,
        status: 'active',
        messages: hasCompletedRun
          ? [{
              messageId: ids.assistantMessageId,
              runId: ids.runId,
              ordinal: 2,
              role: 'assistant',
              content: 'fake fake ',
              status: 'completed',
            }]
          : [],
        activeRun: null,
        reconciliationState: null,
        runtimeAvailability: 'available',
      });
      return;
    }

    await json(404, {
      error: {
        code: 'not_found',
        message: 'Resource not found',
        retryable: false,
      },
    });
  });

  await page.goto('/control-plane-test');
  await expect(page.getByText('后端已就绪', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建测试 Session' }).click();
  await page.getByRole('textbox', { name: '测试消息' }).fill('只能写入一次');
  await page.getByRole('button', { name: '发送到真实后端' }).click();

  await expect(page.getByRole('alert').filter({
    hasText: '服务器暂时无法确认是否已保存',
  })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试上次发送' })).toBeVisible();
  const pendingBeforeRetry = await page.evaluate(() => localStorage.getItem(
    'ai-super-canvas.control-plane-test.pending-run-command',
  ));
  expect(pendingBeforeRetry).not.toBeNull();

  await page.getByRole('textbox', { name: '测试消息' }).fill('不要改成这句话');
  await page.getByRole('button', { name: '重试上次发送' }).click();
  await expect(page.getByText('回复已写入 PostgreSQL', { exact: true })).toBeVisible();

  expect(runBodies).toHaveLength(2);
  expect(runBodies[1]).toEqual(runBodies[0]);
  expect(runBodies[1]?.content).toBe('只能写入一次');
  await expect.poll(() => page.evaluate(() => localStorage.getItem(
    'ai-super-canvas.control-plane-test.pending-run-command',
  ))).toBeNull();
});

test('restores PostgreSQL history and explains an unavailable Runtime', async ({
  page,
}) => {
  await page.addInitScript(({ key, sessionId }) => {
    localStorage.setItem(key, sessionId);
  }, {
    key: 'ai-super-canvas.control-plane-test.last-session',
    sessionId: ids.sessionId,
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (status: number, body: unknown) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    if (request.method() === 'GET' && url.pathname === '/api/ready') {
      await json(200, { status: 'ready', database: 'ready' });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/api/control-plane/bootstrap') {
      await json(200, {
        accountId: ids.accountId,
        agentId: ids.agentId,
        agentBindingId: ids.agentBindingId,
        workspaceId: ids.workspaceId,
        workflowId: ids.workflowId,
        trunkRevisionId: ids.trunkRevisionId,
      });
      return;
    }
    if (
      request.method() === 'GET'
      && url.pathname === `/api/control-plane/sessions/${ids.sessionId}/transcript`
    ) {
      await json(200, {
        sessionId: ids.sessionId,
        status: 'active',
        messages: [{
          messageId: ids.assistantMessageId,
          runId: ids.runId,
          ordinal: 2,
          role: 'assistant',
          content: '重启前的历史',
          status: 'completed',
        }],
        activeRun: null,
        reconciliationState: {
          kind: 'runtime-unavailable',
          message: 'The in-memory Runtime Session is unavailable after restart',
        },
        runtimeAvailability: 'unavailable',
      });
      return;
    }

    await json(404, {
      error: {
        code: 'not_found',
        message: 'Resource not found',
        retryable: false,
      },
    });
  });

  await page.goto('/control-plane-test');
  await expect(page.getByText('重启前的历史', { exact: true })).toBeVisible();
  await expect(page.getByText(
    '历史已恢复，但旧 Fake Runtime 已不可用。请新建测试 Session。',
    { exact: true },
  )).toBeVisible();
  await expect(page.getByRole('textbox', { name: '测试消息' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '新建测试 Session' })).toBeEnabled();
});
