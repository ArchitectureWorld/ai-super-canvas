import {
  RuntimeAdapterError,
  type RuntimeAdapter,
  type RuntimeBindingContext,
  type RuntimeContextItem,
  type RuntimeToolPolicy,
} from '@ai-super-canvas/ai';
import type {
  ControlPlaneRepository,
  CreatedSession,
  OrchestrationPhase,
  PreparedRun,
  SessionRuntimeContext,
} from '@ai-super-canvas/db';

import type {
  BootstrapLocalAlphaInput,
  CreatedSessionDto,
  CreateRootSessionInput,
  LocalAlphaBootstrapDto,
  StartedRunDto,
  StartSessionRunInput,
} from './dto';
import {
  commandRequiresReconciliation,
  runtimeOperationFailed,
  runtimeSessionUnavailable,
} from './errors';
import type { RunEventPumpPort } from './run-event-pump';

function runtimeFailureCategory(
  reason: unknown,
  fallback: string,
): string {
  if (reason instanceof RuntimeAdapterError) {
    return `runtime_adapter:${reason.code}:${reason.operationEffect}`;
  }
  return fallback;
}

function toSessionBinding(
  binding: SessionRuntimeContext['binding'],
): RuntimeBindingContext {
  return {
    canvasAgentBindingId: binding.agentBindingId,
    isolationKey: binding.isolationKey,
    ...(binding.endpointRef === null
      ? {}
      : { endpointRef: binding.endpointRef }),
    ...(binding.secretRef === null
      ? {}
      : { secretRef: binding.secretRef }),
  };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`stored_runtime_policy_invalid:${field}`);
  }
  return [...value];
}

function toRuntimeToolPolicy(
  value: Record<string, unknown>,
): RuntimeToolPolicy {
  return {
    allowedToolKeys: stringArray(value.allowedToolKeys, 'allowedToolKeys'),
    deniedToolKeys: stringArray(value.deniedToolKeys, 'deniedToolKeys'),
    approvalRequiredToolKeys: stringArray(
      value.approvalRequiredToolKeys,
      'approvalRequiredToolKeys',
    ),
  };
}

function toRuntimeContext(
  rows: Array<Record<string, unknown>>,
): RuntimeContextItem[] {
  return rows.map((row) => {
    if (
      typeof row.id !== 'string'
      || !['account', 'agent', 'workflow', 'session', 'run'].includes(String(row.scope))
      || !['private', 'workspace'].includes(String(row.visibility))
    ) {
      throw new Error('stored_runtime_context_invalid');
    }
    return {
      canvasContextRefId: row.id,
      scope: row.scope as RuntimeContextItem['scope'],
      visibility: row.visibility as RuntimeContextItem['visibility'],
      content: row.snapshot,
      provenance: {
        ...((row.provenance ?? {}) as Record<string, unknown>),
        sourceKind: row.sourceKind,
        sourceRef: row.sourceRef,
      },
    };
  });
}

function attachedSession(
  sessionId: string,
  nodeId: string,
): CreatedSessionDto {
  return { sessionId, nodeId, status: 'active' };
}

class RuntimeNotAppliedFailure extends Error {
  constructor(readonly adapterError: RuntimeAdapterError) {
    super('runtime_not_applied');
    this.name = 'RuntimeNotAppliedFailure';
  }
}

async function confirmPersistence(
  operation: () => Promise<void>,
): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch {
    return false;
  }
}

function assertNever(
  _phase: never,
  commandReceiptId: string,
): never {
  throw commandRequiresReconciliation(commandReceiptId);
}

function nonDispatchable(
  commandReceiptId: string,
  phase: OrchestrationPhase,
  sessionId: string,
  nodeId: string,
): CreatedSessionDto {
  switch (phase) {
    case 'attached':
      return attachedSession(sessionId, nodeId);
    case 'terminal_failure':
      throw runtimeOperationFailed(commandReceiptId, false);
    case 'canvas_prepared':
    case 'runtime_dispatched':
    case 'runtime_known':
    case 'reconciling':
    case 'retryable_failure':
      throw commandRequiresReconciliation(commandReceiptId);
    default:
      return assertNever(phase, commandReceiptId);
  }
}

export class SessionService {
  private readonly activeSessionDispatches = new Map<
    string,
    Promise<CreatedSessionDto>
  >();

