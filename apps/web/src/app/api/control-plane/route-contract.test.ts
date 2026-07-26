import { ControlPlaneApplicationError } from '@ai-super-canvas/control-plane';
import {
  AuthorizationError,
  CommandPayloadConflictError,
} from '@ai-super-canvas/db';
import type { ActorContext } from '@ai-super-canvas/core';
import { describe, expect, it, vi } from 'vitest';

import {
  makeBootstrapHandler,
  makeCreateSessionHandler,
} from './handlers';

const commandId = '550e8400-e29b-41d4-a716-446655440000';
const workflowId = '550e8400-e29b-41d4-a716-446655440001';
const agentBindingId = '550e8400-e29b-41d4-a716-446655440002';
const actor: ActorContext = {
  accountId: '550e8400-e29b-41d4-a716-446655440003',
  authSubject: 'local:owner',
};

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
