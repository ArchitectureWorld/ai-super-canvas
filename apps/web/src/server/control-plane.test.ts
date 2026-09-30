import type { ActorContext } from '@ai-super-canvas/core';
import { AuthorizationError } from '@ai-super-canvas/db';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  checkDatabaseReadinessWith,
  createControlPlaneContext,
  createControlPlaneLoader,
  createControlPlaneLoaders,
  localAuthSubject,
  resolveLocalActorContext,
  type ControlPlaneFactory,
  type DatabaseReadinessProbe,
  type ReadyRepository,
} from './control-plane';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function repository(
  overrides: Partial<DatabaseReadinessProbe & {
    close(): Promise<void>;
    resolveActorContext(input: {
      authSubject: string;
    }): Promise<ActorContext | null>;
  }> = {},
): ReadyRepository {
  return {
    checkReadiness: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    resolveActorContext: vi.fn(async () => null),
    ...overrides,
  } as unknown as ReadyRepository;
}

function factory(input: {
  repositories?: ReadyRepository[];
  reconcile?: Array<() => Promise<number>>;
} = {}) {
  const repositories = input.repositories ?? [repository()];
  const reconcile = input.reconcile ?? [async () => 0];
  let repositoryIndex = 0;
  let pumpIndex = 0;
  const runtime = { kind: 'runtime' };
  const service = { kind: 'service' };

  const result = {
    createRepository: vi.fn(() => {
      const value = repositories[repositoryIndex] ?? repositories.at(-1);
      repositoryIndex += 1;
      return value!;
    }),
    createRuntime: vi.fn(() => runtime),
    createEventPump: vi.fn(() => {
      const reconcileAfterRestart =
        reconcile[pumpIndex] ?? reconcile.at(-1);
      pumpIndex += 1;
      return {
        reconcileAfterRestart: vi.fn(reconcileAfterRestart),
      };
    }),
    createService: vi.fn(() => service),
  };

  return result as unknown as ControlPlaneFactory & typeof result;
}

