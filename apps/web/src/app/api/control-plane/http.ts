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
import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface SafeErrorLogger {
  error(event: string, context: { errorName: string }): void;
}

const defaultLogger: SafeErrorLogger = {
  error(event, context) {
    console.error(event, context);
  },
};

const invalidRequest = () =>
  new HttpError(400, 'invalid_request', 'Request validation failed');

function assertTrustedJsonRequest(request: Request): void {
  const mediaType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== 'application/json') {
    throw new HttpError(
      415,
      'unsupported_media_type',
      'Request body must use application/json',
    );
  }

  const origin = request.headers.get('origin');
  if (!origin) return;

  let parsedOrigin: string;
  try {
    parsedOrigin = new URL(origin).origin;
  } catch {
    throw new HttpError(
      403,
      'forbidden_origin',
      'Cross-origin requests are not allowed',
    );
  }

  if (parsedOrigin !== new URL(request.url).origin) {
    throw new HttpError(
      403,
      'forbidden_origin',
      'Cross-origin requests are not allowed',
    );
  }
}

export async function parseJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.output<T>> {
  assertTrustedJsonRequest(request);

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new HttpError(
      400,
      'malformed_json',
      'Request body must be valid JSON',
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

export function parseUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw invalidRequest();
  }

  return value;
}

export function parseAfter(request: Request): number {
  const value = new URL(request.url).searchParams.get('after') ?? '0';
  if (!/^\d+$/.test(value)) throw invalidRequest();

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidRequest();
  return parsed;
}

export function noStoreJson(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function errorBody(code: string, message: string, retryable = false) {
  return { error: { code, message, retryable } };
}

function conflictResponse(code: string): Response {
  return noStoreJson(
    errorBody(code, 'Request conflicts with the current server state'),
    { status: 409 },
  );
}

function applicationErrorBody(reason: ControlPlaneApplicationError) {
  return {
    ...errorBody(reason.code, reason.message, reason.retryable),
    ...(reason.commandReceiptId
      ? { commandReceiptId: reason.commandReceiptId }
      : {}),
  };
}

export function errorResponse(
  reason: unknown,
  logger: SafeErrorLogger = defaultLogger,
): Response {
  if (reason instanceof HttpError) {
    return noStoreJson(errorBody(reason.code, reason.message, reason.retryable), {
      status: reason.status,
    });
  }

  if (reason instanceof CommandPayloadConflictError) {
    return conflictResponse('command_payload_conflict');
  }
  if (reason instanceof ActiveRunConflictError) {
    return conflictResponse('active_run_conflict');
  }
  if (reason instanceof RunIdempotencyConflictError) {
    return conflictResponse('run_idempotency_conflict');
  }
  if (reason instanceof RunStateConflictError) {
    return conflictResponse('run_state_conflict');
  }
  if (reason instanceof AuthorizationError) {
    return noStoreJson(errorBody('not_found', 'Resource not found'), { status: 404 });
  }

  if (reason instanceof ControlPlaneApplicationError) {
    if (
      reason.code === 'command_requires_reconciliation' ||
      reason.code === 'command_persistence_unconfirmed'
    ) {
      return noStoreJson(
        applicationErrorBody(reason),
        { status: 202, headers: { 'Retry-After': '2' } },
      );
    }

    if (reason.code === 'runtime_session_unavailable') {
      return noStoreJson(
        applicationErrorBody(reason),
        { status: 409 },
      );
    }

    return noStoreJson(
      applicationErrorBody(reason),
      { status: 500 },
    );
  }

  const errorName = reason instanceof Error ? reason.name : 'UnknownError';
  logger.error('control_plane_request_failed', { errorName });
  return noStoreJson(
    errorBody('internal_error', 'An unexpected error occurred'),
    { status: 500 },
  );
}
