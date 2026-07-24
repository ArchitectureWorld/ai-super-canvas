import type { RuntimeEvent } from '@ai-super-canvas/ai';
import type { PersistableRunEvent } from '@ai-super-canvas/db';

function assertNever(value: never): never {
  throw new Error(`Unhandled Runtime event: ${JSON.stringify(value)}`);
}

function baseEvent(event: RuntimeEvent): PersistableRunEvent {
  return {
    runtimeEventKey: event.eventId,
    eventType: event.type,
    payload: event,
    ...(event.externalEventRef === undefined
      ? {}
      : { externalEventRef: event.externalEventRef }),
    occurredAt: event.occurredAt,
  };
}

export function mapRuntimeEvent(event: RuntimeEvent): PersistableRunEvent {
  const base = baseEvent(event);
  switch (event.type) {
    case 'message.completed':
      return {
        ...base,
        message: {
          role: event.role,
          content: event.content,
          ...(event.externalMessageRef === undefined
            ? {}
            : { externalMessageRef: event.externalMessageRef }),
        },
      };
    case 'run.completed':
      return { ...base, terminal: { status: 'succeeded' } };
    case 'run.failed':
      return {
        ...base,
        terminal: {
          status: 'failed',
          errorCode: event.code,
          errorMessage: event.message,
        },
      };
    case 'run.cancelled':
      return { ...base, terminal: { status: 'cancelled' } };
    case 'run.accepted':
    case 'run.started':
    case 'model.output.delta':
    case 'tool.requested':
    case 'approval.required':
    case 'tool.started':
    case 'tool.output.delta':
    case 'tool.completed':
    case 'artifact.updated':
    case 'runtime.warning':
      return base;
    default:
      return assertNever(event);
  }
}
