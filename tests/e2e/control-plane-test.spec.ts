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
  pendingRunCommandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  pendingRunIdempotencyKey: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  secondSessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  secondNodeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  secondRunId: '12345678-1234-4234-8234-123456789abc',
  secondUserMessageId: '23456789-2345-4345-8345-23456789abcd',
  secondAssistantMessageId: '3456789a-3456-4456-8456-3456789abcde',
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((prefix) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  }, storagePrefix);
});

test('shows a new PostgreSQL-backed test surface instead of the old canvas', async ({ page }) => {
  let readinessAttempts = 0;
  await page.route('**/api/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/ready') {
      readinessAttempts += 1;
    }
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
  await expect(page.getByRole('button', { name: '发送到真实后端' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '主干活文档' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);

  await expect(page.getByRole('alert').filter({
    hasText: 'PostgreSQL 暂时不可用',
  })).toBeVisible();
  await page.getByRole('button', { name: '重新连接' }).click();
  await expect.poll(() => readinessAttempts).toBe(2);
  await expect(page.getByRole('button', { name: '新建测试 Session' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '测试消息' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '发送到真实后端' })).toBeDisabled();
});

test('creates a Session, polls persisted JSON events, and renders the transcript', async ({
  page,
}) => {
  let hasStartedRun = false;
  let hasCompletedRun = false;
  let startRunBody: unknown;
  const eventAfters: string[] = [];

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
      hasStartedRun = true;
      await json(202, { runId: ids.runId, status: 'running' });
      return;
    }
    if (
      request.method() === 'GET'
      && url.pathname === `/api/control-plane/runs/${ids.runId}/events`
    ) {
      const after = url.searchParams.get('after') ?? '';
      eventAfters.push(after);
      if (after === '0') {
        await json(200, {
          events: [{
            sequence: 1,
            eventType: 'run.started',
            payload: {},
            occurredAt: '2026-07-26T00:00:00.000Z',
          }],
          nextAfter: 1,
          terminal: null,
        });
        return;
      }
      if (after === '1') {
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
      await json(400, {
        error: {
          code: 'invalid_after',
          message: `Unexpected after cursor: ${after}`,
          retryable: false,
        },
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
                runId: null,
                ordinal: 0,
                role: 'user',
                content: '浏览器真实闭环',
                status: 'completed',
              },
              {
                messageId: ids.assistantMessageId,
                runId: ids.runId,
                ordinal: 1,
                role: 'assistant',
                content: 'fake fake ',
                status: 'completed',
              },
            ]
          : hasStartedRun
            ? [{
                messageId: ids.userMessageId,
                runId: null,
                ordinal: 0,
                role: 'user',
                content: '浏览器真实闭环',
                status: 'completed',
              }]
            : [],
        activeRun: hasStartedRun && !hasCompletedRun
          ? { runId: ids.runId, status: 'running' }
          : null,
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
  expect(eventAfters).toEqual(['0', '1']);
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

test('keeps one pending Run identity through malformed and retryable 202 responses', async ({
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
          },
        });
      } else if (runAttempts === 2) {
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
    hasText: '后端返回了无法识别的数据',
  })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试上次发送' })).toBeVisible();
  const pendingAfterMalformedResponse = await page.evaluate(() => localStorage.getItem(
    'ai-super-canvas.control-plane-test.pending-run-command',
  ));
  expect(pendingAfterMalformedResponse).not.toBeNull();

  await page.getByRole('textbox', { name: '测试消息' }).fill('不要改成第二句话');
  await page.getByRole('button', { name: '重试上次发送' }).click();
  await expect(page.getByRole('alert').filter({
    hasText: '服务器暂时无法确认是否已保存',
  })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试上次发送' })).toBeVisible();
  const pendingAfterRetryableResponse = await page.evaluate(() => localStorage.getItem(
    'ai-super-canvas.control-plane-test.pending-run-command',
  ));
  expect(pendingAfterRetryableResponse).toBe(pendingAfterMalformedResponse);

  await page.getByRole('textbox', { name: '测试消息' }).fill('不要改成第三句话');
  await page.getByRole('button', { name: '重试上次发送' }).click();
  await expect(page.getByText('回复已写入 PostgreSQL', { exact: true })).toBeVisible();

  expect(runBodies).toHaveLength(3);
  expect(runBodies[1]).toEqual(runBodies[0]);
  expect(runBodies[2]).toEqual(runBodies[0]);
  expect(runBodies[2]?.content).toBe('只能写入一次');
  await expect.poll(() => page.evaluate(() => localStorage.getItem(
    'ai-super-canvas.control-plane-test.pending-run-command',
  ))).toBeNull();
});

test('resets displayed event sequences for a second Run in the same Session', async ({
  page,
}) => {
  const runIds = [ids.runId, ids.secondRunId];
  const eventTypes = ['first-run.completed', 'second-run.completed'];
  const prompts = ['同一 Session 的第一条', '同一 Session 的第二条'];
  let startedRuns = 0;
  let completedRuns = 0;

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
      const expectedContent = prompts[startedRuns];
      expect(request.postDataJSON()).toMatchObject({ content: expectedContent });
      const runId = runIds[startedRuns];
      startedRuns += 1;
      await json(202, { runId, status: 'running' });
      return;
    }
    const eventRunIndex = runIds.findIndex(
      (runId) => url.pathname === `/api/control-plane/runs/${runId}/events`,
    );
    if (request.method() === 'GET' && eventRunIndex >= 0) {
      expect(url.searchParams.get('after')).toBe('0');
      completedRuns = Math.max(completedRuns, eventRunIndex + 1);
      await json(200, {
        events: [{
          sequence: 6,
          eventType: eventTypes[eventRunIndex],
          payload: {},
          occurredAt: `2026-07-26T00:00:0${eventRunIndex}.000Z`,
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
      const messages: Array<Record<string, unknown>> = [];
      for (let index = 0; index < completedRuns; index += 1) {
        messages.push(
          {
            messageId: index === 0
              ? ids.userMessageId
              : ids.secondUserMessageId,
            runId: null,
            ordinal: index * 2,
            role: 'user',
            content: prompts[index],
            status: 'completed',
          },
          {
            messageId: index === 0
              ? ids.assistantMessageId
              : ids.secondAssistantMessageId,
            runId: runIds[index],
            ordinal: index * 2 + 1,
            role: 'assistant',
            content: index === 0 ? '第一条回复' : '第二条回复',
            status: 'completed',
          },
        );
      }
      await json(200, {
        sessionId: ids.sessionId,
        status: 'active',
        messages,
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

  await page.getByRole('textbox', { name: '测试消息' }).fill(prompts[0]);
  await page.getByRole('button', { name: '发送到真实后端' }).click();
  await expect(page.getByText('第一条回复', { exact: true })).toBeVisible();
  await expect(page.getByLabel('已持久化 Run 事件')).toContainText(
    'first-run.completed',
  );

  await page.getByRole('textbox', { name: '测试消息' }).fill(prompts[1]);
  await page.getByRole('button', { name: '发送到真实后端' }).click();
  await expect(page.getByText('第二条回复', { exact: true })).toBeVisible();
  await expect(page.getByLabel('已持久化 Run 事件')).toContainText(
    'second-run.completed',
  );
  await expect(page.getByLabel('已持久化 Run 事件')).not.toContainText(
    'first-run.completed',
  );
  expect(startedRuns).toBe(2);
  expect(completedRuns).toBe(2);
});

test('restores an active Run without allowing a duplicate send', async ({
  page,
}) => {
  let eventRequests = 0;
  let runPostRequests = 0;
  let hasCompletedRun = false;
  let replayedRunBody: unknown;
  const requestOrder: string[] = [];
  const pendingRun = {
    commandId: ids.pendingRunCommandId,
    idempotencyKey: ids.pendingRunIdempotencyKey,
    sessionId: ids.sessionId,
    content: '恢复中的消息',
  };
  let releaseEvents: (() => void) | undefined;
  const eventsGate = new Promise<void>((resolve) => {
    releaseEvents = resolve;
  });

  await page.addInitScript(({ lastSessionKey, pendingRunKey, value }) => {
    localStorage.setItem(lastSessionKey, value.sessionId);
    localStorage.setItem(pendingRunKey, JSON.stringify(value));
  }, {
    lastSessionKey: 'ai-super-canvas.control-plane-test.last-session',
    pendingRunKey: 'ai-super-canvas.control-plane-test.pending-run-command',
    value: pendingRun,
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
      request.method() === 'POST'
      && url.pathname === `/api/control-plane/sessions/${ids.sessionId}/runs`
    ) {
      runPostRequests += 1;
      replayedRunBody = request.postDataJSON();
      requestOrder.push('run-post');
      await json(202, { runId: ids.runId, status: 'running' });
      return;
    }
    if (
      request.method() === 'GET'
      && url.pathname === `/api/control-plane/runs/${ids.runId}/events`
    ) {
      eventRequests += 1;
      requestOrder.push('events');
      await eventsGate;
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
        messages: [
          {
            messageId: ids.userMessageId,
            runId: null,
            ordinal: 0,
            role: 'user',
            content: '恢复中的消息',
            status: 'completed',
          },
          ...(hasCompletedRun
            ? [{
                messageId: ids.assistantMessageId,
                runId: ids.runId,
                ordinal: 1,
                role: 'assistant',
                content: 'fake fake ',
                status: 'completed',
              }]
            : []),
        ],
        activeRun: hasCompletedRun
          ? null
          : { runId: ids.runId, status: 'running' },
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
  await expect(page.getByRole('article').getByText(
    '恢复中的消息',
    { exact: true },
  )).toBeVisible();
  await expect.poll(() => runPostRequests).toBe(1);
  expect(replayedRunBody).toEqual({
    commandId: pendingRun.commandId,
    idempotencyKey: pendingRun.idempotencyKey,
    content: pendingRun.content,
  });
  await expect.poll(() => page.evaluate(() => localStorage.getItem(
    'ai-super-canvas.control-plane-test.pending-run-command',
  ))).toBeNull();
  await expect.poll(() => eventRequests).toBe(1);
  expect(requestOrder).toEqual(['run-post', 'events']);
  await expect(page.getByRole('textbox', { name: '测试消息' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '发送到真实后端' })).toBeDisabled();

  releaseEvents?.();
  await expect(page.getByText('fake fake ', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '测试消息' })).toBeEnabled();
  await page.getByRole('textbox', { name: '测试消息' }).fill('恢复后可以发送');
  await expect(page.getByRole('button', { name: '发送到真实后端' })).toBeEnabled();
  expect(eventRequests).toBe(1);
});

test('blocks a second Run when event polling fails after a valid start response', async ({
  page,
}) => {
  let runPostRequests = 0;
  let eventRequests = 0;

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
      runPostRequests += 1;
      await json(202, { runId: ids.runId, status: 'running' });
      return;
    }
    if (
      request.method() === 'GET'
      && url.pathname === `/api/control-plane/runs/${ids.runId}/events`
    ) {
      eventRequests += 1;
      await json(500, {
        error: {
          code: 'internal_error',
          message: 'safe server message',
          retryable: true,
        },
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
        messages: [],
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
  await page.getByRole('textbox', { name: '测试消息' }).fill('事件读取会失败');
  await page.getByRole('button', { name: '发送到真实后端' }).click();

  await expect(page.getByRole('alert').filter({
    hasText: '后端暂时出错',
  })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '测试消息' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '发送到真实后端' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '新建测试 Session' })).toBeEnabled();
  await page.waitForTimeout(200);
  expect(runPostRequests).toBe(1);
  expect(eventRequests).toBe(1);
});

test('clears restored history when its Session pointer is invalid before reconnect', async ({
  page,
}) => {
  let transcriptRequests = 0;

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
      transcriptRequests += 1;
      await json(200, {
        sessionId: ids.sessionId,
        status: 'active',
        messages: [{
          messageId: ids.assistantMessageId,
          runId: ids.runId,
          ordinal: 1,
          role: 'assistant',
          content: '指针失效前的旧历史',
          status: 'completed',
        }],
        activeRun: null,
        reconciliationState: null,
        runtimeAvailability: 'available',
      });
      return;
    }
    if (
      request.method() === 'POST'
      && url.pathname === `/api/control-plane/sessions/${ids.sessionId}/runs`
    ) {
      await json(500, {
        error: {
          code: 'internal_error',
          message: 'safe server message',
          retryable: true,
        },
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
  await expect(page.getByText('指针失效前的旧历史', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem(
      'ai-super-canvas.control-plane-test.last-session',
      'invalid-session-pointer',
    );
  });
  await page.getByRole('textbox', { name: '测试消息' }).fill('触发可恢复错误');
  await page.getByRole('button', { name: '发送到真实后端' }).click();
  await expect(page.getByRole('button', { name: '重新连接' })).toBeVisible();

  await page.getByRole('button', { name: '重新连接' }).click();
  await expect(page.getByText('后端已就绪', { exact: true })).toBeVisible();
  await expect(page.getByText(
    '指针失效前的旧历史',
    { exact: true },
  )).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem(
    'ai-super-canvas.control-plane-test.last-session',
  ))).toBeNull();
  expect(transcriptRequests).toBe(1);
});

test('does not keep an old transcript when a new Session transcript fails to load', async ({
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
    if (request.method() === 'POST' && url.pathname === '/api/control-plane/sessions') {
      await json(201, {
        sessionId: ids.secondSessionId,
        nodeId: ids.secondNodeId,
        status: 'active',
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
          ordinal: 1,
          role: 'assistant',
          content: '只属于旧 Session 的历史',
          status: 'completed',
        }],
        activeRun: null,
        reconciliationState: null,
        runtimeAvailability: 'available',
      });
      return;
    }
    if (
      request.method() === 'GET'
      && url.pathname === `/api/control-plane/sessions/${ids.secondSessionId}/transcript`
    ) {
      await json(500, {
        error: {
          code: 'internal_error',
          message: 'safe server message',
          retryable: true,
        },
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
  await expect(page.getByText('只属于旧 Session 的历史', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建测试 Session' }).click();
  await expect(page.getByRole('alert').filter({
    hasText: '后端暂时出错',
  })).toBeVisible();
  await expect(page.getByText(
    '只属于旧 Session 的历史',
    { exact: true },
  )).toHaveCount(0);
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