  private readonly activeRunDispatches = new Map<
    string,
    Promise<StartedRunDto>
  >();

  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly runtime: RuntimeAdapter,
    private readonly eventPump: RunEventPumpPort,
  ) {}

  async bootstrapLocalAlpha(
    input: BootstrapLocalAlphaInput,
  ): Promise<LocalAlphaBootstrapDto> {
    const stored = await this.repository.bootstrapLocalAlpha({
      commandId: input.commandId,
      authSubject: input.authSubject,
      displayName: input.displayName ?? 'Local Alpha',
      availableModels: [{
        providerKey: 'fake',
        modelKey: 'deterministic-v1',
        displayName: 'Deterministic Fake v1',
        capabilities: { text: true, tools: false },
      }],
      defaultModelProviderKey: 'fake',
      defaultModelKey: 'deterministic-v1',
    });
    return {
      accountId: stored.accountId,
      agentId: stored.agentId,
      agentBindingId: stored.agentBindingId,
      workspaceId: stored.workspaceId,
      workflowId: stored.workflowId,
      trunkRevisionId: stored.trunkRevisionId,
    };
  }

  async createRootSession(
    input: CreateRootSessionInput,
  ): Promise<CreatedSessionDto> {
    const prepared = await this.repository.createRootSession(input);
    if (prepared.phase === 'attached') {
      return attachedSession(prepared.sessionId, prepared.nodeId);
    }
    if (prepared.phase === 'terminal_failure') {
      return nonDispatchable(
        prepared.commandReceiptId,
        prepared.phase,
        prepared.sessionId,
        prepared.nodeId,
      );
    }

    const activeDispatch = this.activeSessionDispatches.get(
      prepared.commandReceiptId,
    );
    if (activeDispatch) return activeDispatch;

    const commandReceiptId = prepared.commandReceiptId;
    const runner = Promise.resolve()
      .then(() => this.dispatchPreparedRootSession(input, prepared))
      .finally(() => {
        if (
          this.activeSessionDispatches.get(commandReceiptId) === runner
        ) {
          this.activeSessionDispatches.delete(commandReceiptId);
        }
      });
    this.activeSessionDispatches.set(commandReceiptId, runner);
    return runner;
  }

  async startRun(
    input: StartSessionRunInput,
  ): Promise<StartedRunDto> {
    const prepared = await this.repository.prepareRun(input);

    if (prepared.phase === 'attached') {
      return this.handoffAttachedRun(input, prepared);
    }
    if (prepared.phase === 'terminal_failure') {
      return { runId: prepared.runId, status: 'failed' };
    }

    const activeDispatch = this.activeRunDispatches.get(
      prepared.commandReceiptId,
    );
    if (activeDispatch) return activeDispatch;

    const commandReceiptId = prepared.commandReceiptId;
    const runner = Promise.resolve()
      .then(() => this.dispatchPreparedRun(input, prepared))
      .finally(() => {
        if (this.activeRunDispatches.get(commandReceiptId) === runner) {
          this.activeRunDispatches.delete(commandReceiptId);
        }
      });
    this.activeRunDispatches.set(commandReceiptId, runner);
    return runner;
  }

  private handoffAttachedRun(
    input: StartSessionRunInput,
    prepared: PreparedRun,
  ): StartedRunDto {
    if (prepared.status === 'reconciling') {
      throw commandRequiresReconciliation(prepared.commandReceiptId);
    }
    if (
      prepared.status === 'queued'
      || prepared.status === 'running'
      || prepared.status === 'waiting_approval'
    ) {
      this.eventPump.start({
        actor: input.actor,
        runId: prepared.runId,
      });
    }
    return { runId: prepared.runId, status: prepared.status };
  }

  private async requireRunReconciliation(
    input: StartSessionRunInput,
    prepared: PreparedRun,
    error: string,
    externalRunRef?: string,
  ): Promise<never> {
    await confirmPersistence(
      () => this.repository.markRuntimeCommandReconciling({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        externalResourceKind: 'run',
        ...(externalRunRef === undefined
          ? {}
          : { externalResourceRef: externalRunRef }),
        lookupMetadata: {
          commandId: input.commandId,
          canvasRunId: prepared.runId,
        },
        error,
      }),
    );
    throw commandRequiresReconciliation(prepared.commandReceiptId);
  }

  private async dispatchPreparedRun(
    input: StartSessionRunInput,
    prepared: PreparedRun,
  ): Promise<StartedRunDto> {
    const dispatch = await this.repository.beginRuntimeDispatch({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
    });
    if (!dispatch.dispatchAllowed) {
      if (dispatch.phase === 'attached') {
        this.eventPump.start({
          actor: input.actor,
          runId: prepared.runId,
        });
        return { runId: prepared.runId, status: 'running' };
      }
      if (dispatch.phase === 'terminal_failure') {
        return { runId: prepared.runId, status: 'failed' };
      }
      return this.requireRunReconciliation(
        input,
        prepared,
        'runtime_dispatch_persistence_unconfirmed',
      );
    }

    let failureCategory = 'runtime_run_input_build_failed';
    let knownExternalRunRef: string | undefined;
    try {
      const binding: RuntimeBindingContext = {
        canvasAgentBindingId:
          prepared.runtime.binding.canvasAgentBindingId,
        isolationKey: prepared.runtime.binding.isolationKey,
        ...(prepared.runtime.binding.endpointRef === undefined
          ? {}
          : { endpointRef: prepared.runtime.binding.endpointRef }),
        ...(prepared.runtime.binding.secretRef === undefined
          ? {}
          : { secretRef: prepared.runtime.binding.secretRef }),
      };
      const runtimeInput: Parameters<RuntimeAdapter['startRun']>[0] = {
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        binding,
        canvasRunId: prepared.runId,
        canvasSessionId: prepared.sessionId,
        externalSessionRef: prepared.runtime.externalSessionRef,
        expectedHistoryDigest: prepared.runtime.expectedHistoryDigest,
        prompt: prepared.prompt,
        model: prepared.runtime.model,
        toolPolicy: prepared.runtime.toolPolicy,
        context: prepared.runtime.context,
      };

      failureCategory = 'runtime_run_start_failed';
      let runtimeRun: Awaited<ReturnType<RuntimeAdapter['startRun']>>;
      try {
        runtimeRun = await this.runtime.startRun(runtimeInput);
      } catch (reason) {
        if (
          reason instanceof RuntimeAdapterError
          && reason.operationEffect === 'not-applied'
        ) {
          throw new RuntimeNotAppliedFailure(reason);
        }
        throw reason;
      }

      failureCategory = 'runtime_run_ref_missing';
      knownExternalRunRef = runtimeRun.externalRunRef?.trim()
        ? runtimeRun.externalRunRef
        : undefined;
      if (!knownExternalRunRef) {
        throw new Error(failureCategory);
      }

      failureCategory = 'runtime_run_record_failed';
      await this.repository.recordRuntimeResourceKnown({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        externalResourceKind: 'run',
        externalResourceRef: knownExternalRunRef,
      });

      failureCategory = 'runtime_run_attach_failed';
      await this.repository.attachRuntimeRun({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        runtimeRun: {
          externalRunRef: knownExternalRunRef,
          acceptedAt: runtimeRun.acceptedAt,
        },
      });
    } catch (reason) {
      if (reason instanceof RuntimeNotAppliedFailure) {
        const adapterError = reason.adapterError;
        const error = runtimeFailureCategory(
          adapterError,
          failureCategory,
        );
        if (adapterError.code === 'session_not_found') {
          const unavailableConfirmed = await confirmPersistence(
            () => this.repository.markRuntimeSessionUnavailable({
              actor: input.actor,
              sessionId: prepared.sessionId,
              error,
            }),
          );
          if (!unavailableConfirmed) {
            return this.requireRunReconciliation(
              input,
              prepared,
              error,
            );
          }
        }

        const failureConfirmed = await confirmPersistence(
          () => this.repository.markRuntimeCommandFailure({
            actor: input.actor,
            commandReceiptId: prepared.commandReceiptId,
            retryable: adapterError.retryable,
            error,
          }),
        );
        if (!failureConfirmed) {
          return this.requireRunReconciliation(
            input,
            prepared,
            error,
          );
        }
        if (adapterError.code === 'session_not_found') {
          throw runtimeSessionUnavailable(prepared.commandReceiptId);
        }
        throw runtimeOperationFailed(
          prepared.commandReceiptId,
          adapterError.retryable,
        );
      }

      return this.requireRunReconciliation(
        input,
        prepared,
        runtimeFailureCategory(reason, failureCategory),
        knownExternalRunRef,
      );
    }

    this.eventPump.start({
      actor: input.actor,
      runId: prepared.runId,
    });
    return { runId: prepared.runId, status: 'running' };
  }

  private async dispatchPreparedRootSession(
    input: CreateRootSessionInput,
    prepared: CreatedSession,
  ): Promise<CreatedSessionDto> {
    const dispatch = await this.repository.beginRuntimeDispatch({
      actor: input.actor,
      commandReceiptId: prepared.commandReceiptId,
    });
    if (
      !dispatch.dispatchAllowed
      && dispatch.phase === 'runtime_dispatched'
    ) {
      await confirmPersistence(
        () => this.repository.markRuntimeCommandReconciling({
          actor: input.actor,
          commandReceiptId: prepared.commandReceiptId,
          externalResourceKind: 'session',
          lookupMetadata: {
            commandId: input.commandId,
            canvasSessionId: prepared.sessionId,
          },
          error: 'runtime_dispatch_persistence_unconfirmed',
        }),
      );
      throw commandRequiresReconciliation(prepared.commandReceiptId);
    }
    if (!dispatch.dispatchAllowed) {
      return nonDispatchable(
        prepared.commandReceiptId,
        dispatch.phase,
        prepared.sessionId,
        prepared.nodeId,
      );
    }

    let failureCategory = 'runtime_session_context_load_failed';
    let knownExternalSessionRef: string | undefined;
    try {
      const context = await this.repository.getSessionRuntimeContext({
        actor: input.actor,
        sessionId: prepared.sessionId,
      });

      failureCategory = 'runtime_session_input_build_failed';
      const runtimeInput: Parameters<RuntimeAdapter['createSession']>[0] = {
        commandId: input.commandId,
        binding: toSessionBinding(context.binding),
        canvasSessionId: prepared.sessionId,
        model: {
          providerKey: context.config.model.providerKey,
          modelKey: context.config.model.modelKey,
        },
        toolPolicy: toRuntimeToolPolicy(context.config.toolPolicy),
        context: toRuntimeContext(context.context),
      };

      failureCategory = 'runtime_session_create_failed';
      let runtimeSession: Awaited<
        ReturnType<RuntimeAdapter['createSession']>
      >;
      try {
        runtimeSession = await this.runtime.createSession(runtimeInput);
      } catch (reason) {
        if (
          reason instanceof RuntimeAdapterError
          && reason.operationEffect === 'not-applied'
        ) {
          throw new RuntimeNotAppliedFailure(reason);
        }
        throw reason;
      }

      failureCategory = 'runtime_session_ref_or_history_digest_missing';
      const externalSessionRef = runtimeSession.externalSessionRef;
      knownExternalSessionRef = externalSessionRef?.trim()
        ? externalSessionRef
        : undefined;
      if (!knownExternalSessionRef || !runtimeSession.historyDigest) {
        throw new Error(failureCategory);
      }

      failureCategory = 'runtime_session_record_failed';
      await this.repository.recordRuntimeResourceKnown({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        externalResourceKind: 'session',
        externalResourceRef: knownExternalSessionRef,
      });
      failureCategory = 'runtime_session_attach_failed';
      await this.repository.attachRuntimeSession({
        actor: input.actor,
        commandReceiptId: prepared.commandReceiptId,
        runtimeSession,
      });

      return attachedSession(prepared.sessionId, prepared.nodeId);
    } catch (reason) {
      if (reason instanceof RuntimeNotAppliedFailure) {
        const error = runtimeFailureCategory(
          reason.adapterError,
          failureCategory,
        );
        const failureConfirmed = await confirmPersistence(
          () => this.repository.markRuntimeCommandFailure({
            actor: input.actor,
            commandReceiptId: prepared.commandReceiptId,
            retryable: reason.adapterError.retryable,
            error,
          }),
        );
        if (failureConfirmed) {
          throw runtimeOperationFailed(
            prepared.commandReceiptId,
            reason.adapterError.retryable,
          );
        }

        await confirmPersistence(
          () => this.repository.markRuntimeCommandReconciling({
            actor: input.actor,
            commandReceiptId: prepared.commandReceiptId,
            externalResourceKind: 'session',
            lookupMetadata: {
              commandId: input.commandId,
              canvasSessionId: prepared.sessionId,
            },
            error,
          }),
        );
        throw commandRequiresReconciliation(prepared.commandReceiptId);
      }

      await confirmPersistence(
        () => this.repository.markRuntimeCommandReconciling({
          actor: input.actor,
          commandReceiptId: prepared.commandReceiptId,
          externalResourceKind: 'session',
          ...(knownExternalSessionRef === undefined
            ? {}
            : { externalResourceRef: knownExternalSessionRef }),
          lookupMetadata: {
            commandId: input.commandId,
            canvasSessionId: prepared.sessionId,
          },
          error: runtimeFailureCategory(reason, failureCategory),
        }),
      );
      throw commandRequiresReconciliation(prepared.commandReceiptId);
    }
  }
}
