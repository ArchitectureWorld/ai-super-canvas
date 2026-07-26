import { z } from 'zod';
import {
  ControlPlaneApplicationError,
} from '@ai-super-canvas/control-plane';
import {
  ActiveRunConflictError,
  AuthorizationError,
  CommandPayloadConflictError,
  RunIdempotencyConflictError,
  RunStateConflictError,
} from '@ai-super-canvas/db';
import { describe, expect, it, vi } from 'vitest';

import {
  HttpError,
  errorResponse,
  noStoreJson,
  parseAfter,
  parseJson,
  parseUuid,
} from './http';

const request = (body: string) => new Request('http://localhost', { body, method: 'POST' });

async function responseBody(response: Response) {
  return response.json() as Promise<{
    error?: { code: string; message: string; retryable: boolean };
    commandReceiptId?: string;
  }>;
}

describe('control-plane HTTP boundary', () => {
  it('maps malformed JSON to a sanitized no-store 400 response', async () => {
    const reason = await parseJson(request('{'), z.object({ name: z.string() })).catch(
      (error: unknown) => error,
    );
    const response = errorResponse(reason);

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({
      error: { code: 'malformed_json', message: 'Request body must be valid JSON', retryable: false },
    });
  });

  it('rejects server-owned fields with a strict request schema', async () => {
    const reason = await parseJson(
      request(JSON.stringify({ clientValue: 'ok', serverOwned: 'forged' })),
      z.object({ clientValue: z.string() }).strict(),
    ).catch((error: unknown) => error);
    const response = errorResponse(reason);

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({
      error: { code: 'invalid_request', message: 'Request validation failed', retryable: false },
    });
  });

  it.each([
    [new CommandPayloadConflictError('command-1'), 'command_payload_conflict'],
    [new ActiveRunConflictError('session-1'), 'active_run_conflict'],
    [new RunIdempotencyConflictError('key-1'), 'run_idempotency_conflict'],
    [new RunStateConflictError('internal state detail'), 'run_state_conflict'],
  ])('sanitizes %s as a stable conflict response', async (reason, code) => {
    const response = errorResponse(reason);

    expect(response.status).toBe(409);
    expect(await responseBody(response)).toEqual({
      error: { code, message: 'Request conflicts with the current server state', retryable: false },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('sanitizes authorization errors as not found', async () => {
    const response = errorResponse(new AuthorizationError());

    expect(response.status).toBe(404);
    expect(await responseBody(response)).toEqual({
      error: { code: 'not_found', message: 'Resource not found', retryable: false },
    });
  });

  it.each([
    ['command_requires_reconciliation', true, 202, 'receipt-1'],
    ['command_persistence_unconfirmed', true, 202, 'receipt-1'],
    ['runtime_session_unavailable', false, 409, undefined],
    ['runtime_operation_failed', true, 500, undefined],
  ] as const)('maps application error %s with its stable retryability', async (code, retryable, status, receiptId) => {
    const response = errorResponse(new ControlPlaneApplicationError(code, 'safe application message', retryable, receiptId));
    const body = await responseBody(response);

    expect(response.status).toBe(status);
    expect(body.error).toEqual({
      code,
      message: 'safe application message',
      retryable,
    });
    if (status === 202) {
      expect(response.headers.get('retry-after')).toBe('2');
      expect(body.commandReceiptId).toBe('receipt-1');
    }
  });

  it('omits commandReceiptId from an accepted response when none is available', async () => {
    const response = errorResponse(
      new ControlPlaneApplicationError(
        'command_requires_reconciliation',
        'safe application message',
        true,
      ),
    );
    const body = await responseBody(response);

    expect(response.status).toBe(202);
    expect(body).not.toHaveProperty('commandReceiptId');
  });

  it('does not leak unexpected errors and logs only their name', async () => {
    const logger = { error: vi.fn() };
    const response = errorResponse(new Error('database password is secret'), logger);

    expect(response.status).toBe(500);
    expect(await responseBody(response)).toEqual({
      error: { code: 'internal_error', message: 'An unexpected error occurred', retryable: false },
    });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('control_plane_request_failed', { errorName: 'Error' });
  });

  it('uses the default logger without leaking the unexpected error', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      errorResponse(new Error('database password is secret'));

      expect(consoleError).toHaveBeenCalledExactlyOnceWith(
        'control_plane_request_failed',
        { errorName: 'Error' },
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('accepts only UUID values', () => {
    expect(parseUuid('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(() => parseUuid('not-a-uuid')).toThrow(new HttpError(400, 'invalid_request', 'Request validation failed'));
  });

  it('accepts only non-negative safe integer pagination offsets', () => {
    expect(parseAfter(new Request('http://localhost'))).toBe(0);
    expect(parseAfter(new Request('http://localhost?after=12'))).toBe(12);
    for (const value of ['-1', '1.5', '9007199254740992', 'abc']) {
      expect(() => parseAfter(new Request(`http://localhost?after=${value}`))).toThrow(
        new HttpError(400, 'invalid_request', 'Request validation failed'),
      );
    }
  });

  it('forces no-store JSON while retaining response status and other headers', async () => {
    const response = noStoreJson({ ok: true }, { status: 201, headers: { 'X-Request-Id': 'request-1', 'Cache-Control': 'public, max-age=60' } });

    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('request-1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ ok: true });
  });
});
