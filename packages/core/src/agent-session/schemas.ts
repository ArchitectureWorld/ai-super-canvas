import { z } from 'zod';

export const CanvasIdSchema = z.string().uuid();

export const ActorContextSchema = z.object({
  accountId: CanvasIdSchema,
  authSubject: z.string().trim().min(1),
});

export const GrowthStateSchema = z.enum(['active', 'dormant', 'metabolized']);

export const SessionStatusSchema = z.enum([
  'provisioning',
  'active',
  'dormant',
  'closed',
  'archived',
  'error',
]);

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'reconciling',
  'succeeded',
  'failed',
  'cancelled',
]);

export const TextQuoteSelectorSchema = z
  .object({
    kind: z.literal('text-quote'),
    exact: z.string().min(1),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    startCodePoint: z.number().int().nonnegative().optional(),
    endCodePoint: z.number().int().positive().optional(),
  })
  .superRefine((selector, context) => {
    if (
      (selector.startCodePoint === undefined) !==
      (selector.endCodePoint === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'startCodePoint and endCodePoint must be provided together',
      });
    }

    if (
      selector.startCodePoint !== undefined &&
      selector.endCodePoint !== undefined &&
      selector.endCodePoint <= selector.startCodePoint
    ) {
      context.addIssue({
        code: 'custom',
        message: 'endCodePoint must be greater than startCodePoint',
      });
    }
  });

const CommandBaseSchema = z.object({
  commandId: CanvasIdSchema,
  workflowId: CanvasIdSchema,
  sourceRevisionId: CanvasIdSchema,
  title: z.string().trim().min(1).max(160),
});

export const ForkMessageSessionCommandSchema = CommandBaseSchema.extend({
  kind: z.literal('fork-message'),
  parentSessionId: CanvasIdSchema,
  atMessageId: CanvasIdSchema,
  agentBindingId: CanvasIdSchema.optional(),
  anchor: z.object({
    sourceKind: z.literal('message'),
    sourceId: CanvasIdSchema,
    selector: TextQuoteSelectorSchema,
  }),
});

export const CreateAnchoredSessionCommandSchema = CommandBaseSchema.extend({
  kind: z.literal('anchor-trunk'),
  agentBindingId: CanvasIdSchema,
  anchor: z.object({
    sourceKind: z.literal('trunk-revision'),
    sourceId: CanvasIdSchema,
    selector: TextQuoteSelectorSchema,
  }),
});

export const CreateBranchSessionCommandSchema = z
  .discriminatedUnion('kind', [
    ForkMessageSessionCommandSchema,
    CreateAnchoredSessionCommandSchema,
  ])
  .superRefine((command, context) => {
    if (
      command.kind === 'anchor-trunk' &&
      command.anchor.sourceId !== command.sourceRevisionId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'trunk anchor must reference sourceRevisionId',
      });
    }

    if (
      command.kind === 'fork-message' &&
      command.anchor.sourceId !== command.atMessageId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'message anchor must reference atMessageId',
      });
    }
  });

export type CanvasId = z.infer<typeof CanvasIdSchema>;
export type ActorContext = z.infer<typeof ActorContextSchema>;
export type GrowthState = z.infer<typeof GrowthStateSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type TextQuoteSelector = z.infer<typeof TextQuoteSelectorSchema>;
export type CreateBranchSessionCommand = z.infer<
  typeof CreateBranchSessionCommandSchema
>;
export type ForkMessageSessionCommand = z.infer<
  typeof ForkMessageSessionCommandSchema
>;
export type CreateAnchoredSessionCommand = z.infer<
  typeof CreateAnchoredSessionCommandSchema
>;
