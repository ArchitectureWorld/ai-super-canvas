import 'server-only';

import {
  DeterministicFakeRuntime,
  type RuntimeAdapter,
} from '@ai-super-canvas/ai';
import {
  RunEventPump,
  SessionService,
} from '@ai-super-canvas/control-plane';
import type { ActorContext } from '@ai-super-canvas/core';
import {
  AuthorizationError,
  createPostgresControlPlaneRepository,
  requireDatabaseUrl,
  type ControlPlaneRepository,
} from '@ai-super-canvas/db';

export interface DatabaseReadinessProbe {
  checkReadiness(timeoutMs?: number): Promise<void>;
}

export type ReadyRepository =
  ControlPlaneRepository
  & DatabaseReadinessProbe;

export interface ControlPlaneContext {
  repository: ReadyRepository;
  runtime: RuntimeAdapter;
  eventPump: RunEventPump;
  service: SessionService;
}

export interface ControlPlaneFactory {
  createRepository(databaseUrl: string): ReadyRepository;
  createRuntime(): RuntimeAdapter;
  createEventPump(
    repository: ControlPlaneRepository,
    runtime: RuntimeAdapter,
  ): RunEventPump;
  createService(
    repository: ControlPlaneRepository,
    runtime: RuntimeAdapter,
    eventPump: RunEventPump,
  ): SessionService;
}

export const defaultControlPlaneFactory: ControlPlaneFactory = {
  createRepository(databaseUrl) {
    return createPostgresControlPlaneRepository(databaseUrl);
  },
  createRuntime() {
    return new DeterministicFakeRuntime();
  },
  createEventPump(repository, runtime) {
    return new RunEventPump(repository, runtime);
  },
  createService(repository, runtime, eventPump) {
    return new SessionService(repository, runtime, eventPump);
  },
};

export async function createControlPlaneContext(input: {
  repository: ReadyRepository;
  factory?: ControlPlaneFactory;
}): Promise<ControlPlaneContext> {
  const factory = input.factory ?? defaultControlPlaneFactory;

  try {
    const runtime = factory.createRuntime();
    const eventPump = factory.createEventPump(input.repository, runtime);
    const service = factory.createService(
      input.repository,
      runtime,
      eventPump,
    );
    await eventPump.reconcileAfterRestart();
    return {
      repository: input.repository,
      runtime,
      eventPump,
      service,
    };
  } catch (reason) {
    try {
      await input.repository.close();
    } catch {
      // Initialization failure remains authoritative over cleanup failure.
    }
    throw reason;
  }
}

export type ControlPlaneLoader<T> =
  (() => Promise<T>)
  & { clear(): void };

export function createControlPlaneLoader<T>(
  factory: () => T | Promise<T>,
): ControlPlaneLoader<T> {
  let cached: Promise<T> | undefined;

  const load = (() => {
    if (cached) return cached;

    let attempt: Promise<T>;
    try {
      attempt = Promise.resolve(factory());
    } catch (reason) {
      attempt = Promise.reject(reason);
    }
    cached = attempt;
    void attempt.catch(() => {
      if (cached === attempt) cached = undefined;
    });
    return attempt;
  }) as ControlPlaneLoader<T>;

  load.clear = () => {
    cached = undefined;
  };
  return load;
}

export interface ControlPlaneLoaders {
  getRepository: ControlPlaneLoader<ReadyRepository>;
  getControlPlane: ControlPlaneLoader<ControlPlaneContext>;
}

export function createControlPlaneLoaders(input: {
  getDatabaseUrl: () => string;
  factory?: ControlPlaneFactory;
}): ControlPlaneLoaders {
  const factory = input.factory ?? defaultControlPlaneFactory;
  const getRepository = createControlPlaneLoader(() =>
    factory.createRepository(input.getDatabaseUrl()));
  const getControlPlane = createControlPlaneLoader(async () => {
    const repository = await getRepository();
    try {
      return await createControlPlaneContext({ repository, factory });
    } catch (reason) {
      getRepository.clear();
      throw reason;
    }
  });
  return { getRepository, getControlPlane };
}

export function localAuthSubject(
  environment: {
    AUTH_MODE?: string;
    APP_OWNER_SUBJECT?: string;
  } = {
    AUTH_MODE: process.env.AUTH_MODE,
    APP_OWNER_SUBJECT: process.env.APP_OWNER_SUBJECT,
  },
): string {
  if (environment.AUTH_MODE?.trim() !== 'local') {
    throw new AuthorizationError();
  }

  const authSubject =
    environment.APP_OWNER_SUBJECT === undefined
      ? 'local:owner'
      : environment.APP_OWNER_SUBJECT.trim();
  if (!/^local:.+/.test(authSubject)) {
    throw new AuthorizationError();
  }
  return authSubject;
}

export async function resolveLocalActorContext(
  repository: ControlPlaneRepository,
  authSubject: string,
): Promise<ActorContext> {
  const actor = await repository.resolveActorContext({ authSubject });
  if (!actor) throw new AuthorizationError();
  return actor;
}

const controlPlaneGlobal = globalThis as typeof globalThis & {
  __aiSuperCanvasControlPlaneLoaders?: ControlPlaneLoaders;
};

const productionLoaders =
  controlPlaneGlobal.__aiSuperCanvasControlPlaneLoaders
  ?? createControlPlaneLoaders({
    getDatabaseUrl: () => requireDatabaseUrl(),
  });
controlPlaneGlobal.__aiSuperCanvasControlPlaneLoaders = productionLoaders;

export const getRepository = productionLoaders.getRepository;
export const getControlPlane = productionLoaders.getControlPlane;

export async function getLocalActorContext(): Promise<ActorContext> {
  const repository = await getRepository();
  return resolveLocalActorContext(repository, localAuthSubject());
}

export async function checkDatabaseReadinessWith(
  loadRepository: () => Promise<ReadyRepository>,
): Promise<void> {
  const repository = await loadRepository();
  await repository.checkReadiness(1000);
}

export async function checkDatabaseReadiness(): Promise<void> {
  await checkDatabaseReadinessWith(getRepository);
}
