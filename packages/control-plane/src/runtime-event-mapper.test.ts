import type { RuntimeEvent } from '@ai-super-canvas/ai';
import { describe, expect, it } from 'vitest';

import { mapRuntimeEvent } from './runtime-event-mapper';

const base = {
  canvasSessionId: '11111111-1111-4111-8111-111111111111',
  canvasRunId: '22222222-2222-4222-8222-222222222222',
  occurredAt: new Date(0).toISOString(),
};

const passiveEvents: RuntimeEvent[] = [
  {
    ...base,
    eventId: 'event-accepted',
    type: 'run.accepted',
    externalRunRef: 'fake-run-1',
  },
  { ...base, eventId: 'event-started', type: 'run.started' },
  {
    ...base,
    eventId: 'event-delta',
    type: 'model.output.delta',
    text: 'fake ',
  },
  {
    ...base,
    eventId: 'event-tool-requested',
    type: 'tool.requested',
    toolCallRef: 'tool-call-1',
    toolKey: 'search',
    input: { query: 'canvas' },
  },
  {
    ...base,
    eventId: 'event-approval',
    type: 'approval.required',
    approvalRef: 'approval-1',
    toolCallRef: 'tool-call-1',
    toolKey: 'search',
    risk: 'low',
    choices: ['allow-once', 'deny'],
  },
  {
    ...base,
    eventId: 'event-tool-started',
    type: 'tool.started',
    toolCallRef: 'tool-call-1',
  },
  {
    ...base,
    eventId: 'event-tool-delta',
    type: 'tool.output.delta',
    toolCallRef: 'tool-call-1',
    content: 'partial',
  },
  {
    ...base,
    eventId: 'event-tool-completed',
    type: 'tool.completed',
    toolCallRef: 'tool-call-1',
    output: { result: 'done' },
    isError: false,
  },
  {
    ...base,
    eventId: 'event-artifact',
    type: 'artifact.updated',
    artifactKind: 'text',
    title: 'Result',
    content: 'artifact',
  },
  {
    ...base,
    eventId: 'event-warning',
    type: 'runtime.warning',
    code: 'slow',
    message: 'Runtime is slow',
  },
];

describe('mapRuntimeEvent', () => {
  it.each(passiveEvents)('preserves $type without inventing a projection', (event) => {
    expect(mapRuntimeEvent(event)).toEqual({
      runtimeEventKey: event.eventId,
      eventType: event.type,
      payload: event,
      occurredAt: event.occurredAt,
    });
  });

  it('projects completed messages exactly once', () => {
    const event: RuntimeEvent = {
      ...base,
      eventId: 'event-message',
      externalEventRef: 'fake-run-1:event:5',
      type: 'message.completed',
      role: 'assistant',
      content: 'fake fake ',
      externalMessageRef: 'fake-run-1:message:1',
    };

    expect(mapRuntimeEvent(event)).toEqual({
      runtimeEventKey: event.eventId,
      eventType: 'message.completed',
      payload: event,
      externalEventRef: 'fake-run-1:event:5',
      occurredAt: event.occurredAt,
      message: {
        role: 'assistant',
        content: 'fake fake ',
        externalMessageRef: 'fake-run-1:message:1',
      },
    });
  });

  it.each([
    [
      {
        ...base,
        eventId: 'event-completed',
        type: 'run.completed',
      } satisfies RuntimeEvent,
      { status: 'succeeded' },
    ],
    [
      {
        ...base,
        eventId: 'event-failed',
        type: 'run.failed',
        code: 'runtime_unavailable',
        message: 'offline',
        retryable: true,
      } satisfies RuntimeEvent,
      {
        status: 'failed',
        errorCode: 'runtime_unavailable',
        errorMessage: 'offline',
      },
    ],
    [
      {
        ...base,
        eventId: 'event-cancelled',
        type: 'run.cancelled',
        reason: 'user',
      } satisfies RuntimeEvent,
      { status: 'cancelled' },
    ],
  ] as const)('projects terminal event %s', (event, terminal) => {
    expect(mapRuntimeEvent(event).terminal).toEqual(terminal);
  });
});
