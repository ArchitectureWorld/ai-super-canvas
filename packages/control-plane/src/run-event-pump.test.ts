import type { RuntimeAdapter, RuntimeEvent } from '@ai-super-canvas/ai';
import type { ActorContext } from '@ai-super-canvas/core';
import type {
  ControlPlaneRepository,
  PersistableRunEvent,
} from '@ai-super-canvas/db';
import { describe, expect, it, vi } from 'vitest';

import { RunEventPump } from './run-event-pump';

const actor: ActorContext = {
  accountId: '11111111-1111-4111-8111-111111111111',
  authSubject: 'local:test-owner',
};

const context = {
  actor,
  workflowId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  runId: '44444444-4444-4444-8444-444444444444',
  status: 'running' as const,
  binding: {
    canvasAgentBindingId: '55555555-5555-4555-8555-555555555555',
    agentId: '66666666-6666-4666-8666-666666666666',
    runtimeKind: 'fake',
    isolationKey: 'local-alpha',
  },
  externalSessionRef: 'fake-session-1',
  externalRunRef: 'fake-run-1',
};

function stream(events: RuntimeEvent[]): AsyncIterable<RuntimeEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function terminalEvents(): RuntimeEvent[] {
  const base = {
    canvasSessionId: context.sessionId,
    canvasRunId: context.runId,
    occurredAt: new Date(0).toISOString(),
  };
  return [
    {
      ...base,
      eventId: 'fake-run-1:event:5',
      externalEventRef: 'fake-run-1:event:5',
      type: 'message.completed',
      role: 'assistant',
      content: 'fake fake ',
      externalMessageRef: 'fake-run-1:message:1',
    },
    {
      ...base,
      eventId: 'fake-run-1:event:6',
      externalEventRef: 'fake-run-1:event:6',
      type: 'run.completed',
    },
  ];
}

function createHarness(events: RuntimeEvent[]) {
  const repository = {
    getRunRuntimeContext: vi.fn().mockResolvedValue(context),
    ingestRuntimeEvent: vi.fn().mockImplementation(async (
      { event }: { event: PersistableRunEvent },
    ) => ({
      runId: context.runId,
      sequence: event.runtimeEventKey.endsWith(':5') ? 1 : 2,
      eventType: event.eventType,
      payload: event.payload,
      externalEventRef: event.externalEventRef ?? null,
      runtimeEventKey: event.runtimeEventKey,
      occurredAt: event.occurredAt,
    })),
    syncRuntimeSessionHistory: vi.fn().mockResolvedValue(undefined),
    markRunReconciling: vi.fn().mockResolvedValue(undefined),
    reconcileOrphanedRuns: vi.fn().mockResolvedValue(0),
  };
  const runtime = {
    streamRunEvents: vi.fn().mockImplementation(() => stream(events)),
    loadSession: vi.fn().mockResolvedValue({
      externalSessionRef: context.externalSessionRef,
      runtimeVersion: '1',
      replayStatus: 'complete',
      historyDigest: 'sha256:after-run',
      metadata: {},
    }),
  };
  const logger = { error: vi.fn() };
  return {
    repository,
    runtime,
    logger,
    pump: new RunEventPump(
      repository as unknown as ControlPlaneRepository,
      runtime as unknown as RuntimeAdapter,
      logger,
    ),
  };
}

