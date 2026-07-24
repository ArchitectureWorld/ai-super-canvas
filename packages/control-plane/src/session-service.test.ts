import {
  DeterministicFakeRuntime,
  RuntimeAdapterError,
  type RuntimeAdapter,
} from '@ai-super-canvas/ai';
import type { ActorContext } from '@ai-super-canvas/core';
import type { ControlPlaneRepository } from '@ai-super-canvas/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ControlPlaneApplicationError } from './errors';
import type { RunEventPumpPort } from './run-event-pump';
import { SessionService } from './session-service';

const actor: ActorContext = {
  accountId: '11111111-1111-4111-8111-111111111111',
  authSubject: 'local:test-owner',
};

const ids = {
  commandId: '22222222-2222-4222-8222-222222222222',
  receiptId: '33333333-3333-4333-8333-333333333333',
  workflowId: '44444444-4444-4444-8444-444444444444',
  bindingId: '55555555-5555-4555-8555-555555555555',
  agentId: '66666666-6666-4666-8666-666666666666',
  sessionId: '77777777-7777-4777-8777-777777777777',
  nodeId: '88888888-8888-4888-8888-888888888888',
};

function sessionContext() {
  return {
    sessionId: ids.sessionId,
    workflowId: ids.workflowId,
    status: 'provisioning',
    binding: {
      agentBindingId: ids.bindingId,
      agentId: ids.agentId,
      runtimeKind: 'fake',
      isolationKey: 'local-alpha',
      endpointRef: null,
      secretRef: null,
    },
    externalSessionRef: null,
    expectedHistoryDigest: null,
    config: {
      id: '99999999-9999-4999-8999-999999999999',
      sessionId: ids.sessionId,
      version: 1,
      modelEntryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      model: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        runtimeKind: 'fake',
        providerKey: 'fake',
        modelKey: 'deterministic-v1',
        displayName: 'Deterministic Fake v1',
        capabilities: {},
      },
      instructionsOverlay: null,
      toolPolicy: {
        allowedToolKeys: [],
        deniedToolKeys: [],
        approvalRequiredToolKeys: [],
      },
      contextPolicy: {},
    },
    context: [],
  };
}

function createSessionRepository() {
  return {
    bootstrapLocalAlpha: vi.fn().mockResolvedValue({
      accountId: actor.accountId,
      authSubject: actor.authSubject,
      agentId: ids.agentId,
      agentBindingId: ids.bindingId,
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workflowId: ids.workflowId,
      trunkRevisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      defaultModelEntryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }),
    createRootSession: vi.fn().mockResolvedValue({
      commandReceiptId: ids.receiptId,
      phase: 'canvas_prepared',
      sessionId: ids.sessionId,
      nodeId: ids.nodeId,
      status: 'provisioning',
      config: sessionContext().config,
    }),
    beginRuntimeDispatch: vi.fn().mockResolvedValue({
      phase: 'runtime_dispatched',
      dispatchAllowed: true,
    }),
    getSessionRuntimeContext: vi.fn().mockResolvedValue(sessionContext()),
    recordRuntimeResourceKnown: vi.fn().mockResolvedValue(undefined),
    attachRuntimeSession: vi.fn().mockResolvedValue(undefined),
    markRuntimeCommandFailure: vi.fn().mockResolvedValue(undefined),
    markRuntimeCommandReconciling: vi.fn().mockResolvedValue(undefined),
  };
}

const pump: RunEventPumpPort = {
  start: vi.fn().mockReturnValue('started'),
};

