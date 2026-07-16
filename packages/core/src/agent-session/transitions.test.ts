import { describe, expect, it } from 'vitest';
import {
  CreateAnchoredSessionCommandSchema,
  CreateBranchSessionCommandSchema,
  assertGrowthTransition,
  assertRunTransition,
} from './index';
import type {
  CanvasId,
  CreateAnchoredSessionCommand,
  GrowthState,
  RunStatus,
  TextQuoteSelector,
} from './index';

const validForkCommand = {
  kind: 'fork-message',
  commandId: '22222222-2222-4222-8222-222222222222',
  workflowId: '33333333-3333-4333-8333-333333333333',
  parentSessionId: '44444444-4444-4444-8444-444444444444',
  atMessageId: '55555555-5555-4555-8555-555555555555',
  sourceRevisionId: '66666666-6666-4666-8666-666666666666',
  agentBindingId: '77777777-7777-4777-8777-777777777777',
  title: '从关键句生长的新会话',
  anchor: {
    sourceKind: 'message',
    sourceId: '55555555-5555-4555-8555-555555555555',
    selector: {
      kind: 'text-quote',
      exact: '每个 Chat 块是一个 Session',
      startCodePoint: 0,
      endCodePoint: 23,
    },
  },
} as const;

const validTrunkCommand = {
  kind: 'anchor-trunk',
  commandId: '26262626-2626-4626-8626-262626262626',
  workflowId: '33333333-3333-4333-8333-333333333333',
  sourceRevisionId: '66666666-6666-4666-8666-666666666666',
  agentBindingId: '77777777-7777-4777-8777-777777777777',
  title: '从主干生长',
  anchor: {
    sourceKind: 'trunk-revision',
    sourceId: '66666666-6666-4666-8666-666666666666',
    selector: { kind: 'text-quote', exact: '关键主干句' },
  },
} as const;