describe('RunEventPump', () => {
  it('opens one Runtime stream and persists one terminal sequence', async () => {
    const harness = createHarness(terminalEvents());

    expect(harness.pump.start({ actor, runId: context.runId })).toBe('started');
    expect(harness.pump.start({ actor, runId: context.runId })).toBe('already-active');
    await harness.pump.waitForIdle(context.runId);

    expect(harness.runtime.streamRunEvents).toHaveBeenCalledTimes(1);
    expect(harness.repository.ingestRuntimeEvent).toHaveBeenCalledTimes(2);
    expect(harness.repository.syncRuntimeSessionHistory).toHaveBeenCalledWith({
      actor,
      sessionId: context.sessionId,
      historyDigest: 'sha256:after-run',
    });
    expect(harness.repository.markRunReconciling).not.toHaveBeenCalled();
  });

  it('marks a Run reconciling when the stream ends without a terminal event', async () => {
    const harness = createHarness([]);

    harness.pump.start({ actor, runId: context.runId });
    await harness.pump.waitForIdle(context.runId);

    expect(harness.repository.markRunReconciling).toHaveBeenCalledWith({
      actor,
      runId: context.runId,
      error: 'runtime_event_stream_ended_without_terminal',
    });
  });

  it('rejects an event that names another Canvas Run', async () => {
    const [event] = terminalEvents();
    const harness = createHarness([
      { ...event!, canvasRunId: '77777777-7777-4777-8777-777777777777' },
    ]);

    harness.pump.start({ actor, runId: context.runId });
    await harness.pump.waitForIdle(context.runId);

    expect(harness.repository.ingestRuntimeEvent).not.toHaveBeenCalled();
    expect(harness.repository.markRunReconciling).toHaveBeenCalledWith({
      actor,
      runId: context.runId,
      error: 'runtime_event_identity_mismatch',
    });
  });

  it('observes both stream and reconciliation failures without an unhandled rejection', async () => {
    const harness = createHarness([]);
    harness.repository.markRunReconciling.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      harness.pump.start({ actor, runId: context.runId });
      await harness.pump.waitForIdle(context.runId);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
      expect(harness.logger.error).toHaveBeenCalledWith(
        'run_event_pump_reconciliation_failed',
        expect.objectContaining({ runId: context.runId }),
      );
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('claims a Run before repository loading can synchronously reenter start', async () => {
    const harness = createHarness(terminalEvents());
    let reentrantStart: 'started' | 'already-active' | undefined;
    harness.repository.getRunRuntimeContext.mockImplementationOnce(() => {
      reentrantStart = harness.pump.start({ actor, runId: context.runId });
      return Promise.resolve(context);
    });

    expect(harness.pump.start({ actor, runId: context.runId })).toBe('started');
    await Promise.resolve();

    expect(reentrantStart).toBe('already-active');
    await harness.pump.waitForIdle(context.runId);
    expect(harness.runtime.streamRunEvents).toHaveBeenCalledTimes(1);
  });

  it('keeps the active claim while a reentrant runner finishes out of order', async () => {
    const terminal = terminalEvents().at(-1)!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldStream = (): AsyncIterable<RuntimeEvent> => (async function* () {
      await gate;
      yield terminal;
    })();
    const harness = createHarness([]);
    harness.runtime.streamRunEvents
      .mockImplementationOnce(() => heldStream())
      .mockImplementation(() => stream([terminal]));
    harness.repository.getRunRuntimeContext.mockImplementationOnce(() => {
      harness.pump.start({ actor, runId: context.runId });
      return Promise.resolve(context);
    });

    expect(harness.pump.start({ actor, runId: context.runId })).toBe('started');
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      expect(harness.pump.start({ actor, runId: context.runId }))
        .toBe('already-active');
      expect(harness.runtime.streamRunEvents).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    await harness.pump.waitForIdle(context.runId);
  });

  it('uses a safe failure category for unknown Runtime events', async () => {
    const secretSentinel = 'secretRef:SENTINEL-SECRET';
    const runtimeKeySentinel = 'runtimeEventKey:SENTINEL-RUNTIME-KEY';
    const externalRefSentinel = 'externalRef:SENTINEL-EXTERNAL';
    const [event] = terminalEvents();
    const harness = createHarness([
      {
        ...event!,
        eventId: runtimeKeySentinel,
        externalEventRef: externalRefSentinel,
        type: 'runtime.unknown',
        secretRef: secretSentinel,
      } as unknown as RuntimeEvent,
    ]);

    harness.pump.start({ actor, runId: context.runId });
    await harness.pump.waitForIdle(context.runId);

    expect(harness.repository.markRunReconciling).toHaveBeenCalledWith({
      actor,
      runId: context.runId,
      error: 'runtime_event_pump_failed',
    });
    const persisted = JSON.stringify(
      harness.repository.markRunReconciling.mock.calls,
    );
    expect(persisted).not.toContain(secretSentinel);
    expect(persisted).not.toContain(runtimeKeySentinel);
    expect(persisted).not.toContain(externalRefSentinel);
  });

  it('does not leak repository or reconciliation errors into logs', async () => {
    const secretSentinel = 'secretRef:SENTINEL-SECRET';
    const runtimeKeySentinel = 'runtimeEventKey:SENTINEL-RUNTIME-KEY';
    const externalRefSentinel = 'externalRef:SENTINEL-EXTERNAL';
    const [event] = terminalEvents();
    const harness = createHarness([event!]);
    harness.repository.ingestRuntimeEvent.mockRejectedValueOnce(
      new Error(
        `conflict ${runtimeKeySentinel} ${externalRefSentinel} ${secretSentinel}`,
      ),
    );
    harness.repository.markRunReconciling.mockRejectedValueOnce(
      new Error(
        `database ${runtimeKeySentinel} ${externalRefSentinel} ${secretSentinel}`,
      ),
    );

    harness.pump.start({ actor, runId: context.runId });
    await harness.pump.waitForIdle(context.runId);

    expect(harness.repository.markRunReconciling).toHaveBeenCalledWith({
      actor,
      runId: context.runId,
      error: 'runtime_event_pump_failed',
    });
    expect(harness.logger.error).toHaveBeenCalledWith(
      'run_event_pump_reconciliation_failed',
      {
        runId: context.runId,
        error: 'runtime_event_pump_failed',
      },
    );
    const observableFailures = JSON.stringify({
      persisted: harness.repository.markRunReconciling.mock.calls,
      logged: harness.logger.error.mock.calls,
    });
    expect(observableFailures).not.toContain(secretSentinel);
    expect(observableFailures).not.toContain(runtimeKeySentinel);
    expect(observableFailures).not.toContain(externalRefSentinel);
  });

  it('absorbs a synchronous logger failure and releases the active claim', async () => {
    const harness = createHarness([]);
    harness.repository.markRunReconciling.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    harness.logger.error.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });

    expect(harness.pump.start({ actor, runId: context.runId })).toBe('started');
    await expect(harness.pump.waitForIdle(context.runId)).resolves.toBeUndefined();

    expect(harness.pump.start({ actor, runId: context.runId })).toBe('started');
    await harness.pump.waitForIdle(context.runId);
  });

  it('observes and absorbs an asynchronous logger failure', async () => {
    const harness = createHarness([]);
    harness.repository.markRunReconciling.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    let loggerFailureObserved = false;
    const loggerFailure = {
      then(_resolve: unknown, reject: (reason: unknown) => void) {
        loggerFailureObserved = true;
        reject(new Error('logger unavailable'));
      },
    } as unknown as Promise<void>;
    harness.logger.error.mockReturnValueOnce(loggerFailure);

    harness.pump.start({ actor, runId: context.runId });
    await expect(
      harness.pump.waitForIdle(context.runId),
    ).resolves.toBeUndefined();
    expect(loggerFailureObserved).toBe(true);
  });
});
