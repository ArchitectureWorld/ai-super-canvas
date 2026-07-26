import type { SessionService } from '@ai-super-canvas/control-plane';
import type { ActorContext } from '@ai-super-canvas/core';
import { z } from 'zod';

import { errorResponse, noStoreJson, parseJson } from './http';

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

export interface BootstrapHandlerDependencies {
  service: Pick<SessionService, 'bootstrapLocalAlpha'>;
  authSubject: string;
}

export interface CreateSessionHandlerDependencies {
  service: Pick<SessionService, 'createRootSession'>;
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
