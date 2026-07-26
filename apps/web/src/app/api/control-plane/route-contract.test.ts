import { ControlPlaneApplicationError } from '@ai-super-canvas/control-plane';
import {
  getControlPlane,
  getLocalActorContext,
} from '@/server/control-plane';
import {
  ActiveRunConflictError,
  AuthorizationError,
  CommandPayloadConflictError,
  RunIdempotencyConflictError,
} from '@ai-super-canvas/db';
import type { ActorContext } from '@ai-super-canvas/core';
import { describe, expect, it, vi } from 'vitest';

import {
  makeBootstrapHandler,
  makeCreateSessionHandler,
  makeRunEventsHandler,
  makeStartRunHandler,
  makeTranscriptHandler,
} from './handlers';
import { GET as getRunEventsRoute } from './runs/[runId]/events/route';
import { POST as postStartRunRoute } from './sessions/[sessionId]/runs/route';
import { GET as getTranscriptRoute } from './sessions/[sessionId]/transcript/route';

vi.mock('@/server/control-plane', () => ({
  getControlPlane: vi.fn(),
  getLocalActorContext: vi.fn(),
}));

const commandId = '550e8400-e29b-41d4-a716-446655440000';
const workflowId = '550e8400-e29b-41d4-a716-446655440001';
const agentBindingId = '550e8400-e29b-41d4-a716-446655440002';
const sessionId = '550e8400-e29b-41d4-a716-446655440004';
const runId = '550e8400-e29b-41d4-a716-446655440005';
const actor: ActorContext = {
  accountId: '550e8400-e29b-41d4-a716-446655440003',
  authSubject: 'local:owner',
};
const controlPlaneLoader = vi.mocked(getControlPlane);
const actorLoader = vi.mocked(getLocalActorContext);

