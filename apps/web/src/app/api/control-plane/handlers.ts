import type { SessionService } from '@ai-super-canvas/control-plane';
import type { ActorContext } from '@ai-super-canvas/core';
import { z } from 'zod';

import {
  errorResponse,
  noStoreJson,
  parseAfter,
  parseJson,
  parseUuid,
} from './http';

export const BootstrapSchema = z.object({
  commandId: z.uuid(),
  displayName: z.string().trim().min(1).max(120).default('本地测试用户'),
}).strict();

export const CreateSessionSchema = z.object({
  commandId: z.uuid(),
  workflowId: z.uuid(),
  agentBindingId: z.uuid(),
  title: z.string().trim().min(1).max(160),
}).strict();

export const StartRunSchema = z.object({
  commandId: z.uuid(),
  idempotencyKey: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(20_000),
}).strict();

export interface BootstrapHandlerDependencies {
  service: Pick<SessionService, 'bootstrapLocalAlpha'>;
  authSubject: string;
}

export interface CreateSessionHandlerDependencies {
  service: Pick<SessionService, 'createRootSession'>;
  actor: ActorContext;
}

export interface StartRunHandlerDependencies {
  service: Pick<SessionService, 'startRun'>;
  actor: ActorContext;
}

export interface RunEventsHandlerDependencies {
  service: Pick<SessionService, 'getRunEvents'>;
  actor: ActorContext;
}

export interface TranscriptHandlerDependencies {
  service: Pick<SessionService, 'getSessionTranscript'>;
  actor: ActorContext;
}

export function makeBootstrapHandler({
  service,
  authSubject,
}: BootstrapHandlerDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const body = await parseJson(request, BootstrapSchema);
      const result = await service.bootstrapLocalAlpha({
        ...body,
        authSubject,
      });
      return noStoreJson(result, { status: 200 });
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}

export function makeCreateSessionHandler({
  service,
  actor,
}: CreateSessionHandlerDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const body = await parseJson(request, CreateSessionSchema);
      const result = await service.createRootSession({ actor, ...body });
      return noStoreJson(result, { status: 201 });
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}

export function makeStartRunHandler({
  service,
  actor,
}: StartRunHandlerDependencies): (
  request: Request,
  context: { sessionId: string },
) => Promise<Response> {
  return async (request, { sessionId }) => {
    try {
      const parsedSessionId = parseUuid(sessionId);
      const body = await parseJson(request, StartRunSchema);
      const result = await service.startRun({
        actor,
        sessionId: parsedSessionId,
        ...body,
      });
      return noStoreJson(result, { status: 202 });
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}

export function makeRunEventsHandler({
  service,
  actor,
}: RunEventsHandlerDependencies): (
  request: Request,
  context: { runId: string },
) => Promise<Response> {
  return async (request, { runId }) => {
    try {
      const parsedRunId = parseUuid(runId);
      const after = parseAfter(request);
      const result = await service.getRunEvents({
        actor,
        runId: parsedRunId,
        after,
      });
      return noStoreJson(result);
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}

export function makeTranscriptHandler({
  service,
  actor,
}: TranscriptHandlerDependencies): (
  context: { sessionId: string },
) => Promise<Response> {
  return async ({ sessionId }) => {
    try {
      const parsedSessionId = parseUuid(sessionId);
      const result = await service.getSessionTranscript({
        actor,
        sessionId: parsedSessionId,
      });
      return noStoreJson(result);
    } catch (reason) {
      return errorResponse(reason);
    }
  };
}
