import {
  DeterministicFakeRuntime,
  RuntimeAdapterError,
  type RuntimeAdapter,
} from '@ai-super-canvas/ai';
import type { ActorContext } from '@ai-super-canvas/core';
import type {
  ControlPlaneRepository,
  ResolveRuntimeReconciliationInput,
  RuntimeReconciliationResult,
} from '@ai-super-canvas/db';
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
      externalSessionRef: 'fake-session-1',
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

  it('re-prepares after an attached lease race and hands off the latest status', async () => {
    const repository = createRunRepository();
    repository.prepareRun
      .mockResolvedValueOnce(preparedRun())
      .mockResolvedValueOnce({
        ...preparedRun(),
        phase: 'attached',
        status: 'running',
      });
    repository.beginRuntimeDispatch.mockResolvedValueOnce({
      phase: 'attached',
      dispatchAllowed: false,
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
    expect(repository.prepareRun).toHaveBeenCalledTimes(2);
    expect(runtime.startRun).not.toHaveBeenCalled();
    expect(eventPump.start).toHaveBeenCalledWith({
      actor,
      runId: preparedRun().runId,
    });
  });

  it('re-prepares an attached terminal lease race without starting the pump', async () => {
    const repository = createRunRepository();
    repository.prepareRun
      .mockResolvedValueOnce(preparedRun())
      .mockResolvedValueOnce({
        ...preparedRun(),
        phase: 'attached',
        status: 'succeeded',
      });
    repository.beginRuntimeDispatch.mockResolvedValueOnce({
      phase: 'attached',
      dispatchAllowed: false,
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
      status: 'succeeded',
    });
    expect(repository.prepareRun).toHaveBeenCalledTimes(2);
    expect(runtime.startRun).not.toHaveBeenCalled();
    expect(eventPump.start).not.toHaveBeenCalled();
  });

  it('re-prepares an attached reconciling lease race without starting the pump', async () => {
    const repository = createRunRepository();
    repository.prepareRun
      .mockResolvedValueOnce(preparedRun())
      .mockResolvedValueOnce({
        ...preparedRun(),
        phase: 'attached',
        status: 'reconciling',
      });
    repository.beginRuntimeDispatch.mockResolvedValueOnce({
      phase: 'attached',
      dispatchAllowed: false,
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

    await expect(service.startRun(request)).rejects.toMatchObject({
      code: 'command_requires_reconciliation',
      commandReceiptId: ids.receiptId,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(repository.prepareRun).toHaveBeenCalledTimes(2);
    expect(runtime.startRun).not.toHaveBeenCalled();
    expect(eventPump.start).not.toHaveBeenCalled();
  });

  it('returns a safe persistence-unconfirmed error when reconciliation cannot be stored', async () => {
    const runtimeSentinel = 'SENTINEL-RUN-UNKNOWN-OUTCOME';
    const persistenceSentinel = 'SENTINEL-RUN-RECONCILIATION-PERSISTENCE';
    const repository = createRunRepository();
    repository.markRuntimeCommandReconciling.mockRejectedValueOnce(
      new Error(persistenceSentinel),
    );
    const runtime = {
      startRun: vi.fn().mockRejectedValue(
        new Error(runtimeSentinel),
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
      code: 'command_persistence_unconfirmed',
      message: 'Runtime command persistence could not be confirmed',
      retryable: true,
      commandReceiptId: ids.receiptId,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(caught).not.toHaveProperty('cause');
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledOnce();
    expect(String(caught)).not.toContain(runtimeSentinel);
    expect(String(caught)).not.toContain(persistenceSentinel);
    expect(JSON.stringify(caught)).not.toContain(runtimeSentinel);
    expect(JSON.stringify(caught)).not.toContain(persistenceSentinel);
  });

  it('returns persistence-unconfirmed while retaining a known external Run ref', async () => {
    const persistenceSentinel = 'SENTINEL-KNOWN-RUN-RECONCILIATION';
    const repository = createRunRepository();
    repository.recordRuntimeResourceKnown.mockRejectedValueOnce(
      new Error('record response lost'),
    );
    repository.markRuntimeCommandReconciling.mockRejectedValueOnce(
      new Error(persistenceSentinel),
    );
    const runtime = {
      startRun: vi.fn().mockResolvedValue({
        externalRunRef: 'fake-run-known-unconfirmed',
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

    let caught: unknown;
    try {
      await service.startRun(request);
    } catch (reason) {
      caught = reason;
    }

    expect(caught).toMatchObject({
      code: 'command_persistence_unconfirmed',
      commandReceiptId: ids.receiptId,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(caught).not.toHaveProperty('cause');
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith({
      actor,
      commandReceiptId: ids.receiptId,
      externalResourceKind: 'run',
      externalResourceRef: 'fake-run-known-unconfirmed',
      lookupMetadata: {
        commandId: request.commandId,
        canvasRunId: preparedRun().runId,
      },
      error: 'runtime_run_record_failed',
    });
    expect(repository.attachRuntimeRun).not.toHaveBeenCalled();
    expect(eventPump.start).not.toHaveBeenCalled();
    expect(String(caught)).not.toContain(persistenceSentinel);
    expect(JSON.stringify(caught)).not.toContain(persistenceSentinel);
  });

  it('coalesces a Run receipt in flight and releases only its owning runner', async () => {
    const repository = createRunRepository();
    let resolveRuntimeRun!: (value: {
      externalRunRef: string;
      acceptedAt: string;
    }) => void;
    const runtime = {
      startRun: vi.fn()
        .mockImplementationOnce(
          () => new Promise<{
            externalRunRef: string;
            acceptedAt: string;
          }>((resolve) => {
            resolveRuntimeRun = resolve;
          }),
        )
        .mockResolvedValueOnce({
          externalRunRef: 'fake-run-after-cleanup',
          acceptedAt: new Date(1).toISOString(),
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

    const first = service.startRun(request);
    const second = service.startRun({ ...request });
    await vi.waitFor(() => {
      expect(runtime.startRun).toHaveBeenCalledOnce();
    });
    resolveRuntimeRun({
      externalRunRef: 'fake-run-single-flight',
      acceptedAt: new Date(0).toISOString(),
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { runId: preparedRun().runId, status: 'running' },
      { runId: preparedRun().runId, status: 'running' },
    ]);
    expect(repository.prepareRun).toHaveBeenCalledTimes(2);
    expect(repository.beginRuntimeDispatch).toHaveBeenCalledOnce();
    expect(runtime.startRun).toHaveBeenCalledOnce();
    expect(repository.recordRuntimeResourceKnown).toHaveBeenCalledOnce();
    expect(repository.attachRuntimeRun).toHaveBeenCalledOnce();
    expect(eventPump.start).toHaveBeenCalledOnce();

    await expect(service.startRun({ ...request })).resolves.toEqual({
      runId: preparedRun().runId,
      status: 'running',
    });
    expect(runtime.startRun).toHaveBeenCalledTimes(2);
    expect(repository.attachRuntimeRun).toHaveBeenCalledTimes(2);
    expect(eventPump.start).toHaveBeenCalledTimes(2);
  });

  it('reconciles a runtime-dispatched replay without redispatching', async () => {
    const repository = createRunRepository();
    repository.beginRuntimeDispatch.mockResolvedValueOnce({
      phase: 'runtime_dispatched',
      dispatchAllowed: false,
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

    await expect(service.startRun(request)).rejects.toMatchObject({
      code: 'command_requires_reconciliation',
      commandReceiptId: ids.receiptId,
    } satisfies Partial<ControlPlaneApplicationError>);
    expect(runtime.startRun).not.toHaveBeenCalled();
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith({
      actor,
      commandReceiptId: ids.receiptId,
      externalResourceKind: 'run',
      lookupMetadata: {
        commandId: request.commandId,
        canvasRunId: preparedRun().runId,
      },
      error: 'runtime_dispatch_persistence_unconfirmed',
    });
  });

  it('retains a known external Run ref when recording it fails', async () => {
    const repository = createRunRepository();
    repository.recordRuntimeResourceKnown.mockRejectedValueOnce(
      new Error('record response lost'),
    );
    const runtime = {
      startRun: vi.fn().mockResolvedValue({
        externalRunRef: 'fake-run-record-lost',
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
      externalResourceRef: 'fake-run-record-lost',
      lookupMetadata: {
        commandId: request.commandId,
        canvasRunId: preparedRun().runId,
      },
      error: 'runtime_run_record_failed',
    });
    expect(repository.attachRuntimeRun).not.toHaveBeenCalled();
    expect(eventPump.start).not.toHaveBeenCalled();
  });

  it('retains a known external Run ref when attachment fails', async () => {
    const repository = createRunRepository();
    repository.attachRuntimeRun.mockRejectedValueOnce(
      new Error('attach response lost'),
    );
    const runtime = {
      startRun: vi.fn().mockResolvedValue({
        externalRunRef: 'fake-run-attach-lost',
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
    expect(repository.recordRuntimeResourceKnown).toHaveBeenCalledOnce();
    expect(repository.markRuntimeCommandReconciling).toHaveBeenCalledWith({
      actor,
      commandReceiptId: ids.receiptId,
      externalResourceKind: 'run',
      externalResourceRef: 'fake-run-attach-lost',
      lookupMetadata: {
        commandId: request.commandId,
        canvasRunId: preparedRun().runId,
      },
      error: 'runtime_run_attach_failed',
    });
    expect(eventPump.start).not.toHaveBeenCalled();
  });

  it('accepts an already-active pump handoff after attachment', async () => {
    const repository = createRunRepository();
    repository.prepareRun.mockResolvedValueOnce({
      ...preparedRun(),
      phase: 'attached',
      status: 'running',
    });
    const runtime = { startRun: vi.fn() };
    const eventPump = {
      start: vi.fn().mockReturnValue('already-active' as const),
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
    expect(runtime.startRun).not.toHaveBeenCalled();
    expect(eventPump.start).toHaveBeenCalledOnce();
  });
});

describe('SessionService Runtime reconciliation', () => {
  const adoptedRunInput: ResolveRuntimeReconciliationInput = {
    actor,
    commandReceiptId: ids.receiptId,
    resolution: {
      kind: 'adopt-run',
      runtimeRun: {
        externalRunRef: 'fake-run-adopted',
        acceptedAt: new Date(0).toISOString(),
      },
      evidence: { lookup: 'single-run-match' },
    },
  };
  const adoptedSessionInput: ResolveRuntimeReconciliationInput = {
    actor,
    commandReceiptId: ids.receiptId,
    resolution: {
      kind: 'adopt-session',
      runtimeSession: {
        externalSessionRef: 'fake-session-adopted',
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete',
        historyDigest: 'sha256:adopted-session',
        metadata: { lookup: 'single-session-match' },
      },
      evidence: { lookup: 'single-session-match' },
    },
  };
  const runId = preparedRun().runId;

  it.each([
    'queued',
    'running',
    'waiting_approval',
  ] as const)(
    'waits for adopted Run %s persistence before starting its pump',
    async (status) => {
      const result: RuntimeReconciliationResult = {
        phase: 'attached',
        outcome: 'adopted',
        resource: {
          kind: 'run',
          runId,
          status,
        },
      };
      let finishRepository!: () => void;
      const repository = {
        resolveRuntimeReconciliation: vi.fn().mockImplementation(
          async () => {
            await new Promise<void>((resolve) => {
              finishRepository = resolve;
            });
            return result;
          },
        ),
      };
      const eventPump = {
        start: vi.fn().mockReturnValue('started' as const),
      };
      const service = new SessionService(
        repository as unknown as ControlPlaneRepository,
        {} as RuntimeAdapter,
        eventPump,
      );

      const pending = service.resolveRuntimeReconciliation(adoptedRunInput);
      expect(repository.resolveRuntimeReconciliation)
        .toHaveBeenCalledWith(adoptedRunInput);
      expect(eventPump.start).not.toHaveBeenCalled();

      finishRepository();
      await expect(pending).resolves.toEqual(result);
      expect(repository.resolveRuntimeReconciliation.mock.invocationCallOrder[0])
        .toBeLessThan(eventPump.start.mock.invocationCallOrder[0]!);
      expect(eventPump.start).toHaveBeenCalledOnce();
      expect(eventPump.start).toHaveBeenCalledWith({ actor, runId });
    },
  );

  const noPumpCases: Array<[
    string,
    ResolveRuntimeReconciliationInput,
    RuntimeReconciliationResult,
  ]> = [
    [
      'absent resolution',
      {
        actor,
        commandReceiptId: ids.receiptId,
        resolution: {
          kind: 'absent',
          evidence: { lookup: 'no-match' },
        },
      },
      { phase: 'retryable_failure', outcome: 'absent' },
    ],
    [
      'unresolved lookup',
      {
        actor,
        commandReceiptId: ids.receiptId,
        resolution: {
          kind: 'unresolved',
          error: 'Runtime lookup remains unresolved',
          evidence: { lookup: 'pending' },
        },
      },
      { phase: 'reconciling', outcome: 'unresolved' },
    ],
    [
      'adopted Session',
      adoptedSessionInput,
      {
        phase: 'attached',
        outcome: 'adopted',
        resource: {
          kind: 'session',
          sessionId: ids.sessionId,
        },
      },
    ],
    ...(['succeeded', 'failed', 'cancelled'] as const).map(
      (status): [
        string,
        ResolveRuntimeReconciliationInput,
        RuntimeReconciliationResult,
      ] => [
        `terminal Run ${status}`,
        adoptedRunInput,
        {
          phase: 'attached',
          outcome: 'adopted',
          resource: {
            kind: 'run',
            runId,
            status,
          },
        },
      ],
    ),
  ];

  it.each(noPumpCases)(
    'does not start a pump for %s',
    async (_name, input, result) => {
      const repository = {
        resolveRuntimeReconciliation: vi.fn().mockResolvedValue(result),
      };
      const eventPump = {
        start: vi.fn().mockReturnValue('started' as const),
      };
      const service = new SessionService(
        repository as unknown as ControlPlaneRepository,
        {} as RuntimeAdapter,
        eventPump,
      );

      await expect(
        service.resolveRuntimeReconciliation(input),
      ).resolves.toEqual(result);
      expect(repository.resolveRuntimeReconciliation).toHaveBeenCalledWith(input);
      expect(eventPump.start).not.toHaveBeenCalled();
    },
  );

  it('propagates Repository rejection without starting a pump', async () => {
    const persistenceFailure = new Error('reconciliation transaction rejected');
    const repository = {
      resolveRuntimeReconciliation: vi.fn().mockRejectedValue(
        persistenceFailure,
      ),
    };
    const eventPump = {
      start: vi.fn().mockReturnValue('started' as const),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      {} as RuntimeAdapter,
      eventPump,
    );

    await expect(
      service.resolveRuntimeReconciliation(adoptedRunInput),
    ).rejects.toBe(persistenceFailure);
    expect(eventPump.start).not.toHaveBeenCalled();
  });
});

describe('SessionService persisted reads', () => {
  const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const occurredAt = new Date(0).toISOString();
  const sessionSnapshot = {
    sessionId: ids.sessionId,
    status: 'active',
    messages: [{
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      sessionId: ids.sessionId,
      runId: null,
      ordinal: 0,
      role: 'user' as const,
      content: {
        text: 'say fake',
        nested: {
          externalRunRef: 'fake-run-content-private',
          runtimeEventKey: 'runtime-event-content-private',
          secretRef: 'secret-ref-content-private',
          keep: 'public-content',
        },
      },
      status: 'completed',
      externalMessageRef: 'external-message-private',
      sourceRuntimeEventKey: 'runtime-event-private',
    }],
    activeRun: null,
    runtimeRef: {
      externalSessionRef: 'fake-session-1',
      status: 'active' as const,
    },
  };

  it('reads Run status before events and strips Runtime refs, keys, and raw failures', async () => {
    const repository = {
      getRunRuntimeContext: vi.fn().mockResolvedValue({
        actor,
        workflowId: ids.workflowId,
        sessionId: ids.sessionId,
        runId,
        status: 'failed',
        binding: preparedRun().runtime.binding,
        externalSessionRef: 'fake-session-1',
        externalRunRef: 'fake-run-private',
      }),
      listRunEvents: vi.fn().mockResolvedValue([{
        runId,
        sequence: 6,
        eventType: 'run.failed',
        payload: {
          eventId: 'runtime-event-private',
          type: 'run.failed',
          canvasSessionId: ids.sessionId,
          canvasRunId: runId,
          externalEventRef: 'external-event-private',
          externalRunRef: 'fake-run-private',
          externalMessageRef: 'external-message-private',
          secretRef: 'secret-ref-private',
          occurredAt,
          code: 'internal_error',
          message: 'postgres://secret@internal/runtime-ref-private/root',
          retryable: true,
          details: {
            externalSessionRef: 'fake-session-private',
            message: 'postgres://secret@internal/runtime-ref-private/nested',
            keep: 'private-detail',
          },
          errorMessage: 'postgres://secret@internal/runtime-ref-private/error',
          stack: 'postgres://secret@internal/runtime-ref-private/stack',
          cause: {
            message: 'postgres://secret@internal/runtime-ref-private/cause',
          },
        },
        externalEventRef: 'external-event-private',
        runtimeEventKey: 'runtime-event-private',
        occurredAt,
      }]),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      {} as RuntimeAdapter,
      pump,
    );

    const result = await service.getRunEvents({
      actor,
      runId,
      after: 5,
    });

    expect(result).toEqual({
      events: [{
        sequence: 6,
        eventType: 'run.failed',
        payload: {
          type: 'run.failed',
          canvasSessionId: ids.sessionId,
          canvasRunId: runId,
          occurredAt,
          code: 'internal_error',
          retryable: true,
        },
        occurredAt,
      }],
      nextAfter: 6,
      terminal: { status: 'failed' },
    });
    expect(
      repository.getRunRuntimeContext.mock.invocationCallOrder[0],
    ).toBeLessThan(repository.listRunEvents.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(result)).not.toMatch(
      /external|runtime-event-private|secret-ref-private|postgres:\/\/|private-detail/,
    );
  });

  it('keeps the cursor and reports no terminal state for an empty active page', async () => {
    const repository = {
      getRunRuntimeContext: vi.fn().mockResolvedValue({
        actor,
        workflowId: ids.workflowId,
        sessionId: ids.sessionId,
        runId,
        status: 'running',
        binding: preparedRun().runtime.binding,
        externalSessionRef: 'fake-session-1',
        externalRunRef: 'fake-run-1',
      }),
      listRunEvents: vi.fn().mockResolvedValue([]),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      {} as RuntimeAdapter,
      pump,
    );

    await expect(service.getRunEvents({
      actor,
      runId,
      after: 17,
      limit: 25,
    })).resolves.toEqual({
      events: [],
      nextAfter: 17,
      terminal: null,
    });
    expect(repository.listRunEvents).toHaveBeenCalledWith({
      actor,
      runId,
      after: 17,
      limit: 25,
    });
  });

  it('does not report a terminal Run while later persisted events remain unread', async () => {
    const repository = {
      getRunRuntimeContext: vi.fn().mockResolvedValue({
        actor,
        workflowId: ids.workflowId,
        sessionId: ids.sessionId,
        runId,
        status: 'succeeded',
        binding: preparedRun().runtime.binding,
        externalSessionRef: 'fake-session-1',
        externalRunRef: 'fake-run-1',
      }),
      listRunEvents: vi.fn()
        .mockResolvedValueOnce([{
          runId,
          sequence: 6,
          eventType: 'model.output.delta',
          payload: { type: 'model.output.delta', text: 'partial' },
          externalEventRef: null,
          runtimeEventKey: 'event-6',
          occurredAt,
        }])
        .mockResolvedValueOnce([{
          runId,
          sequence: 7,
          eventType: 'run.completed',
          payload: { type: 'run.completed' },
          externalEventRef: null,
          runtimeEventKey: 'event-7',
          occurredAt,
        }]),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      {} as RuntimeAdapter,
      pump,
    );

    await expect(service.getRunEvents({
      actor,
      runId,
      after: 5,
      limit: 1,
    })).resolves.toEqual({
      events: [{
        sequence: 6,
        eventType: 'model.output.delta',
        payload: { type: 'model.output.delta', text: 'partial' },
        occurredAt,
      }],
      nextAfter: 6,
      terminal: null,
    });
    expect(repository.listRunEvents).toHaveBeenNthCalledWith(2, {
      actor,
      runId,
      after: 6,
      limit: 1,
    });
  });

  it('returns opaque transcript content without exposing stored Runtime metadata', async () => {
    const repository = {
      loadSessionSnapshot: vi.fn().mockResolvedValue(sessionSnapshot),
      getSessionRuntimeContext: vi.fn().mockResolvedValue({
        ...sessionContext(),
        status: 'active',
        externalSessionRef: 'fake-session-1',
        expectedHistoryDigest: 'sha256:before-run',
        binding: {
          ...sessionContext().binding,
          secretRef: 'vault://runtime-binding-private',
        },
      }),
      markRuntimeSessionUnavailable: vi.fn(),
    };
    const runtime = {
      loadSession: vi.fn().mockResolvedValue({
        externalSessionRef: 'fake-session-1',
        runtimeVersion: '1',
        replayStatus: 'complete',
        historyDigest: 'sha256:before-run',
        metadata: {},
      }),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    const result = await service.getSessionTranscript({
      actor,
      sessionId: ids.sessionId,
    });

    expect(result).toEqual({
      sessionId: ids.sessionId,
      status: 'active',
      messages: [{
        messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        runId: null,
        ordinal: 0,
        role: 'user',
        content: {
          text: 'say fake',
          nested: {
            externalRunRef: 'fake-run-content-private',
            runtimeEventKey: 'runtime-event-content-private',
            secretRef: 'secret-ref-content-private',
            keep: 'public-content',
          },
        },
        status: 'completed',
      }],
      activeRun: null,
      reconciliationState: null,
      runtimeAvailability: 'available',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /fake-session-1|external-message-private|runtime-event-private|vault:\/\//,
    );
  });

  it('returns persisted history as unavailable without probing an inactive ref', async () => {
    const repository = {
      loadSessionSnapshot: vi.fn().mockResolvedValue({
        ...sessionSnapshot,
        activeRun: { runId, status: 'reconciling' as const },
        runtimeRef: {
          externalSessionRef: 'fake-session-1',
          status: 'error' as const,
        },
      }),
      getSessionRuntimeContext: vi.fn(),
      markRuntimeSessionUnavailable: vi.fn(),
    };
    const runtime = { loadSession: vi.fn() };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    await expect(service.getSessionTranscript({
      actor,
      sessionId: ids.sessionId,
    })).resolves.toMatchObject({
      activeRun: { runId, status: 'reconciling' },
      reconciliationState: {
        kind: 'run-reconciling',
        message: 'Run requires reconciliation',
      },
      runtimeAvailability: 'unavailable',
    });
    expect(repository.getSessionRuntimeContext).not.toHaveBeenCalled();
    expect(runtime.loadSession).not.toHaveBeenCalled();
  });

  it('marks a definitively missing Runtime Session unavailable with a safe category', async () => {
    const unavailableSnapshot = {
      ...sessionSnapshot,
      runtimeRef: {
        externalSessionRef: 'fake-session-1',
        status: 'error' as const,
      },
    };
    const repository = {
      loadSessionSnapshot: vi.fn()
        .mockResolvedValueOnce(sessionSnapshot)
        .mockResolvedValueOnce(unavailableSnapshot),
      getSessionRuntimeContext: vi.fn().mockResolvedValue({
        ...sessionContext(),
        status: 'active',
        externalSessionRef: 'fake-session-1',
      }),
      markRuntimeSessionUnavailable: vi.fn().mockResolvedValue(undefined),
    };
    const sentinel = 'postgres://secret@internal/runtime-ref-private';
    const runtime = {
      loadSession: vi.fn().mockRejectedValue(new RuntimeAdapterError(
        'session_not_found',
        sentinel,
        false,
        'not-applied',
      )),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    const result = await service.getSessionTranscript({
      actor,
      sessionId: ids.sessionId,
    });

    expect(result).toMatchObject({
      runtimeAvailability: 'unavailable',
      reconciliationState: {
        kind: 'runtime-unavailable',
      },
    });
    expect(repository.markRuntimeSessionUnavailable).toHaveBeenCalledWith({
      actor,
      sessionId: ids.sessionId,
      externalSessionRef: 'fake-session-1',
      error: 'runtime_adapter:session_not_found:not-applied',
    });
    expect(JSON.stringify({
      result,
      calls: repository.markRuntimeSessionUnavailable.mock.calls,
    })).not.toContain(sentinel);
  });

  it('accepts a concurrent unavailable mark only after observing its persisted snapshot', async () => {
    const unavailableSnapshot = {
      ...sessionSnapshot,
      runtimeRef: {
        externalSessionRef: 'fake-session-1',
        status: 'error' as const,
      },
    };
    const repository = {
      loadSessionSnapshot: vi.fn()
        .mockResolvedValueOnce(sessionSnapshot)
        .mockResolvedValueOnce(unavailableSnapshot),
      getSessionRuntimeContext: vi.fn().mockResolvedValue({
        ...sessionContext(),
        status: 'active',
        externalSessionRef: 'fake-session-1',
      }),
      markRuntimeSessionUnavailable: vi.fn().mockRejectedValue(
        new Error('active ref already changed'),
      ),
    };
    const runtime = {
      loadSession: vi.fn().mockRejectedValue(new RuntimeAdapterError(
        'session_not_found',
        'missing',
        false,
        'not-applied',
      )),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    await expect(service.getSessionTranscript({
      actor,
      sessionId: ids.sessionId,
    })).resolves.toMatchObject({
      runtimeAvailability: 'unavailable',
    });
    expect(repository.loadSessionSnapshot).toHaveBeenCalledTimes(2);
  });

  it('re-probes a concurrently rotated active Runtime Session ref', async () => {
    const rotatedSnapshot = {
      ...sessionSnapshot,
      runtimeRef: {
        externalSessionRef: 'fake-session-2',
        status: 'active' as const,
      },
    };
    const repository = {
      loadSessionSnapshot: vi.fn()
        .mockResolvedValueOnce(sessionSnapshot)
        .mockResolvedValueOnce(rotatedSnapshot),
      getSessionRuntimeContext: vi.fn()
        .mockResolvedValueOnce({
          ...sessionContext(),
          status: 'active',
          externalSessionRef: 'fake-session-1',
        })
        .mockResolvedValueOnce({
          ...sessionContext(),
          status: 'active',
          externalSessionRef: 'fake-session-2',
        }),
      markRuntimeSessionUnavailable: vi.fn().mockRejectedValue(
        new Error('active ref changed'),
      ),
    };
    const runtime = {
      loadSession: vi.fn()
        .mockRejectedValueOnce(new RuntimeAdapterError(
          'session_not_found',
          'old ref disappeared',
          false,
          'not-applied',
        ))
        .mockResolvedValueOnce({
          externalSessionRef: 'fake-session-2',
          runtimeVersion: '1',
          replayStatus: 'complete',
          historyDigest: 'sha256:before-run',
          metadata: {},
        }),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    await expect(service.getSessionTranscript({
      actor,
      sessionId: ids.sessionId,
    })).resolves.toMatchObject({ runtimeAvailability: 'available' });
    expect(repository.markRuntimeSessionUnavailable).toHaveBeenCalledWith({
      actor,
      sessionId: ids.sessionId,
      externalSessionRef: 'fake-session-1',
      error: 'runtime_adapter:session_not_found:not-applied',
    });
    expect(runtime.loadSession).toHaveBeenCalledTimes(2);
    expect(runtime.loadSession).toHaveBeenLastCalledWith(expect.objectContaining({
      externalSessionRef: 'fake-session-2',
    }));
  });

  it('does not hide an unconfirmed unavailable mark behind an unavailable DTO', async () => {
    const persistenceFailure = new Error('database write failed');
    const repository = {
      loadSessionSnapshot: vi.fn().mockResolvedValue(sessionSnapshot),
      getSessionRuntimeContext: vi.fn().mockResolvedValue({
        ...sessionContext(),
        status: 'active',
        externalSessionRef: 'fake-session-1',
      }),
      markRuntimeSessionUnavailable: vi.fn().mockRejectedValue(persistenceFailure),
    };
    const runtime = {
      loadSession: vi.fn().mockRejectedValue(new RuntimeAdapterError(
        'session_not_found',
        'missing',
        false,
        'not-applied',
      )),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    await expect(service.getSessionTranscript({
      actor,
      sessionId: ids.sessionId,
    })).rejects.toBe(persistenceFailure);
    expect(repository.loadSessionSnapshot).toHaveBeenCalledTimes(2);
  });

  it('detects a process-local Fake Session ref after Runtime restart', async () => {
    const unavailableSnapshot = {
      ...sessionSnapshot,
      runtimeRef: {
        externalSessionRef: 'fake-session-1',
        status: 'error' as const,
      },
    };
    const repository = {
      loadSessionSnapshot: vi.fn()
        .mockResolvedValueOnce(sessionSnapshot)
        .mockResolvedValueOnce(unavailableSnapshot),
      getSessionRuntimeContext: vi.fn().mockResolvedValue({
        ...sessionContext(),
        status: 'active',
        externalSessionRef: 'fake-session-1',
      }),
      markRuntimeSessionUnavailable: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      new DeterministicFakeRuntime(),
      pump,
    );

    await expect(service.getSessionTranscript({
      actor,
      sessionId: ids.sessionId,
    })).resolves.toMatchObject({
      runtimeAvailability: 'unavailable',
      reconciliationState: { kind: 'runtime-unavailable' },
    });
    expect(repository.markRuntimeSessionUnavailable).toHaveBeenCalledWith({
      actor,
      sessionId: ids.sessionId,
      externalSessionRef: 'fake-session-1',
      error: 'runtime_adapter:session_not_found:not-applied',
    });
  });

  it('does not probe when the active Runtime context lost its external ref', async () => {
    const repository = {
      loadSessionSnapshot: vi.fn().mockResolvedValue(sessionSnapshot),
      getSessionRuntimeContext: vi.fn().mockResolvedValue({
        ...sessionContext(),
        status: 'active',
        externalSessionRef: null,
      }),
      markRuntimeSessionUnavailable: vi.fn(),
    };
    const runtime = { loadSession: vi.fn() };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    await expect(service.getSessionTranscript({
      actor,
      sessionId: ids.sessionId,
    })).resolves.toMatchObject({
      runtimeAvailability: 'unavailable',
      reconciliationState: { kind: 'runtime-unavailable' },
    });
    expect(runtime.loadSession).not.toHaveBeenCalled();
    expect(repository.markRuntimeSessionUnavailable).not.toHaveBeenCalled();
  });

  it('does not permanently mark a transient Runtime probe failure', async () => {
    const repository = {
      loadSessionSnapshot: vi.fn().mockResolvedValue(sessionSnapshot),
      getSessionRuntimeContext: vi.fn().mockResolvedValue({
        ...sessionContext(),
        status: 'active',
        externalSessionRef: 'fake-session-1',
      }),
      markRuntimeSessionUnavailable: vi.fn(),
    };
    const reason = new RuntimeAdapterError(
      'runtime_unavailable',
      'temporary outage',
      true,
      'not-applied',
    );
    const runtime = { loadSession: vi.fn().mockRejectedValue(reason) };
    const service = new SessionService(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      pump,
    );

    await expect(service.getSessionTranscript({
      actor,
      sessionId: ids.sessionId,
    })).rejects.toBe(reason);
    expect(repository.markRuntimeSessionUnavailable).not.toHaveBeenCalled();
  });
});