function jsonRequest(body: unknown): Request {
  return new Request('http://canvas.test/api/control-plane', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function bootstrapService() {
  return {
    bootstrapLocalAlpha: vi.fn(async () => ({
      accountId: 'account-1',
      agentId: 'agent-1',
      agentBindingId: 'binding-1',
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      trunkRevisionId: 'revision-1',
    })),
  };
}

function sessionService() {
  return {
    createRootSession: vi.fn(async () => ({
      sessionId: 'session-1',
      nodeId: 'node-1',
      status: 'active' as const,
    })),
  };
}

function runService() {
  return {
    startRun: vi.fn(async () => ({ runId, status: 'failed' as const })),
    getRunEvents: vi.fn(async () => ({
      events: [{
        sequence: 7,
        eventType: 'message.completed',
        payload: { content: { nested: ['unknown', null] } },
        occurredAt: '2026-07-26T00:00:00.000Z',
      }],
      nextAfter: 7,
      terminal: { status: 'succeeded' as const },
    })),
    getSessionTranscript: vi.fn(async () => ({
      sessionId,
      status: 'active',
      messages: [{
        messageId: 'message-1',
        runId,
        ordinal: 1,
        role: 'assistant' as const,
        content: { unknown: [null, { deeply: 'preserved' }] },
        status: 'completed',
      }],
      activeRun: { runId, status: 'running' as const },
      reconciliationState: {
        kind: 'run-reconciling' as const,
        message: 'safe message',
      },
      runtimeAvailability: 'unavailable' as const,
    })),
  };
}

describe('persisted Session write route contracts', () => {
  it('bootstraps using only its injected auth subject and passes the default display name', async () => {
    const service = bootstrapService();
    const handler = makeBootstrapHandler({ service, authSubject: 'local:server' });

    const response = await handler(jsonRequest({ commandId }));

    expect(service.bootstrapLocalAlpha).toHaveBeenCalledExactlyOnceWith({
      commandId,
      authSubject: 'local:server',
      displayName: '本地测试用户',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: 'account-1',
      agentId: 'agent-1',
      agentBindingId: 'binding-1',
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      trunkRevisionId: 'revision-1',
    });
  });

  it.each([
    ['forged auth subject', { commandId, authSubject: 'forged:subject' }],
    ['forged account id', { commandId, accountId: actor.accountId }],
    ['invalid command UUID', { commandId: 'not-a-uuid' }],
    ['empty display name', { commandId, displayName: '   ' }],
    ['overlong display name', { commandId, displayName: 'a'.repeat(121) }],
  ])('rejects bootstrap request with %s before calling the service', async (_description, body) => {
    const service = bootstrapService();
    const response = await makeBootstrapHandler({
      service,
      authSubject: actor.authSubject,
    })(jsonRequest(body));

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Request validation failed',
        retryable: false,
      },
    });
    expect(service.bootstrapLocalAlpha).not.toHaveBeenCalled();
  });

  it('rejects malformed bootstrap JSON before calling the service', async () => {
    const service = bootstrapService();
    const request = new Request('http://canvas.test/api/control-plane', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });

    const response = await makeBootstrapHandler({
      service,
      authSubject: actor.authSubject,
    })(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'malformed_json',
        message: 'Request body must be valid JSON',
        retryable: false,
      },
    });
    expect(service.bootstrapLocalAlpha).not.toHaveBeenCalled();
  });

  it('creates a root Session using only its injected actor context', async () => {
    const service = sessionService();
    const handler = makeCreateSessionHandler({ service, actor });

    const response = await handler(jsonRequest({
      commandId,
      workflowId,
      agentBindingId,
      title: '  新会话  ',
    }));

    expect(service.createRootSession).toHaveBeenCalledExactlyOnceWith({
      actor,
      commandId,
      workflowId,
      agentBindingId,
      title: '新会话',
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      sessionId: 'session-1',
      nodeId: 'node-1',
      status: 'active',
    });
  });

  it.each([
    ['commandId', { commandId: 'invalid', workflowId, agentBindingId, title: '会话' }],
    ['workflowId', { commandId, workflowId: 'invalid', agentBindingId, title: '会话' }],
    ['agentBindingId', { commandId, workflowId, agentBindingId: 'invalid', title: '会话' }],
    ['empty title', { commandId, workflowId, agentBindingId, title: '  ' }],
    ['overlong title', { commandId, workflowId, agentBindingId, title: 'a'.repeat(161) }],
    ['accountId', { commandId, workflowId, agentBindingId, title: '会话', accountId: actor.accountId }],
    ['model', { commandId, workflowId, agentBindingId, title: '会话', model: 'forged' }],
    ['toolPolicy', { commandId, workflowId, agentBindingId, title: '会话', toolPolicy: {} }],
  ])('rejects invalid create Session body field %s before calling the service', async (_field, body) => {
    const service = sessionService();
    const response = await makeCreateSessionHandler({ service, actor })(jsonRequest(body));

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(service.createRootSession).not.toHaveBeenCalled();
  });

  it('maps reconciliation-required Session creation to a retryable receipt response', async () => {
    const service = sessionService();
    service.createRootSession.mockRejectedValueOnce(
      new ControlPlaneApplicationError(
        'command_requires_reconciliation',
        'safe reconciliation message',
        true,
        'receipt-3',
      ),
    );

    const response = await makeCreateSessionHandler({ service, actor })(jsonRequest({
      commandId,
      workflowId,
      agentBindingId,
      title: '会话',
    }));

    expect(response.status).toBe(202);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'command_requires_reconciliation',
        message: 'safe reconciliation message',
        retryable: true,
      },
      commandReceiptId: 'receipt-3',
    });
  });

  it.each([
    [new CommandPayloadConflictError(commandId), 409, 'command_payload_conflict', 'Request conflicts with the current server state'],
    [new AuthorizationError(), 404, 'not_found', 'Resource not found'],
  ])('maps service failures through the shared no-store HTTP error boundary', async (reason, status, code, message) => {
    const service = sessionService();
    service.createRootSession.mockRejectedValueOnce(reason);

    const response = await makeCreateSessionHandler({ service, actor })(jsonRequest({
      commandId,
      workflowId,
      agentBindingId,
      title: '会话',
    }));

    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      error: { code, message, retryable: false },
    });
  });
});