describe('control-plane composition root', () => {
  it('shares one in-flight and fulfilled loader promise across concurrent callers', async () => {
    const pending = deferred<string>();
    const initialize = vi.fn(() => pending.promise);
    const load = createControlPlaneLoader(initialize);

    const first = load();
    const second = load();

    expect(first).toBe(second);
    expect(initialize).toHaveBeenCalledTimes(1);

    pending.resolve('ready');
    await expect(first).resolves.toBe('ready');
    await expect(load()).resolves.toBe('ready');
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('clears only a rejected loader attempt so a later call can retry', async () => {
    const initialize = vi.fn()
      .mockRejectedValueOnce(new Error('first attempt failed'))
      .mockResolvedValueOnce('recovered');
    const load = createControlPlaneLoader(initialize);

    await expect(load()).rejects.toThrow('first attempt failed');
    await expect(load()).resolves.toBe('recovered');
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('does not return a context until restart reconciliation completes', async () => {
    const repo = repository();
    const gate = deferred<number>();
    const configuredFactory = factory({
      repositories: [repo],
      reconcile: [() => gate.promise],
    });
    let settled = false;

    const loading = createControlPlaneContext({
      repository: repo,
      factory: configuredFactory,
    }).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    gate.resolve(3);
    const context = await loading;

    expect(context.repository).toBe(repo);
    expect(configuredFactory.createRuntime).toHaveBeenCalledTimes(1);
    expect(configuredFactory.createEventPump).toHaveBeenCalledTimes(1);
    expect(configuredFactory.createService).toHaveBeenCalledTimes(1);
  });

  it('closes the repository when context initialization fails', async () => {
    const close = vi.fn(async () => undefined);
    const repo = repository({ close });
    const original = new Error('restart reconciliation failed');
    const configuredFactory = factory({
      repositories: [repo],
      reconcile: [async () => {
        throw original;
      }],
    });

    await expect(createControlPlaneContext({
      repository: repo,
      factory: configuredFactory,
    })).rejects.toBe(original);
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });

  it('preserves the initialization error when closing also fails', async () => {
    const repo = repository({
      close: vi.fn(async () => {
        throw new Error('close failed');
      }),
    });
    const original = new Error('runtime construction failed');
    const configuredFactory = factory({ repositories: [repo] });
    configuredFactory.createRuntime.mockImplementationOnce(() => {
      throw original;
    });

    await expect(createControlPlaneContext({
      repository: repo,
      factory: configuredFactory,
    })).rejects.toBe(original);
  });

  it('keeps readiness repository-only and reuses that repository for the full context', async () => {
    const checkReadiness = vi.fn(async () => undefined);
    const repo = repository({ checkReadiness });
    const configuredFactory = factory({ repositories: [repo] });
    const getDatabaseUrl = vi.fn(() => 'postgres://canvas');
    const loaders = createControlPlaneLoaders({
      getDatabaseUrl,
      factory: configuredFactory,
    });

    await checkDatabaseReadinessWith(loaders.getRepository);
    await checkDatabaseReadinessWith(loaders.getRepository);

    expect(configuredFactory.createRepository).toHaveBeenCalledExactlyOnceWith(
      'postgres://canvas',
    );
    expect(getDatabaseUrl).toHaveBeenCalledTimes(1);
    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(checkReadiness).toHaveBeenNthCalledWith(1, 1000);
    expect(checkReadiness).toHaveBeenNthCalledWith(2, 1000);
    expect(configuredFactory.createRuntime).not.toHaveBeenCalled();
    expect(configuredFactory.createEventPump).not.toHaveBeenCalled();
    expect(configuredFactory.createService).not.toHaveBeenCalled();

    const context = await loaders.getControlPlane();

    expect(context.repository).toBe(repo);
    expect(configuredFactory.createRepository).toHaveBeenCalledTimes(1);
    expect(configuredFactory.createRuntime).toHaveBeenCalledTimes(1);
    expect(configuredFactory.createEventPump).toHaveBeenCalledTimes(1);
    expect(configuredFactory.createService).toHaveBeenCalledTimes(1);
    expect(
      configuredFactory.createEventPump.mock.results[0]?.value
        .reconcileAfterRestart,
    ).toHaveBeenCalledTimes(1);
  });

  it('discards a closed repository after failed context initialization', async () => {
    const firstRepository = repository();
    const secondRepository = repository();
    const original = new Error('first reconciliation failed');
    const configuredFactory = factory({
      repositories: [firstRepository, secondRepository],
      reconcile: [
        async () => {
          throw original;
        },
        async () => 0,
      ],
    });
    const loaders = createControlPlaneLoaders({
      getDatabaseUrl: () => 'postgres://canvas',
      factory: configuredFactory,
    });

    await expect(loaders.getControlPlane()).rejects.toBe(original);
    const context = await loaders.getControlPlane();

    expect(firstRepository.close).toHaveBeenCalledTimes(1);
    expect(context.repository).toBe(secondRepository);
    expect(configuredFactory.createRepository).toHaveBeenCalledTimes(2);
  });

  it('trims local server identity and defaults its subject', () => {
    expect(localAuthSubject({ AUTH_MODE: ' local ' })).toBe('local:owner');
    expect(localAuthSubject({
      AUTH_MODE: ' local ',
      APP_OWNER_SUBJECT: ' local:primary ',
    })).toBe('local:primary');
  });

  it.each([
    { environment: {}, description: 'missing auth mode' },
    {
      environment: { AUTH_MODE: 'LOCAL' },
      description: 'non-local auth mode',
    },
    {
      environment: { AUTH_MODE: 'oauth' },
      description: 'different auth mode',
    },
    {
      environment: { AUTH_MODE: 'local', APP_OWNER_SUBJECT: '   ' },
      description: 'empty subject',
    },
    {
      environment: {
        AUTH_MODE: 'local',
        APP_OWNER_SUBJECT: 'oauth:owner',
      },
      description: 'non-local subject',
    },
    {
      environment: { AUTH_MODE: 'local', APP_OWNER_SUBJECT: 'local:' },
      description: 'empty local identity',
    },
  ] as const)('fails closed for $description', ({ environment }) => {
    expect(() => localAuthSubject(environment)).toThrow(AuthorizationError);
  });

  it('resolves an actor using only the server-owned auth subject', async () => {
    const actor = {
      accountId: '550e8400-e29b-41d4-a716-446655440000',
      authSubject: 'local:owner',
    };
    const resolveActorContext = vi.fn(async () => actor);
    const repo = repository({ resolveActorContext });

    await expect(
      resolveLocalActorContext(repo, 'local:owner'),
    ).resolves.toEqual(actor);
    expect(resolveActorContext).toHaveBeenCalledExactlyOnceWith({
      authSubject: 'local:owner',
    });
  });

  it('rejects a missing local actor', async () => {
    const repo = repository({
      resolveActorContext: vi.fn(async () => null),
    });

    await expect(
      resolveLocalActorContext(repo, 'local:missing'),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