describe('SessionService Session creation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('seeds only the server-owned Fake model', async () => {
    const repository = createSessionRepository();
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      new DeterministicFakeRuntime(),
      pump,
    );
    const request = {
      commandId: ids.commandId,
      authSubject: actor.authSubject,
      availableModels: [{
        providerKey: 'attacker',
        modelKey: 'attacker-model',
        displayName: 'Attacker model',
      }],
      defaultModelProviderKey: 'attacker',
      defaultModelKey: 'attacker-model',
      actor: {
        accountId: 'attacker-account',
        authSubject: 'attacker-subject',
      },
      toolPolicy: {
        allowedToolKeys: ['shell'],
      },
      binding: {
        endpointRef: 'https://attacker.invalid',
        secretRef: 'secretRef:SENTINEL-SECRET',
      },
    };

    await service.bootstrapLocalAlpha(request);

    expect(repository.bootstrapLocalAlpha).toHaveBeenCalledWith({
      commandId: ids.commandId,
      authSubject: actor.authSubject,
      displayName: 'Local Alpha',
      availableModels: [{
        providerKey: 'fake',
        modelKey: 'deterministic-v1',
        displayName: 'Deterministic Fake v1',
        capabilities: { text: true, tools: false },
      }],
      defaultModelProviderKey: 'fake',
      defaultModelKey: 'deterministic-v1',
    });
  });

  it('records a Runtime Session ref before attach and dispatches once on replay', async () => {
    const repository = createSessionRepository();
    const runtime = new DeterministicFakeRuntime();
    const createSpy = vi.spyOn(runtime, 'createSession');
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime,
      pump,
    );
    const request = {
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    };

    const first = await service.createRootSession(request);
    repository.createRootSession.mockResolvedValueOnce({
      commandReceiptId: ids.receiptId,
      phase: 'attached',
      sessionId: ids.sessionId,
      nodeId: ids.nodeId,
      status: 'active',
      config: sessionContext().config,
    });
    const replay = await service.createRootSession(request);

    expect(first).toEqual({
      sessionId: ids.sessionId,
      nodeId: ids.nodeId,
      status: 'active',
    });
    expect(replay).toEqual(first);
    expect(repository.createRootSession).toHaveBeenCalledTimes(2);
    expect(repository.beginRuntimeDispatch).toHaveBeenCalledOnce();
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(repository.getSessionRuntimeContext).toHaveBeenCalledOnce();
    expect(repository.createRootSession.mock.invocationCallOrder[0])
      .toBeLessThan(repository.beginRuntimeDispatch.mock.invocationCallOrder[0]!);
    expect(repository.beginRuntimeDispatch.mock.invocationCallOrder[0])
      .toBeLessThan(createSpy.mock.invocationCallOrder[0]!);
    expect(createSpy.mock.invocationCallOrder[0])
      .toBeLessThan(repository.recordRuntimeResourceKnown.mock.invocationCallOrder[0]!);
    expect(repository.recordRuntimeResourceKnown.mock.invocationCallOrder[0])
      .toBeLessThan(repository.attachRuntimeSession.mock.invocationCallOrder[0]!);
    expect(pump.start).not.toHaveBeenCalled();
  });

  it('does not dispatch when the Repository lease denies dispatch', async () => {
    const repository = createSessionRepository();
    repository.beginRuntimeDispatch.mockResolvedValueOnce({
      phase: 'reconciling',
      dispatchAllowed: false,
    });
    const runtime = new DeterministicFakeRuntime();
    const createSpy = vi.spyOn(runtime, 'createSession');
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime,
      pump,
    );

    await expect(service.createRootSession({
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    })).rejects.toMatchObject({
      code: 'command_requires_reconciliation',
      message: 'Runtime command requires reconciliation',
      commandReceiptId: ids.receiptId,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(createSpy).not.toHaveBeenCalled();
    expect(repository.getSessionRuntimeContext).not.toHaveBeenCalled();
  });

  it('marks not-applied failures without entering reconciliation', async () => {
    const repository = createSessionRepository();
    const runtime = {
      createSession: vi.fn().mockRejectedValue(
        new RuntimeAdapterError(
          'runtime_unavailable',
          'offline',
          true,
          'not-applied',
        ),
      ),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    await expect(service.createRootSession({
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    })).rejects.toMatchObject({
      code: 'runtime_operation_failed',
      message: 'Runtime operation failed',
      retryable: true,
      cause: undefined,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(repository.markRuntimeCommandFailure).toHaveBeenCalledWith({
      actor,
      commandReceiptId: ids.receiptId,
      retryable: true,
      error: 'runtime_adapter:runtime_unavailable:not-applied',
    });
    expect(repository.markRuntimeCommandReconciling).not.toHaveBeenCalled();
  });

  it('persists unknown adapter outcomes as reconciliation and returns a safe error', async () => {
    const repository = createSessionRepository();
    const secretSentinel = 'secretRef:SENTINEL-SECRET';
    const runtime = {
      createSession: vi.fn().mockRejectedValue(
        new RuntimeAdapterError(
          'runtime_unavailable',
          `internal endpoint timed out ${secretSentinel}`,
          true,
          'unknown',
        ),
      ),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    const failure = service.createRootSession({
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    });
    await expect(failure).rejects.toMatchObject({
      code: 'command_requires_reconciliation',
      message: 'Runtime command requires reconciliation',
      commandReceiptId: ids.receiptId,
      cause: undefined,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith({
      actor,
      commandReceiptId: ids.receiptId,
      externalResourceKind: 'session',
      lookupMetadata: {
        commandId: ids.commandId,
        canvasSessionId: ids.sessionId,
      },
      error: 'runtime_adapter:runtime_unavailable:unknown',
    });
    expect(JSON.stringify(
      repository.markRuntimeCommandReconciling.mock.calls,
    )).not.toContain(secretSentinel);
    expect(repository.markRuntimeCommandFailure).not.toHaveBeenCalled();
  });

  it('persists ordinary unknown failures as reconciliation without leaking details', async () => {
    const repository = createSessionRepository();
    const secretSentinel = 'externalSessionRef:SENTINEL-EXTERNAL';
    const runtime = {
      createSession: vi.fn().mockRejectedValue(
        new Error(`socket failed ${secretSentinel}`),
      ),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    const failure = service.createRootSession({
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    });
    await expect(failure).rejects.toMatchObject({
      code: 'command_requires_reconciliation',
      message: 'Runtime command requires reconciliation',
      commandReceiptId: ids.receiptId,
      cause: undefined,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith(
      expect.objectContaining({
        externalResourceKind: 'session',
        error: 'runtime_session_create_failed',
      }),
    );
    expect(JSON.stringify(
      repository.markRuntimeCommandReconciling.mock.calls,
    )).not.toContain(secretSentinel);
    expect(repository.markRuntimeCommandFailure).not.toHaveBeenCalled();
  });

  it('records a known external ref when attach persistence loses its response', async () => {
    const repository = createSessionRepository();
    repository.attachRuntimeSession.mockRejectedValueOnce(
      new Error('database response lost'),
    );
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      new DeterministicFakeRuntime(),
      pump,
    );

    await expect(service.createRootSession({
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    })).rejects.toMatchObject({
      code: 'command_requires_reconciliation',
      commandReceiptId: ids.receiptId,
      cause: undefined,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith(
      expect.objectContaining({
        externalResourceKind: 'session',
        externalResourceRef: expect.stringMatching(/^fake-session-/),
        error: 'runtime_session_attach_failed',
      }),
    );
  });

  it('returns the attached Session when a competing dispatch wins the lease race', async () => {
    const repository = createSessionRepository();
    repository.beginRuntimeDispatch.mockResolvedValueOnce({
      phase: 'attached',
      dispatchAllowed: false,
    });
    const runtime = new DeterministicFakeRuntime();
    const createSpy = vi.spyOn(runtime, 'createSession');
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime,
      pump,
    );

    await expect(service.createRootSession({
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    })).resolves.toEqual({
      sessionId: ids.sessionId,
      nodeId: ids.nodeId,
      status: 'active',
    });
    expect(createSpy).not.toHaveBeenCalled();
    expect(repository.getSessionRuntimeContext).not.toHaveBeenCalled();
    expect(repository.markRuntimeCommandReconciling).not.toHaveBeenCalled();
  });

  it('reconciles a context-load failure after the dispatch lease without leaking it', async () => {
    const repository = createSessionRepository();
    const secretSentinel = 'secretRef:SENTINEL-CONTEXT-LOAD';
    repository.getSessionRuntimeContext.mockRejectedValueOnce(
      new Error(`context database failed ${secretSentinel}`),
    );
    const runtime = new DeterministicFakeRuntime();
    const createSpy = vi.spyOn(runtime, 'createSession');
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime,
      pump,
    );

    const failure = service.createRootSession({
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    });
    await expect(failure).rejects.toMatchObject({
      code: 'command_requires_reconciliation',
      message: 'Runtime command requires reconciliation',
      commandReceiptId: ids.receiptId,
      cause: undefined,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(createSpy).not.toHaveBeenCalled();
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith({
      actor,
      commandReceiptId: ids.receiptId,
      externalResourceKind: 'session',
      lookupMetadata: {
        commandId: ids.commandId,
        canvasSessionId: ids.sessionId,
      },
      error: 'runtime_session_context_load_failed',
    });
    expect(JSON.stringify(
      repository.markRuntimeCommandReconciling.mock.calls,
    )).not.toContain(secretSentinel);
  });

  it('returns a safe error when reconciliation persistence also fails', async () => {
    const repository = createSessionRepository();
    const contextSentinel = 'externalSessionRef:SENTINEL-CONTEXT';
    const persistenceSentinel = 'secretRef:SENTINEL-RECONCILIATION';
    repository.getSessionRuntimeContext.mockRejectedValueOnce(
      new Error(`context database failed ${contextSentinel}`),
    );
    repository.markRuntimeCommandReconciling.mockRejectedValueOnce(
      new Error(`reconciliation failed ${persistenceSentinel}`),
    );
    const runtime = new DeterministicFakeRuntime();
    const createSpy = vi.spyOn(runtime, 'createSession');
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime,
      pump,
    );

    let caught: unknown;
    try {
      await service.createRootSession({
        actor,
        commandId: ids.commandId,
        workflowId: ids.workflowId,
        agentBindingId: ids.bindingId,
        title: 'Main Session',
      });
    } catch (reason) {
      caught = reason;
    }

    expect(caught).toMatchObject({
      code: 'command_requires_reconciliation',
      message: 'Runtime command requires reconciliation',
      commandReceiptId: ids.receiptId,
      cause: undefined,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(String(caught)).not.toContain(contextSentinel);
    expect(String(caught)).not.toContain(persistenceSentinel);
    expect(createSpy).not.toHaveBeenCalled();
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'runtime_session_context_load_failed',
      }),
    );
  });

  it('retries reconciliation persistence on a runtime-dispatched replay without redispatch', async () => {
    const repository = createSessionRepository();
    repository.beginRuntimeDispatch
      .mockResolvedValueOnce({
        phase: 'runtime_dispatched',
        dispatchAllowed: true,
      })
      .mockResolvedValueOnce({
        phase: 'runtime_dispatched',
        dispatchAllowed: false,
      });
    const runtimeSentinel = 'externalSessionRef:SENTINEL-RUNTIME';
    const persistenceSentinel = 'secretRef:SENTINEL-PERSISTENCE';
    repository.markRuntimeCommandReconciling
      .mockRejectedValueOnce(
        new Error(`reconciliation failed ${persistenceSentinel}`),
      )
      .mockResolvedValueOnce(undefined);
    const runtime = {
      createSession: vi.fn().mockRejectedValue(
        new Error(`runtime response lost ${runtimeSentinel}`),
      ),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );
    const request = {
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    };

    const failures: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await service.createRootSession(request);
      } catch (reason) {
        failures.push(reason);
      }
    }

    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure).toMatchObject({
        code: 'command_requires_reconciliation',
        message: 'Runtime command requires reconciliation',
        commandReceiptId: ids.receiptId,
        cause: undefined,
      } satisfies Partial<ControlPlaneApplicationError>);
      expect(String(failure)).not.toContain(runtimeSentinel);
      expect(String(failure)).not.toContain(persistenceSentinel);
    }
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(repository.getSessionRuntimeContext).toHaveBeenCalledOnce();
    expect(repository.beginRuntimeDispatch).toHaveBeenCalledTimes(2);
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledTimes(2);
    expect(repository.markRuntimeCommandReconciling).toHaveBeenNthCalledWith(
      2,
      {
        actor,
        commandReceiptId: ids.receiptId,
        externalResourceKind: 'session',
        lookupMetadata: {
          commandId: ids.commandId,
          canvasSessionId: ids.sessionId,
        },
        error: 'runtime_dispatch_persistence_unconfirmed',
      },
    );
    expect(JSON.stringify(
      repository.markRuntimeCommandReconciling.mock.calls,
    )).not.toContain(runtimeSentinel);
    expect(JSON.stringify(
      repository.markRuntimeCommandReconciling.mock.calls,
    )).not.toContain(persistenceSentinel);
  });

  it('downgrades an unconfirmed not-applied failure to reconciliation', async () => {
    const repository = createSessionRepository();
    const runtimeSentinel = 'externalSessionRef:SENTINEL-NOT-APPLIED';
    const persistenceSentinel = 'secretRef:SENTINEL-FAILURE-PERSISTENCE';
    repository.markRuntimeCommandFailure.mockRejectedValueOnce(
      new Error(`failure persistence lost ${persistenceSentinel}`),
    );
    const runtime = {
      createSession: vi.fn().mockRejectedValue(
        new RuntimeAdapterError(
          'runtime_unavailable',
          `runtime offline ${runtimeSentinel}`,
          true,
          'not-applied',
        ),
      ),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    let caught: unknown;
    try {
      await service.createRootSession({
        actor,
        commandId: ids.commandId,
        workflowId: ids.workflowId,
        agentBindingId: ids.bindingId,
        title: 'Main Session',
      });
    } catch (reason) {
      caught = reason;
    }

    expect(caught).toMatchObject({
      code: 'command_requires_reconciliation',
      message: 'Runtime command requires reconciliation',
      commandReceiptId: ids.receiptId,
      cause: undefined,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(String(caught)).not.toContain(runtimeSentinel);
    expect(String(caught)).not.toContain(persistenceSentinel);
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(repository.markRuntimeCommandFailure).toHaveBeenCalledOnce();
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith({
      actor,
      commandReceiptId: ids.receiptId,
      externalResourceKind: 'session',
      lookupMetadata: {
        commandId: ids.commandId,
        canvasSessionId: ids.sessionId,
      },
      error: 'runtime_adapter:runtime_unavailable:not-applied',
    });
    expect(JSON.stringify({
      failure: repository.markRuntimeCommandFailure.mock.calls,
      reconciliation: repository.markRuntimeCommandReconciling.mock.calls,
    })).not.toContain(runtimeSentinel);
    expect(JSON.stringify({
      failure: repository.markRuntimeCommandFailure.mock.calls,
      reconciliation: repository.markRuntimeCommandReconciling.mock.calls,
    })).not.toContain(persistenceSentinel);
  });
  it('coalesces concurrent dispatches for the same receipt while Runtime creation is in flight', async () => {
    const repository = createSessionRepository();
    repository.beginRuntimeDispatch
      .mockResolvedValueOnce({
        phase: 'runtime_dispatched',
        dispatchAllowed: true,
      })
      .mockResolvedValueOnce({
        phase: 'runtime_dispatched',
        dispatchAllowed: false,
      });
    let resolveRuntimeSession: (value: {
      externalSessionRef: string;
      historyDigest: string;
    }) => void;
    const runtime = {
      createSession: vi.fn().mockImplementation(
        () => new Promise((resolve) => {
          resolveRuntimeSession = resolve;
        }),
      ),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );
    const request = {
      actor,
      commandId: ids.commandId,
      workflowId: ids.workflowId,
      agentBindingId: ids.bindingId,
      title: 'Main Session',
    };

    const first = service.createRootSession(request);
    await vi.waitFor(() => {
      expect(runtime.createSession).toHaveBeenCalledOnce();
    });
    const second = service.createRootSession(request);
    resolveRuntimeSession!({
      externalSessionRef: 'fake-session-coalesced',
      historyDigest: 'fake-history-coalesced',
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { sessionId: ids.sessionId, nodeId: ids.nodeId, status: 'active' },
      { sessionId: ids.sessionId, nodeId: ids.nodeId, status: 'active' },
    ]);
    expect(repository.createRootSession).toHaveBeenCalledTimes(2);
    expect(repository.beginRuntimeDispatch).toHaveBeenCalledOnce();
    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(repository.getSessionRuntimeContext).toHaveBeenCalledOnce();
    expect(repository.recordRuntimeResourceKnown).toHaveBeenCalledOnce();
    expect(repository.attachRuntimeSession).toHaveBeenCalledOnce();
    expect(repository.markRuntimeCommandReconciling).not.toHaveBeenCalled();
  });
});

function preparedRun() {
  return {
    commandReceiptId: ids.receiptId,
    phase: 'canvas_prepared' as const,
    workflowId: ids.workflowId,
    sessionId: ids.sessionId,
    runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    status: 'queued' as const,
    prompt: {
      canvasMessageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      role: 'user' as const,
      content: 'say fake',
    },
    runtime: {
      binding: {
        canvasAgentBindingId: ids.bindingId,
        agentId: ids.agentId,
        runtimeKind: 'fake',
        isolationKey: 'local-alpha',
      },
      externalSessionRef: 'fake-session-1',
      expectedHistoryDigest: 'sha256:before-run',
      model: {
        providerKey: 'fake',
        modelKey: 'deterministic-v1',
      },
      toolPolicy: {
        allowedToolKeys: [],
        deniedToolKeys: [],
        approvalRequiredToolKeys: [],
      },
      context: [],
    },
  };
}

function createRunRepository() {
  return {
    prepareRun: vi.fn().mockResolvedValue(preparedRun()),
    beginRuntimeDispatch: vi.fn().mockResolvedValue({
      phase: 'runtime_dispatched',
      dispatchAllowed: true,
    }),
    recordRuntimeResourceKnown: vi.fn().mockResolvedValue(undefined),
    attachRuntimeRun: vi.fn().mockResolvedValue(undefined),
    markRuntimeCommandFailure: vi.fn().mockResolvedValue(undefined),
    markRuntimeCommandReconciling: vi.fn().mockResolvedValue(undefined),
    markRuntimeSessionUnavailable: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SessionService Run start', () => {
  const request = {
    actor,
    commandId: ids.commandId,
    idempotencyKey: 'browser-run-1',
    sessionId: ids.sessionId,
    content: 'say fake',
  };

  it('records and attaches a Runtime Run before starting the pump', async () => {
    const repository = createRunRepository();
    const runtime = {
      startRun: vi.fn().mockResolvedValue({
        externalRunRef: 'fake-run-1',
        acceptedAt: new Date(0).toISOString(),
      }),
    };
    const eventPump = {
      start: vi.fn().mockReturnValue('started' as const),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      eventPump,
    );

    await expect(service.startRun(request)).resolves.toEqual({
      runId: preparedRun().runId,
      status: 'running',
    });
    expect(repository.prepareRun).toHaveBeenCalledWith(request);
    expect(runtime.startRun).toHaveBeenCalledWith({
      commandId: request.commandId,
      idempotencyKey: request.idempotencyKey,
      binding: {
        canvasAgentBindingId: ids.bindingId,
        isolationKey: 'local-alpha',
      },
      canvasRunId: preparedRun().runId,
      canvasSessionId: ids.sessionId,
      externalSessionRef: 'fake-session-1',
      expectedHistoryDigest: 'sha256:before-run',
      prompt: preparedRun().prompt,
      model: preparedRun().runtime.model,
      toolPolicy: preparedRun().runtime.toolPolicy,
      context: [],
    });
    expect(repository.prepareRun.mock.invocationCallOrder[0])
      .toBeLessThan(repository.beginRuntimeDispatch.mock.invocationCallOrder[0]!);
    expect(repository.beginRuntimeDispatch.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.startRun.mock.invocationCallOrder[0]!);
    expect(runtime.startRun.mock.invocationCallOrder[0])
      .toBeLessThan(repository.recordRuntimeResourceKnown.mock.invocationCallOrder[0]!);
    expect(repository.recordRuntimeResourceKnown.mock.invocationCallOrder[0])
      .toBeLessThan(repository.attachRuntimeRun.mock.invocationCallOrder[0]!);
    expect(repository.attachRuntimeRun.mock.invocationCallOrder[0])
      .toBeLessThan(eventPump.start.mock.invocationCallOrder[0]!);
    expect(eventPump.start).toHaveBeenCalledWith({
      actor,
      runId: preparedRun().runId,
    });
  });

  it('reuses an attached active Run without dispatching it again', async () => {
    const repository = createRunRepository();
    repository.prepareRun.mockResolvedValueOnce({
      ...preparedRun(),
      phase: 'attached',
      status: 'running',
    });
    const runtime = { startRun: vi.fn() };
    const eventPump = {
      start: vi.fn().mockReturnValue('started' as const),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      eventPump,
    );

    await expect(service.startRun(request)).resolves.toEqual({
      runId: preparedRun().runId,
      status: 'running',
    });
    expect(repository.beginRuntimeDispatch).not.toHaveBeenCalled();
    expect(runtime.startRun).not.toHaveBeenCalled();
    expect(eventPump.start).toHaveBeenCalledWith({
      actor,
      runId: preparedRun().runId,
    });
  });

  it('marks a missing Fake Session unavailable on a not-applied start', async () => {
    const runtimeSentinel = 'SENTINEL-OLD-PROCESS-LOCAL-REF';
    const repository = createRunRepository();
    const runtime = {
      startRun: vi.fn().mockRejectedValue(
        new RuntimeAdapterError(
          'session_not_found',
          runtimeSentinel,
          false,
          'not-applied',
        ),
      ),
    };
    const eventPump = {
      start: vi.fn().mockReturnValue('started' as const),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      eventPump,
    );

    let caught: unknown;
    try {
      await service.startRun(request);
    } catch (reason) {
      caught = reason;
    }

    expect(caught).toMatchObject({
      code: 'runtime_session_unavailable',
      retryable: false,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(repository.markRuntimeSessionUnavailable).toHaveBeenCalledWith({
      actor,
      sessionId: ids.sessionId,
      error: 'runtime_adapter:session_not_found:not-applied',
    });
    expect(repository.markRuntimeCommandFailure).toHaveBeenCalledWith({
      actor,
      commandReceiptId: ids.receiptId,
      retryable: false,
      error: 'runtime_adapter:session_not_found:not-applied',
    });
    expect(repository.markRuntimeCommandReconciling).not.toHaveBeenCalled();
    expect(repository.attachRuntimeRun).not.toHaveBeenCalled();
    expect(eventPump.start).not.toHaveBeenCalled();
    expect(String(caught)).not.toContain(runtimeSentinel);
    expect(JSON.stringify(caught)).not.toContain(runtimeSentinel);
    expect(JSON.stringify({
      unavailable: repository.markRuntimeSessionUnavailable.mock.calls,
      failure: repository.markRuntimeCommandFailure.mock.calls,
    })).not.toContain(runtimeSentinel);
  });

  it('reconciles an unknown Runtime outcome without attaching or pumping', async () => {
    const repository = createRunRepository();
    const runtime = {
      startRun: vi.fn().mockRejectedValue(
        new RuntimeAdapterError(
          'runtime_unavailable',
          'timeout',
          true,
          'unknown',
        ),
      ),
    };
    const eventPump = {
      start: vi.fn().mockReturnValue('started' as const),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      eventPump,
    );

    await expect(service.startRun(request)).rejects.toMatchObject({
      code: 'command_requires_reconciliation',
      commandReceiptId: ids.receiptId,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledOnce();
    expect(repository.markRuntimeCommandFailure).not.toHaveBeenCalled();
    expect(repository.markRuntimeSessionUnavailable).not.toHaveBeenCalled();
    expect(repository.attachRuntimeRun).not.toHaveBeenCalled();
    expect(eventPump.start).not.toHaveBeenCalled();
  });

  it('reconciles an accepted Runtime response that omits externalRunRef', async () => {
    const repository = createRunRepository();
    const runtime = {
      startRun: vi.fn().mockResolvedValue({
        acceptedAt: new Date(0).toISOString(),
      }),
    };
    const eventPump = {
      start: vi.fn().mockReturnValue('started' as const),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      eventPump,
    );

    await expect(service.startRun(request)).rejects.toMatchObject({
      code: 'command_requires_reconciliation',
      commandReceiptId: ids.receiptId,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith({
      actor,
      commandReceiptId: ids.receiptId,
      externalResourceKind: 'run',
      lookupMetadata: {
        commandId: request.commandId,
        canvasRunId: preparedRun().runId,
      },
      error: 'runtime_run_ref_missing',
    });
    expect(repository.recordRuntimeResourceKnown).not.toHaveBeenCalled();
    expect(repository.attachRuntimeRun).not.toHaveBeenCalled();
    expect(eventPump.start).not.toHaveBeenCalled();
  });
});
