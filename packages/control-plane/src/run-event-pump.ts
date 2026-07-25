import type {
  RuntimeAdapter,
  RuntimeBindingContext,
  RuntimeEvent,
} from '@ai-super-canvas/ai';
import type { ActorContext } from '@ai-super-canvas/core';
import type {
  ControlPlaneRepository,
  RunRuntimeContext,
} from '@ai-super-canvas/db';

import { mapRuntimeEvent } from './runtime-event-mapper';

export interface RunEventPumpPort {
  start(input: {
    actor: ActorContext;
    runId: string;
  }): 'started' | 'already-active';
}

export interface RunEventPumpLogger {
  error(
    event: string,
    context: Record<string, unknown>,
  ): void | Promise<void>;
}

const defaultLogger: RunEventPumpLogger = {
  error(event, context) {
    console.error(event, context);
  },
};

function toRuntimeBinding(
  binding: RunRuntimeContext['binding'],
): RuntimeBindingContext {
  return {
    canvasAgentBindingId: binding.canvasAgentBindingId,
    isolationKey: binding.isolationKey,
    ...(binding.endpointRef === undefined
      ? {}
      : { endpointRef: binding.endpointRef }),
    ...(binding.secretRef === undefined
      ? {}
      : { secretRef: binding.secretRef }),
  };
}

function isTerminal(event: RuntimeEvent): boolean {
  return event.type === 'run.completed'
    || event.type === 'run.failed'
    || event.type === 'run.cancelled';
}

type RunEventPumpFailureCode =
  | 'runtime_run_ref_missing'
  | 'runtime_event_identity_mismatch'
  | 'runtime_terminal_history_digest_missing'
  | 'runtime_event_stream_ended_without_terminal'
  | 'runtime_event_pump_failed';

class RunEventPumpFailure extends Error {
  constructor(readonly code: RunEventPumpFailureCode) {
    super(code);
    this.name = 'RunEventPumpFailure';
  }
}

function failureCode(reason: unknown): RunEventPumpFailureCode {
  return reason instanceof RunEventPumpFailure
    ? reason.code
    : 'runtime_event_pump_failed';
}

async function logSafely(
  logger: RunEventPumpLogger,
  event: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await logger.error(event, context);
  } catch {
    return;
  }
}

export class RunEventPump implements RunEventPumpPort {
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: RunEventPumpLogger = defaultLogger,
  ) {}

  start(input: {
    actor: ActorContext;
    runId: string;
  }): 'started' | 'already-active' {
    if (this.active.has(input.runId)) return 'already-active';
    const runner = Promise.resolve()
      .then(() => this.consume(input))
      .catch(async (reason: unknown) => {
        const error = failureCode(reason);
        try {
          await this.repository.markRunReconciling({
            actor: input.actor,
            runId: input.runId,
            error,
          });
        } catch {
          await logSafely(
            this.logger,
            'run_event_pump_reconciliation_failed',
            { runId: input.runId, error },
          );
        }
      })
      .finally(() => {
        if (this.active.get(input.runId) === runner) {
          this.active.delete(input.runId);
        }
      });
    this.active.set(input.runId, runner);
    return 'started';
  }

  async waitForIdle(runId: string): Promise<void> {
    await this.active.get(runId);
  }

  async reconcileAfterRestart(): Promise<number> {
    return this.repository.reconcileOrphanedRuns();
  }

  private async consume(input: {
    actor: ActorContext;
    runId: string;
  }): Promise<void> {
    const context = await this.repository.getRunRuntimeContext(input);
    if (!context.externalRunRef) {
      throw new RunEventPumpFailure('runtime_run_ref_missing');
    }
    const binding = toRuntimeBinding(context.binding);
    let terminalSeen = false;

    for await (const event of this.runtime.streamRunEvents({
      binding,
      canvasRunId: context.runId,
      externalRunRef: context.externalRunRef,
    })) {
      if (
        event.canvasRunId !== context.runId
        || event.canvasSessionId !== context.sessionId
      ) {
        throw new RunEventPumpFailure('runtime_event_identity_mismatch');
      }

      if (isTerminal(event)) {
        const runtimeSession = await this.runtime.loadSession({
          commandId: `sync-history:${context.runId}`,
          binding,
          canvasSessionId: context.sessionId,
          externalSessionRef: context.externalSessionRef,
        });
        if (!runtimeSession.historyDigest) {
          throw new RunEventPumpFailure(
            'runtime_terminal_history_digest_missing',
          );
        }
        await this.repository.syncRuntimeSessionHistory({
          actor: input.actor,
          sessionId: context.sessionId,
          historyDigest: runtimeSession.historyDigest,
        });
      }

      await this.repository.ingestRuntimeEvent({
        actor: input.actor,
        runId: input.runId,
        event: mapRuntimeEvent(event),
      });
      if (isTerminal(event)) {
        terminalSeen = true;
        break;
      }
    }

    if (!terminalSeen) {
      throw new RunEventPumpFailure(
        'runtime_event_stream_ended_without_terminal',
      );
    }
  }
}