const runStatuses = [
  'queued',
  'running',
  'waiting_approval',
  'reconciling',
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly RunStatus[];

const allowedRunTransitions = new Set([
  'queued -> running',
  'queued -> reconciling',
  'queued -> failed',
  'queued -> cancelled',
  'running -> waiting_approval',
  'running -> reconciling',
  'running -> succeeded',
  'running -> failed',
  'running -> cancelled',
  'waiting_approval -> running',
  'waiting_approval -> reconciling',
  'waiting_approval -> failed',
  'waiting_approval -> cancelled',
  'reconciling -> running',
  'reconciling -> waiting_approval',
  'reconciling -> succeeded',
  'reconciling -> failed',
  'reconciling -> cancelled',
]);

const runTransitionCases = runStatuses.flatMap((current) =>
  runStatuses.map((next) => ({ current, next })),
);

const growthStates = [
  'active',
  'dormant',
  'metabolized',
] as const satisfies readonly GrowthState[];

const allowedGrowthTransitions = new Set([
  'active -> dormant',
  'active -> metabolized',
  'dormant -> active',
  'dormant -> metabolized',
]);

const growthTransitionCases = growthStates.flatMap((current) =>
  growthStates.map((next) => ({ current, next })),
);

describe('agent-session invariants', () => {
  it.each(runTransitionCases)(
    'enforces the exact run transition $current -> $next',
    ({ current, next }) => {
      const transition = `${current} -> ${next}`;
      const assertion = () => assertRunTransition(current, next);

      if (allowedRunTransitions.has(transition)) {
        expect(assertion).not.toThrow();
      } else {
        expect(assertion).toThrowError(`Invalid run transition: ${transition}`);
      }
    },
  );

  it.each(growthTransitionCases)(
    'enforces the exact growth transition $current -> $next',
    ({ current, next }) => {
      const transition = `${current} -> ${next}`;
      const assertion = () => assertGrowthTransition(current, next);

      if (allowedGrowthTransitions.has(transition)) {
        expect(assertion).not.toThrow();
      } else {
        expect(assertion).toThrowError(`Invalid growth transition: ${transition}`);
      }
    },
  );

  it('exports public types inferred from the command schemas', () => {
    const canvasId: CanvasId = validTrunkCommand.commandId;
    const selector: TextQuoteSelector = validTrunkCommand.anchor.selector;
    const command: CreateAnchoredSessionCommand =
      CreateAnchoredSessionCommandSchema.parse(validTrunkCommand);

    expect(canvasId).toBe(validTrunkCommand.commandId);
    expect(selector.kind).toBe('text-quote');
    expect(command.kind).toBe('anchor-trunk');
  });

  it('requires UUIDs for every message-fork identifier', () => {
    for (const field of [
      'commandId',
      'workflowId',
      'parentSessionId',
      'atMessageId',
      'sourceRevisionId',
      'agentBindingId',
    ] as const) {
      expect(() =>
        CreateBranchSessionCommandSchema.parse({
          ...validForkCommand,
          [field]: 'not-a-uuid',
        }),
      ).toThrow();
    }

    expect(() =>
      CreateBranchSessionCommandSchema.parse({
        ...validForkCommand,
        anchor: { ...validForkCommand.anchor, sourceId: 'not-a-uuid' },
      }),
    ).toThrow();
  });

  it('requires UUIDs for every trunk-anchor identifier', () => {
    for (const field of [
      'commandId',
      'workflowId',
      'agentBindingId',
    ] as const) {
      expect(() =>
        CreateBranchSessionCommandSchema.parse({
          ...validTrunkCommand,
          [field]: 'not-a-uuid',
        }),
      ).toThrow();
    }

    const invalidSourceIds = CreateBranchSessionCommandSchema.safeParse({
      ...validTrunkCommand,
      sourceRevisionId: 'not-a-uuid',
      anchor: { ...validTrunkCommand.anchor, sourceId: 'not-a-uuid' },
    });

    expect(invalidSourceIds.success).toBe(false);
    if (!invalidSourceIds.success) {
      expect(invalidSourceIds.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining(['sourceRevisionId', 'anchor.sourceId']),
      );
    }
  });

  it('requires the parent, message, revision and title for a message fork', () => {
    for (const field of [
      'parentSessionId',
      'atMessageId',
      'sourceRevisionId',
      'title',
    ] as const) {
      const command: Record<string, unknown> = { ...validForkCommand };
      delete command[field];
      expect(() => CreateBranchSessionCommandSchema.parse(command)).toThrow();
    }
  });

  it('requires a message text-quote anchor whose source is the fork message', () => {
    const command = CreateBranchSessionCommandSchema.parse(validForkCommand);

    expect(command.anchor.selector.exact).toContain('Session');
    expect(() =>
      CreateBranchSessionCommandSchema.parse({
        ...validForkCommand,
        anchor: { ...validForkCommand.anchor, sourceKind: 'trunk-revision' },
      }),
    ).toThrow();
    expect(() =>
      CreateBranchSessionCommandSchema.parse({
        ...validForkCommand,
        anchor: {
          ...validForkCommand.anchor,
          selector: { ...validForkCommand.anchor.selector, kind: 'other' },
        },
      }),
    ).toThrow();
    expect(() =>
      CreateBranchSessionCommandSchema.parse({
        ...validForkCommand,
        anchor: {
          ...validForkCommand.anchor,
          selector: { ...validForkCommand.anchor.selector, exact: '' },
        },
      }),
    ).toThrow();
    expect(() =>
      CreateBranchSessionCommandSchema.parse({
        ...validForkCommand,
        anchor: {
          ...validForkCommand.anchor,
          sourceId: '88888888-8888-4888-8888-888888888888',
        },
      }),
    ).toThrowError('message anchor must reference atMessageId');
  });

  it('requires paired, ordered code-point positions', () => {
    expect(() =>
      CreateBranchSessionCommandSchema.parse({
        ...validForkCommand,
        anchor: {
          ...validForkCommand.anchor,
          selector: {
            ...validForkCommand.anchor.selector,
            endCodePoint: undefined,
          },
        },
      }),
    ).toThrowError('startCodePoint and endCodePoint must be provided together');
    expect(() =>
      CreateBranchSessionCommandSchema.parse({
        ...validForkCommand,
        anchor: {
          ...validForkCommand.anchor,
          selector: {
            ...validForkCommand.anchor.selector,
            startCodePoint: undefined,
          },
        },
      }),
    ).toThrowError('startCodePoint and endCodePoint must be provided together');
    expect(() =>
      CreateBranchSessionCommandSchema.parse({
        ...validForkCommand,
        anchor: {
          ...validForkCommand.anchor,
          selector: {
            ...validForkCommand.anchor.selector,
            startCodePoint: 5,
            endCodePoint: 5,
          },
        },
      }),
    ).toThrowError('endCodePoint must be greater than startCodePoint');
  });

  it('represents a trunk anchor without fake parent or message fields', () => {
    const command = CreateBranchSessionCommandSchema.parse(validTrunkCommand);

    expect(command.kind).toBe('anchor-trunk');
    expect('parentSessionId' in command).toBe(false);
    expect('atMessageId' in command).toBe(false);
    expect(() =>
      CreateBranchSessionCommandSchema.parse({
        ...validTrunkCommand,
        agentBindingId: undefined,
      }),
    ).toThrow();
    expect(() =>
      CreateBranchSessionCommandSchema.parse({
        ...validTrunkCommand,
        anchor: { ...validTrunkCommand.anchor, sourceKind: 'message' },
      }),
    ).toThrow();
  });

  it('requires a trunk anchor to reference its source revision', () => {
    expect(() =>
      CreateBranchSessionCommandSchema.parse({
        ...validTrunkCommand,
        anchor: {
          ...validTrunkCommand.anchor,
          sourceId: '88888888-8888-4888-8888-888888888888',
        },
      }),
    ).toThrowError('trunk anchor must reference sourceRevisionId');
  });
});