describe('persisted Run and transcript route contracts', () => {
  it('starts a Run with the injected actor, normalized body, 202, and no-store without assuming a running status', async () => {
    const service = runService();

    const response = await makeStartRunHandler({ service, actor })(jsonRequest({
      commandId,
      idempotencyKey: '  idempotency-1  ',
      content: '  生成一个摘要  ',
    }), { sessionId });

    expect(service.startRun).toHaveBeenCalledExactlyOnceWith({
      actor,
      sessionId,
      commandId,
      idempotencyKey: 'idempotency-1',
      content: '生成一个摘要',
    });
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ runId, status: 'failed' });
  });

  it('returns persisted event pages as JSON, unchanged, and never as SSE', async () => {
    const service = runService();
    const response = await makeRunEventsHandler({ service, actor })(
      new Request('http://canvas.test/api/control-plane/runs?after=6'),
      { runId },
    );

    expect(service.getRunEvents).toHaveBeenCalledExactlyOnceWith({ actor, runId, after: 6 });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    await expect(response.json()).resolves.toEqual({
      events: [{
        sequence: 7,
        eventType: 'message.completed',
        payload: { content: { nested: ['unknown', null] } },
        occurredAt: '2026-07-26T00:00:00.000Z',
      }],
      nextAfter: 7,
      terminal: { status: 'succeeded' },
    });
  });

  it('returns the transcript DTO unchanged, including active run, reconciliation, availability, and unknown content', async () => {
    const service = runService();
    const response = await makeTranscriptHandler({ service, actor })({ sessionId });

    expect(service.getSessionTranscript).toHaveBeenCalledExactlyOnceWith({ actor, sessionId });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      sessionId,
      status: 'active',
      messages: [{
        messageId: 'message-1',
        runId,
        ordinal: 1,
        role: 'assistant',
        content: { unknown: [null, { deeply: 'preserved' }] },
        status: 'completed',
      }],
      activeRun: { runId, status: 'running' },
      reconciliationState: { kind: 'run-reconciling', message: 'safe message' },
      runtimeAvailability: 'unavailable',
    });
  });

  it('rejects an invalid start session ID before reading a malformed body or calling the service', async () => {
    const service = runService();
    const malformedRequest = new Request('http://canvas.test/api/control-plane', {
      method: 'POST',
      body: '{',
    });
    const response = await makeStartRunHandler({ service, actor })(malformedRequest, { sessionId: 'invalid' });

    expect(response.status).toBe(400);
    expect(service.startRun).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', undefined, '{'],
    ['invalid command ID', { commandId: 'invalid', idempotencyKey: 'key', content: 'hello' }, undefined],
    ['empty content', { commandId, idempotencyKey: 'key', content: '   ' }, undefined],
    ['oversized content', { commandId, idempotencyKey: 'key', content: 'x'.repeat(20_001) }, undefined],
    ['empty idempotency key', { commandId, idempotencyKey: '   ', content: 'hello' }, undefined],
    ['oversized idempotency key', { commandId, idempotencyKey: 'x'.repeat(161), content: 'hello' }, undefined],
    ['forged session ID', { commandId, idempotencyKey: 'key', content: 'hello', sessionId }, undefined],
    ['forged account ID', { commandId, idempotencyKey: 'key', content: 'hello', accountId: actor.accountId }, undefined],
    ['forged model', { commandId, idempotencyKey: 'key', content: 'hello', model: 'forged' }, undefined],
    ['forged tool policy', { commandId, idempotencyKey: 'key', content: 'hello', toolPolicy: {} }, undefined],
    ['forged auth subject', { commandId, idempotencyKey: 'key', content: 'hello', authSubject: 'forged:subject' }, undefined],
  ])('rejects start Run request with %s before calling the service', async (_description, body, rawBody) => {
    const service = runService();
    const request = rawBody
      ? new Request('http://canvas.test/api/control-plane', { method: 'POST', body: rawBody })
      : jsonRequest(body);
    const response = await makeStartRunHandler({ service, actor })(request, { sessionId });

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(service.startRun).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid run ID', 'invalid', '0'],
    ['negative after', runId, '-1'],
    ['fractional after', runId, '1.5'],
    ['non-numeric after', runId, 'not-a-number'],
    ['unsafe after', runId, '9007199254740992'],
  ])('rejects events %s before calling the service', async (_description, requestedRunId, after) => {
    const service = runService();
    const response = await makeRunEventsHandler({ service, actor })(
      new Request(`http://canvas.test/api/control-plane/runs?after=${after}`),
      { runId: requestedRunId },
    );

    expect(response.status).toBe(400);
    expect(service.getRunEvents).not.toHaveBeenCalled();
  });

  it('uses after=0 by default', async () => {
    const service = runService();
    await makeRunEventsHandler({ service, actor })(
      new Request('http://canvas.test/api/control-plane/runs'),
      { runId },
    );

    expect(service.getRunEvents).toHaveBeenCalledExactlyOnceWith({ actor, runId, after: 0 });
  });

  it('rejects an invalid transcript session ID before calling the service', async () => {
    const service = runService();
    const response = await makeTranscriptHandler({ service, actor })({ sessionId: 'invalid' });

    expect(response.status).toBe(400);
    expect(service.getSessionTranscript).not.toHaveBeenCalled();
  });

  it.each([
    ['events', () => new AuthorizationError(), (service: ReturnType<typeof runService>) =>
      makeRunEventsHandler({ service, actor })(new Request('http://canvas.test/api/control-plane/runs'), { runId })],
    ['transcript', () => new AuthorizationError(), (service: ReturnType<typeof runService>) =>
      makeTranscriptHandler({ service, actor })({ sessionId })],
  ])('sanitizes %s authorization failures as no-store 404 responses', async (_name, error, invoke) => {
    const service = runService();
    if (_name === 'events') service.getRunEvents.mockRejectedValueOnce(error());
    else service.getSessionTranscript.mockRejectedValueOnce(error());

    const response = await invoke(service);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).not.toContain(actor.accountId);
    expect(body).not.toContain('externalSessionRef');
    expect(body).not.toContain('externalRunRef');
  });

  it.each([
    [new ActiveRunConflictError(sessionId), 409, 'active_run_conflict', undefined],
    [new RunIdempotencyConflictError('key'), 409, 'run_idempotency_conflict', undefined],
    [new ControlPlaneApplicationError('command_requires_reconciliation', 'reconcile', true, 'receipt-1'), 202, 'command_requires_reconciliation', 'receipt-1'],
    [new ControlPlaneApplicationError('command_persistence_unconfirmed', 'unconfirmed', true, 'receipt-2'), 202, 'command_persistence_unconfirmed', 'receipt-2'],
    [new ControlPlaneApplicationError('runtime_session_unavailable', 'unavailable', false), 409, 'runtime_session_unavailable', undefined],
  ])('maps start Run service failure %s through the shared HTTP boundary', async (reason, status, code, receipt) => {
    const service = runService();
    service.startRun.mockRejectedValueOnce(reason);
    const response = await makeStartRunHandler({ service, actor })(jsonRequest({
      commandId,
      idempotencyKey: 'key',
      content: 'hello',
    }), { sessionId });

    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe(status === 202 ? '2' : null);
    await expect(response.json()).resolves.toEqual({
      error: { code, message: reason.message === 'reconcile' || reason.message === 'unconfirmed' || reason.message === 'unavailable' ? reason.message : 'Request conflicts with the current server state', retryable: status === 202 },
      ...(receipt ? { commandReceiptId: receipt } : {}),
    });
  });
});

describe('persisted Run Route composition contracts', () => {
  it('rejects invalid start Run params before starting either composition loader', async () => {
    controlPlaneLoader.mockReset().mockRejectedValue(new Error('must not load'));
    actorLoader.mockReset().mockRejectedValue(new Error('must not load'));

    const response = await postStartRunRoute(
      jsonRequest({ commandId, idempotencyKey: 'key', content: 'hello' }),
      { params: Promise.resolve({ sessionId: 'not-a-uuid' }) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(controlPlaneLoader).not.toHaveBeenCalled();
    expect(actorLoader).not.toHaveBeenCalled();
  });

  it('rejects invalid persisted events params before starting either composition loader', async () => {
    controlPlaneLoader.mockReset().mockRejectedValue(new Error('must not load'));
    actorLoader.mockReset().mockRejectedValue(new Error('must not load'));

    const response = await getRunEventsRoute(
      new Request('http://canvas.test/api/control-plane/runs'),
      { params: Promise.resolve({ runId: 'not-a-uuid' }) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(controlPlaneLoader).not.toHaveBeenCalled();
    expect(actorLoader).not.toHaveBeenCalled();
  });

  it('rejects invalid transcript params before starting either composition loader', async () => {
    controlPlaneLoader.mockReset().mockRejectedValue(new Error('must not load'));
    actorLoader.mockReset().mockRejectedValue(new Error('must not load'));

    const response = await getTranscriptRoute(
      new Request('http://canvas.test/api/control-plane/sessions/transcript'),
      { params: Promise.resolve({ sessionId: 'not-a-uuid' }) },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(controlPlaneLoader).not.toHaveBeenCalled();
    expect(actorLoader).not.toHaveBeenCalled();
  });

  it('continues composition and reaches the start Run handler after valid Promise params', async () => {
    const service = runService();
    controlPlaneLoader.mockReset().mockResolvedValue({
      service,
    } as unknown as Awaited<ReturnType<typeof getControlPlane>>);
    actorLoader.mockReset().mockResolvedValue(actor);

    const response = await postStartRunRoute(
      jsonRequest({ commandId, idempotencyKey: 'key', content: 'hello' }),
      { params: Promise.resolve({ sessionId }) },
    );

    expect(response.status).toBe(202);
    expect(controlPlaneLoader).toHaveBeenCalledExactlyOnceWith();
    expect(actorLoader).toHaveBeenCalledExactlyOnceWith();
    expect(service.startRun).toHaveBeenCalledExactlyOnceWith({
      actor,
      sessionId,
      commandId,
      idempotencyKey: 'key',
      content: 'hello',
    });
  });
});
