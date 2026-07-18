import { createHash, randomUUID } from 'node:crypto';

import type { ActorContext } from '@ai-super-canvas/core';
import postgres from 'postgres';

import {
  AuthorizationError,
  CommandPayloadConflictError,
  SessionConfigVersionConflictError,
  type AvailableModel,
  type AttachRuntimeSessionInput,
  type BeginRuntimeDispatchInput,
  type BootstrappedControlPlane,
  type BootstrapLocalAlphaInput,
  type ControlPlaneRepository,
  type CreateRootSessionInput,
  type CreatedSession,
  type HydratedWorkflow,
  type LocalAlphaModelSeed,
  type PrepareAnchoredSessionInput,
  type PreparedAnchoredSession,
  type PreparedFork,
  type PrepareForkInput,
  type ResolveRuntimeReconciliationInput,
  type RuntimeCommandFailureInput,
  type RuntimeCommandReconcileInput,
  type RuntimeDispatchState,
  type RuntimeReconciliationResult,
  type RuntimeResourceKnownInput,
  type RuntimeSessionAttachment,
  type SessionRuntimeContext,
  type StoredMessage,
  type StoredModel,
  type StoredSessionConfig,
  type TranscriptMessage,
  type UpdateSessionConfigInput,
} from './control-plane-repository';
import type {
  PreparedRun,
  PrepareRunInput,
  RuntimeBindingSnapshot,
  RuntimeContextSnapshot,
  RuntimeToolPolicySnapshot,
  StoredRunStatus,
} from './control-plane-run-types';

interface CanonicalPayload {
  bytes: Buffer;
  hash: string;
  text: string;
}

interface BootstrapReceiptRow {
  auth_subject: string;
  payload_hash: string;
  payload_canonical: string;
  status: 'pending' | 'completed';
  account_id: string | null;
  agent_id: string | null;
  agent_binding_id: string | null;
  workspace_id: string | null;
  workflow_id: string | null;
  result_payload: unknown;
}

interface CommandReceiptRow {
  id: string;
  payload_hash: string;
  payload_canonical: string;
  orchestration_phase: CreatedSession['phase'];
  result_type: 'session' | 'run' | null;
  result_id: string | null;
  result_payload: unknown;
}

interface AuthorizationRow {
  workflow_id: string;
  workspace_id: string;
  agent_binding_id: string;
  agent_id: string;
  runtime_kind: string;
  isolation_key: string;
  endpoint_ref: string | null;
  secret_ref: string | null;
}

interface PrepareRunSessionRow {
  status: string;
  external_session_ref: string | null;
  runtime_metadata: Record<string, unknown> | null;
}

interface RuntimeContextRow {
  id: string;
  scope: RuntimeContextSnapshot['scope'];
  visibility: RuntimeContextSnapshot['visibility'];
  source_kind: string;
  source_ref: string;
  snapshot: unknown;
  provenance: Record<string, unknown>;
}

interface StoredModelRow {
  id: string;
  runtime_kind: string;
  provider_key: string;
  model_key: string;
  display_name: string;
  capabilities: Record<string, unknown>;
}

interface StoredConfigRow extends StoredModelRow {
  config_id: string;
  session_id: string;
  version: number;
  model_entry_id: string;
  instructions_overlay: string | null;
  tool_policy: Record<string, unknown>;
  context_policy: Record<string, unknown>;
}

interface ReceiptAuthorizationRow {
  id: string;
  workflow_id: string;
  command_key: string;
  result_type: 'session' | 'run';
  result_id: string;
  result_payload: unknown;
  orchestration_phase: CreatedSession['phase'];
  external_resource_kind: string | null;
  external_resource_ref: string | null;
  external_lookup_metadata: Record<string, unknown>;
  agent_binding_id: string;
  session_id: string;
  run_id: string | null;
}

interface CompensationRow {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  external_resource_ref: string | null;
  resolution_evidence: Record<string, unknown>;
  last_error: string | null;
}

export interface PostgresControlPlaneRepositoryHooks {
  afterHydrateSnapshotEstablished?: () => Promise<void> | void;
}

const defaultFakeModel: LocalAlphaModelSeed = {
  providerKey: 'fake',
  modelKey: 'deterministic-v1',
  displayName: 'Deterministic v1',
  capabilities: {},
};

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical payload must contain finite JSON numbers');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Canonical payload must contain only JSON data');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Canonical payload must not contain circular references');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) => {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError('Canonical payload arrays must not be sparse');
        }
        return canonicalize(value[index], ancestors);
      });
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical payload must contain only plain JSON objects');
    }
    const record = value as Record<string, unknown>;
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) {
        throw new TypeError('Canonical payload must not contain undefined values');
      }
      sorted[key] = canonicalize(item, ancestors);
    }
    return sorted;
  } finally {
    ancestors.delete(value);
  }
}

function toCanonicalPayload(value: unknown): CanonicalPayload {
  const text = JSON.stringify(canonicalize(value, new Set()));
  const bytes = Buffer.from(text, 'utf8');
  return {
    bytes,
    hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    text,
  };
}

function exactPayloadMatches(row: BootstrapReceiptRow, payload: CanonicalPayload): boolean {
  return (
    row.payload_hash === payload.hash
    && Buffer.from(row.payload_canonical, 'utf8').equals(payload.bytes)
  );
}

function exactCommandPayloadMatches(
  row: Pick<CommandReceiptRow, 'payload_hash' | 'payload_canonical'>,
  payload: CanonicalPayload,
): boolean {
  return (
    row.payload_hash === payload.hash
    && Buffer.from(row.payload_canonical, 'utf8').equals(payload.bytes)
  );
}

function mapModel(row: StoredModelRow): StoredModel {
  return {
    id: row.id,
    runtimeKind: row.runtime_kind,
    providerKey: row.provider_key,
    modelKey: row.model_key,
    displayName: row.display_name,
    capabilities: row.capabilities,
  };
}

function mapConfig(row: StoredConfigRow): StoredSessionConfig {
  return {
    id: row.config_id,
    sessionId: row.session_id,
    version: row.version,
    modelEntryId: row.model_entry_id,
    model: mapModel(row),
    instructionsOverlay: row.instructions_overlay,
    toolPolicy: row.tool_policy,
    contextPolicy: row.context_policy,
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Stored Runtime tool policy is invalid');
  }
  return [...value];
}

function runtimeToolPolicy(
  value: Record<string, unknown>,
): RuntimeToolPolicySnapshot {
  return {
    allowedToolKeys: stringArray(value.allowedToolKeys),
    deniedToolKeys: stringArray(value.deniedToolKeys),
    approvalRequiredToolKeys: stringArray(value.approvalRequiredToolKeys),
  };
}

function containsExactStructuredText(value: unknown, exact: string): boolean {
  if (typeof value === 'string') return value.includes(exact);
  if (Array.isArray(value)) {
    return value.some((item) => containsExactStructuredText(item, exact));
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((item) => containsExactStructuredText(item, exact));
  }
  return false;
}

function parseFrozenTranscriptPrefix(value: unknown): TranscriptMessage[] {
  if (!Array.isArray(value)) throw new Error('Fork receipt has no frozen transcript prefix');
  const roles = new Set(['user', 'assistant', 'system', 'tool']);
  const seen = new Set<string>();
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Fork receipt has an invalid frozen transcript prefix');
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.canvasMessageId !== 'string'
      || !uuidPattern.test(record.canvasMessageId)
      || seen.has(record.canvasMessageId)
      || typeof record.role !== 'string'
      || !roles.has(record.role)
      || !Object.prototype.hasOwnProperty.call(record, 'content')
    ) {
      throw new Error('Fork receipt has an invalid frozen transcript prefix');
    }
    toCanonicalPayload(record.content);
    seen.add(record.canvasMessageId);
    return {
      canvasMessageId: record.canvasMessageId,
      role: record.role as TranscriptMessage['role'],
      content: record.content,
    };
  });
}

function modelsFromEnvironment(): LocalAlphaModelSeed[] {
  const modelKeys = (process.env.AI_AVAILABLE_MODELS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (modelKeys.length === 0) return [defaultFakeModel];
  return modelKeys.map((modelKey) => ({
    providerKey: 'fake',
    modelKey,
    displayName: modelKey,
    capabilities: {},
  }));
}

function resolveModelSeeds(input: BootstrapLocalAlphaInput): {
  defaultModelProviderKey: string;
  defaultModelKey: string;
  models: LocalAlphaModelSeed[];
} {
  const models = [...(input.availableModels ?? modelsFromEnvironment())]
    .map((model) => ({
      providerKey: model.providerKey.trim(),
      modelKey: model.modelKey.trim(),
      displayName: model.displayName.trim(),
      capabilities: model.capabilities ?? {},
    }))
    .sort((left, right) => {
      const providerOrder = left.providerKey < right.providerKey
        ? -1
        : left.providerKey > right.providerKey
          ? 1
          : 0;
      return providerOrder !== 0
        ? providerOrder
        : left.modelKey < right.modelKey
          ? -1
          : left.modelKey > right.modelKey
            ? 1
            : 0;
    });
  if (models.length === 0) {
    throw new Error('At least one available model is required');
  }
  const identities = new Set<string>();
  for (const model of models) {
    const identity = `${model.providerKey}\u0000${model.modelKey}`;
    if (!model.providerKey || !model.modelKey || !model.displayName) {
      throw new Error('Model providerKey, modelKey, and displayName are required');
    }
    if (identities.has(identity)) throw new Error(`Duplicate model seed: ${model.modelKey}`);
    identities.add(identity);
  }
  const defaultModelKey = (
    input.defaultModelKey ?? process.env.AI_DEFAULT_MODEL ?? models[0]!.modelKey
  ).trim();
  const requestedProvider = (
    input.defaultModelProviderKey ?? process.env.AI_DEFAULT_MODEL_PROVIDER ?? ''
  ).trim();
  const candidates = models.filter((model) => model.modelKey === defaultModelKey);
  if (candidates.length === 0) {
    throw new Error(`Default model is not available: ${defaultModelKey}`);
  }
  if (!requestedProvider && candidates.length > 1) {
    throw new Error(`Ambiguous default model key: ${defaultModelKey}`);
  }
  const selected = requestedProvider
    ? candidates.find((model) => model.providerKey === requestedProvider)
    : candidates[0];
  if (!selected) {
    throw new Error(`Default model provider is not available: ${requestedProvider}`);
  }
  return {
    defaultModelProviderKey: selected.providerKey,
    defaultModelKey,
    models,
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseCompletedBootstrapReceipt(
  receipt: BootstrapReceiptRow,
): BootstrappedControlPlane {
  const value = receipt.result_payload;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid completed bootstrap receipt result payload');
  }
  const record = value as Record<string, unknown>;
  const fields = [
    'accountId',
    'agentId',
    'agentBindingId',
    'workspaceId',
    'workflowId',
    'trunkRevisionId',
    'defaultModelEntryId',
  ] as const;
  if (
    fields.some((field) => typeof record[field] !== 'string' || !uuidPattern.test(record[field]))
    || typeof record.authSubject !== 'string'
  ) {
    throw new Error('Invalid completed bootstrap receipt result payload');
  }
  const result = record as unknown as BootstrappedControlPlane;
  if (
    result.authSubject !== receipt.auth_subject
    || result.accountId !== receipt.account_id
    || result.agentId !== receipt.agent_id
    || result.agentBindingId !== receipt.agent_binding_id
    || result.workspaceId !== receipt.workspace_id
    || result.workflowId !== receipt.workflow_id
  ) {
    throw new Error('Invalid completed bootstrap receipt identity');
  }
  return result;
}

function assertResetAllowed(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  if (
    process.env.NODE_ENV !== 'test'
    || process.env.ALLOW_TEST_DATABASE_RESET !== '1'
    || parsed.hostname !== 'postgres-test'
    || parsed.pathname !== '/canvas_s1_test'
  ) {
    throw new Error('Refusing destructive reset outside isolated canvas_s1_test database');
  }
}

export class PostgresControlPlaneRepository implements ControlPlaneRepository {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(
    private readonly databaseUrl: string,
    private readonly hooks: PostgresControlPlaneRepositoryHooks = {},
  ) {
    this.sql = postgres(databaseUrl, { max: 10 });
  }

  private async authorizeWorkflow(
    tx: postgres.TransactionSql,
    actor: ActorContext,
    workflowId: string,
    agentBindingId?: string,
    write = false,
  ): Promise<AuthorizationRow> {
    const allowedRoles = write
      ? ['owner', 'editor', 'runner']
      : ['owner', 'editor', 'runner', 'viewer'];
    const [authorized] = agentBindingId
      ? await tx<AuthorizationRow[]>`
          SELECT workflow.id AS workflow_id, workflow.workspace_id,
            binding.id AS agent_binding_id, binding.agent_id,
            binding.runtime_kind::text AS runtime_kind, binding.isolation_key,
            binding.endpoint_ref, binding.secret_ref
          FROM accounts account
          JOIN workflows workflow ON workflow.id = ${workflowId}
          JOIN workspace_members member
            ON member.workspace_id = workflow.workspace_id
           AND member.account_id = account.id
          JOIN agent_bindings binding ON binding.id = ${agentBindingId}
          JOIN agents agent ON agent.id = binding.agent_id AND agent.status = 'active'
          WHERE account.id = ${actor.accountId}
            AND account.auth_subject = ${actor.authSubject}
            AND member.role = ANY(${allowedRoles})
            AND binding.status IN ('ready', 'degraded')
            AND (
              agent.owner_account_id = account.id
              OR EXISTS (
                SELECT 1 FROM agent_access_grants access_grant
                WHERE access_grant.agent_id = agent.id
                  AND access_grant.account_id = account.id
                  AND access_grant.revoked_at IS NULL
              )
            )
        `
      : await tx<AuthorizationRow[]>`
          SELECT workflow.id AS workflow_id, workflow.workspace_id,
            binding.id AS agent_binding_id, binding.agent_id,
            binding.runtime_kind::text AS runtime_kind, binding.isolation_key,
            binding.endpoint_ref, binding.secret_ref
          FROM accounts account
          JOIN workflows workflow ON workflow.id = ${workflowId}
          JOIN workspace_members member
            ON member.workspace_id = workflow.workspace_id
           AND member.account_id = account.id
          JOIN agents agent
            ON agent.id = account.default_agent_id AND agent.status = 'active'
          JOIN agent_bindings binding
            ON binding.agent_id = agent.id
           AND binding.is_primary = true
           AND binding.status IN ('ready', 'degraded')
          WHERE account.id = ${actor.accountId}
            AND account.auth_subject = ${actor.authSubject}
            AND member.role = ANY(${allowedRoles})
            AND (
              agent.owner_account_id = account.id
              OR EXISTS (
                SELECT 1 FROM agent_access_grants access_grant
                WHERE access_grant.agent_id = agent.id
                  AND access_grant.account_id = account.id
                  AND access_grant.revoked_at IS NULL
              )
            )
          ORDER BY binding.id
          LIMIT 1
        `;
    if (!authorized) throw new AuthorizationError();
    return authorized;
  }

  private async authorizeWorkflowMembership(
    tx: postgres.TransactionSql,
    actor: ActorContext,
    workflowId: string,
  ): Promise<{ workflow_id: string; workspace_id: string }> {
    const [authorized] = await tx<{ workflow_id: string; workspace_id: string }[]>`
      SELECT workflow.id AS workflow_id, workflow.workspace_id
      FROM accounts account
      JOIN workflows workflow ON workflow.id = ${workflowId}
      JOIN workspace_members member
        ON member.workspace_id = workflow.workspace_id
       AND member.account_id = account.id
      WHERE account.id = ${actor.accountId}
        AND account.auth_subject = ${actor.authSubject}
        AND member.role IN ('owner', 'editor', 'runner', 'viewer')
    `;
    if (!authorized) throw new AuthorizationError();
    return authorized;
  }

  private async authorizeSession(
    tx: postgres.TransactionSql,
    actor: ActorContext,
    sessionId: string,
    options: { lock?: boolean; write?: boolean } = {},
  ): Promise<AuthorizationRow> {
    const allowedRoles = options.write
      ? ['owner', 'editor', 'runner']
      : ['owner', 'editor', 'runner', 'viewer'];
    const query = options.lock
      ? tx<AuthorizationRow[]>`
          SELECT session.workflow_id, workflow.workspace_id,
            binding.id AS agent_binding_id, binding.agent_id,
            binding.runtime_kind::text AS runtime_kind, binding.isolation_key,
            binding.endpoint_ref, binding.secret_ref
          FROM sessions session
          JOIN workflows workflow ON workflow.id = session.workflow_id
          JOIN accounts account
            ON account.id = ${actor.accountId}
           AND account.auth_subject = ${actor.authSubject}
          JOIN workspace_members member
            ON member.workspace_id = workflow.workspace_id
           AND member.account_id = account.id
          JOIN agent_bindings binding ON binding.id = session.agent_binding_id
          JOIN agents agent ON agent.id = binding.agent_id AND agent.status = 'active'
          WHERE session.id = ${sessionId}
            AND member.role = ANY(${allowedRoles})
            AND binding.status IN ('ready', 'degraded')
            AND (
              agent.owner_account_id = account.id
              OR EXISTS (
                SELECT 1 FROM agent_access_grants access_grant
                WHERE access_grant.agent_id = agent.id
                  AND access_grant.account_id = account.id
                  AND access_grant.revoked_at IS NULL
              )
            )
          FOR UPDATE OF session
        `
      : tx<AuthorizationRow[]>`
          SELECT session.workflow_id, workflow.workspace_id,
            binding.id AS agent_binding_id, binding.agent_id,
            binding.runtime_kind::text AS runtime_kind, binding.isolation_key,
            binding.endpoint_ref, binding.secret_ref
          FROM sessions session
          JOIN workflows workflow ON workflow.id = session.workflow_id
          JOIN accounts account
            ON account.id = ${actor.accountId}
           AND account.auth_subject = ${actor.authSubject}
          JOIN workspace_members member
            ON member.workspace_id = workflow.workspace_id
           AND member.account_id = account.id
          JOIN agent_bindings binding ON binding.id = session.agent_binding_id
          JOIN agents agent ON agent.id = binding.agent_id AND agent.status = 'active'
          WHERE session.id = ${sessionId}
            AND member.role = ANY(${allowedRoles})
            AND binding.status IN ('ready', 'degraded')
            AND (
              agent.owner_account_id = account.id
              OR EXISTS (
                SELECT 1 FROM agent_access_grants access_grant
                WHERE access_grant.agent_id = agent.id
                  AND access_grant.account_id = account.id
                  AND access_grant.revoked_at IS NULL
              )
            )
        `;
    const [authorized] = await query;
    if (!authorized) throw new AuthorizationError();
    return authorized;
  }

  private async loadConfig(
    tx: postgres.TransactionSql,
    sessionId: string,
    configId?: string,
  ): Promise<StoredSessionConfig> {
    const [row] = await tx<StoredConfigRow[]>`
      SELECT config.id AS config_id, config.session_id, config.version,
        config.model_entry_id, config.instructions_overlay, config.tool_policy,
        config.context_policy, model.id, model.runtime_kind::text AS runtime_kind,
        model.provider_key, model.model_key, model.display_name, model.capabilities
      FROM session_config_revisions config
      JOIN model_catalog_entries model ON model.id = config.model_entry_id
      WHERE config.session_id = ${sessionId}
        AND (${configId ?? null}::uuid IS NULL OR config.id = ${configId ?? null})
      ORDER BY config.version DESC
      LIMIT 1
    `;
    if (!row) throw new Error(`Session config is missing for ${sessionId}`);
    return mapConfig(row);
  }

  private async replayPreparedSession(
    tx: postgres.TransactionSql,
    receipt: CommandReceiptRow,
    workflowId: string,
    kind: 'root',
  ): Promise<CreatedSession>;

  private async replayPreparedSession(
    tx: postgres.TransactionSql,
    receipt: CommandReceiptRow,
    workflowId: string,
    kind: 'anchor',
  ): Promise<PreparedAnchoredSession>;

  private async replayPreparedSession(
    tx: postgres.TransactionSql,
    receipt: CommandReceiptRow,
    workflowId: string,
    kind: 'fork',
  ): Promise<PreparedFork>;

  private async replayPreparedSession(
    tx: postgres.TransactionSql,
    receipt: CommandReceiptRow,
    workflowId: string,
    kind: 'root' | 'anchor' | 'fork',
  ): Promise<CreatedSession | PreparedAnchoredSession | PreparedFork> {
    const value = receipt.result_payload;
    if (
      receipt.result_type !== 'session'
      || receipt.result_id === null
      || value === null
      || typeof value !== 'object'
      || Array.isArray(value)
    ) {
      throw new Error('Invalid persisted Session command result payload');
    }
    const record = value as Record<string, unknown>;
    const configRecord = record.config;
    const status = record.status;
    if (
      record.commandReceiptId !== receipt.id
      || record.sessionId !== receipt.result_id
      || typeof record.nodeId !== 'string'
      || !uuidPattern.test(record.nodeId)
      || (status !== 'provisioning' && status !== 'active')
      || configRecord === null
      || typeof configRecord !== 'object'
      || Array.isArray(configRecord)
      || typeof (configRecord as Record<string, unknown>).id !== 'string'
      || !uuidPattern.test((configRecord as Record<string, unknown>).id as string)
    ) {
      throw new Error('Invalid persisted Session command result payload');
    }
    const configId = (configRecord as Record<string, unknown>).id as string;
    const [identity] = await tx<{
      session_id: string;
      node_id: string;
      parent_session_id: string | null;
      fork_anchor_id: string | null;
    }[]>`
      SELECT session.id AS session_id, node.id AS node_id,
        session.parent_session_id, session.fork_anchor_id
      FROM sessions session
      JOIN session_nodes node
        ON node.session_id = session.id AND node.workflow_id = session.workflow_id
      JOIN session_config_revisions config
        ON config.id = ${configId} AND config.session_id = session.id
      WHERE session.id = ${receipt.result_id}
        AND session.workflow_id = ${workflowId}
        AND node.id = ${record.nodeId as string}
    `;
    if (!identity) throw new Error('Invalid persisted Session result DB identity');
    const base: CreatedSession = {
      commandReceiptId: receipt.id,
      phase: receipt.orchestration_phase,
      sessionId: identity.session_id,
      nodeId: identity.node_id,
      status,
      config: await this.loadConfig(tx, identity.session_id, configId),
    };
    if (kind === 'root') {
      if (identity.parent_session_id !== null || identity.fork_anchor_id !== null) {
        throw new Error('Invalid persisted root Session DB identity');
      }
      return base;
    }
    if (
      typeof record.anchorId !== 'string'
      || !uuidPattern.test(record.anchorId)
      || identity.fork_anchor_id !== record.anchorId
    ) {
      throw new Error('Invalid persisted branch Session result payload');
    }
    const [anchor] = await tx<{ id: string }[]>`
      SELECT id FROM branch_anchors
      WHERE id = ${record.anchorId} AND workflow_id = ${workflowId}
    `;
    if (!anchor) throw new Error('Invalid persisted branch Anchor DB identity');
    if (kind === 'anchor') {
      if (identity.parent_session_id !== null) {
        throw new Error('Invalid persisted anchored Session DB identity');
      }
      return { ...base, anchorId: anchor.id };
    }
    if (
      typeof record.parentSessionId !== 'string'
      || !uuidPattern.test(record.parentSessionId)
      || identity.parent_session_id !== record.parentSessionId
      || typeof record.parentExternalSessionRef !== 'string'
      || record.parentExternalSessionRef.length === 0
      || typeof record.expectedParentHistoryDigest !== 'string'
      || record.expectedParentHistoryDigest.length === 0
      || typeof record.transcriptPrefixDigest !== 'string'
    ) {
      throw new Error('Invalid persisted fork Session result payload');
    }
    const transcriptPrefix = parseFrozenTranscriptPrefix(record.transcriptPrefix);
    const transcriptPrefixDigest = toCanonicalPayload(transcriptPrefix).hash;
    if (transcriptPrefixDigest !== record.transcriptPrefixDigest) {
      throw new Error('Invalid persisted fork transcript prefix digest');
    }
    return {
      ...base,
      anchorId: anchor.id,
      parentSessionId: record.parentSessionId,
      parentExternalSessionRef: record.parentExternalSessionRef,
      expectedParentHistoryDigest: record.expectedParentHistoryDigest,
      transcriptPrefixDigest,
      transcriptPrefix,
    };
  }

  private async loadDefaultModel(
    tx: postgres.TransactionSql,
    authorization: AuthorizationRow,
  ): Promise<StoredModelRow> {
    const [bootstrapped] = await tx<StoredModelRow[]>`
      SELECT model.id, model.runtime_kind::text AS runtime_kind, model.provider_key,
        model.model_key, model.display_name, model.capabilities
      FROM bootstrap_receipts receipt
      JOIN agents agent ON agent.id = receipt.agent_id
      JOIN model_catalog_entries model
        ON model.id::text = receipt.result_payload ->> 'defaultModelEntryId'
       AND model.model_key = agent.default_model_key
      WHERE receipt.agent_id = ${authorization.agent_id}
        AND receipt.status = 'completed'
        AND model.runtime_kind = ${authorization.runtime_kind}::runtime_kind
        AND model.availability = 'available'
      ORDER BY receipt.completed_at DESC, receipt.id DESC
      LIMIT 1
    `;
    if (bootstrapped) return bootstrapped;

    const candidates = await tx<StoredModelRow[]>`
      SELECT model.id, model.runtime_kind::text AS runtime_kind, model.provider_key,
        model.model_key, model.display_name, model.capabilities
      FROM agents agent
      JOIN model_catalog_entries model
        ON model.runtime_kind = ${authorization.runtime_kind}::runtime_kind
       AND model.model_key = agent.default_model_key
       AND model.availability = 'available'
      WHERE agent.id = ${authorization.agent_id}
      ORDER BY model.provider_key, model.model_key, model.id
    `;
    if (candidates.length !== 1) {
      throw new Error('Default model identity is missing or ambiguous for Agent binding');
    }
    return candidates[0]!;
  }

  private async loadTranscriptProjection(
    tx: postgres.TransactionSql,
    sessionId: string,
  ): Promise<StoredMessage[]> {
    const [session] = await tx<{
      parent_session_id: string | null;
      source_message_id: string | null;
    }[]>`
      SELECT session.parent_session_id, anchor.source_message_id
      FROM sessions session
      LEFT JOIN branch_anchors anchor ON anchor.id = session.fork_anchor_id
      WHERE session.id = ${sessionId}
    `;
    if (!session) throw new Error(`Session is missing: ${sessionId}`);

    let inherited: StoredMessage[] = [];
    if (session.parent_session_id && session.source_message_id) {
      const receiptRows = await tx<{ result_payload: unknown }[]>`
        SELECT result_payload
        FROM command_receipts
        WHERE command_type = 'prepare-fork'
          AND result_type = 'session'
          AND result_id = ${sessionId}
        ORDER BY created_at, id
        LIMIT 2
      `;
      if (receiptRows.length !== 1) {
        throw new Error(`Fork Session has no unique immutable receipt: ${sessionId}`);
      }
      const payload = receiptRows[0]!.result_payload;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Fork receipt has an invalid result payload');
      }
      const prefix = parseFrozenTranscriptPrefix(
        (payload as Record<string, unknown>).transcriptPrefix,
      );
      inherited = prefix.map((message, ordinal) => ({
        id: message.canvasMessageId,
        sessionId,
        runId: null,
        ordinal,
        role: message.role,
        content: message.content,
        status: 'completed',
        externalMessageRef: null,
        sourceRuntimeEventKey: null,
      }));
    }
    const own = await tx<{
      id: string;
      session_id: string;
      run_id: string | null;
      ordinal: number;
      role: StoredMessage['role'];
      content: unknown;
      status: string;
      external_message_ref: string | null;
      source_runtime_event_key: string | null;
    }[]>`
      SELECT id, session_id, run_id, ordinal::integer AS ordinal,
        role::text AS role, content, status,
        external_message_ref, source_runtime_event_key
      FROM messages
      WHERE session_id = ${sessionId}
      ORDER BY ordinal, id
    `;
    return [
      ...inherited,
      ...own.map((message) => ({
        id: message.id,
        sessionId: message.session_id,
        runId: message.run_id,
        ordinal: message.ordinal,
        role: message.role,
        content: message.content,
        status: message.status,
        externalMessageRef: message.external_message_ref,
        sourceRuntimeEventKey: message.source_runtime_event_key,
      })),
    ];
  }

  private async authorizeReceipt(
    tx: postgres.TransactionSql,
    actor: ActorContext,
    commandReceiptId: string,
  ): Promise<ReceiptAuthorizationRow> {
    const [receipt] = await tx<ReceiptAuthorizationRow[]>`
      SELECT receipt.id, receipt.workflow_id, receipt.command_key,
        receipt.result_type, receipt.result_id, receipt.result_payload,
        receipt.orchestration_phase, receipt.external_resource_kind,
        receipt.external_resource_ref, receipt.external_lookup_metadata,
        target_session.agent_binding_id, target_session.id AS session_id,
        target_run.id AS run_id
      FROM command_receipts receipt
      JOIN accounts account
        ON account.id = receipt.account_id
       AND account.id = ${actor.accountId}
       AND account.auth_subject = ${actor.authSubject}
      JOIN workflows workflow ON workflow.id = receipt.workflow_id
      JOIN workspace_members member
        ON member.workspace_id = workflow.workspace_id
       AND member.account_id = account.id
       AND member.role IN ('owner', 'editor', 'runner')
      LEFT JOIN runs target_run
        ON receipt.result_type = 'run' AND target_run.id = receipt.result_id
      JOIN sessions target_session
        ON target_session.id = CASE
          WHEN receipt.result_type = 'session' THEN receipt.result_id
          ELSE target_run.session_id
        END
      JOIN agent_bindings binding ON binding.id = target_session.agent_binding_id
      JOIN agents agent ON agent.id = binding.agent_id AND agent.status = 'active'
      WHERE receipt.id = ${commandReceiptId}
        AND binding.status IN ('ready', 'degraded')
        AND (
          agent.owner_account_id = account.id
          OR EXISTS (
            SELECT 1 FROM agent_access_grants access_grant
            WHERE access_grant.agent_id = agent.id
              AND access_grant.account_id = account.id
              AND access_grant.revoked_at IS NULL
          )
        )
      FOR UPDATE OF receipt
    `;
    if (!receipt) throw new AuthorizationError();
    return receipt;
  }

  private compensationMetadata(
    receipt: ReceiptAuthorizationRow,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ...extra,
      commandId: receipt.command_key,
      canvasSessionId: receipt.session_id,
      ...(receipt.run_id ? { canvasRunId: receipt.run_id } : {}),
    };
  }

  private async upsertPendingCompensation(
    tx: postgres.TransactionSql,
    receipt: ReceiptAuthorizationRow,
    externalResourceKind: 'session' | 'run',
    externalResourceRef: string | null,
    lookupMetadata: Record<string, unknown>,
    lastError: string | null,
    resetResolution: boolean,
  ): Promise<void> {
    const [activeCompensation] = await tx<{ id: string }[]>`
      SELECT id
      FROM runtime_compensations
      WHERE command_receipt_id = ${receipt.id}
        AND external_resource_kind = ${externalResourceKind}
        AND action = 'adopt'
        AND status <> 'succeeded'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `;
    if (activeCompensation) {
      await tx`
        UPDATE runtime_compensations
        SET external_resource_ref = COALESCE(
              external_resource_ref, ${externalResourceRef}
            ),
          lookup_metadata = ${tx.json(lookupMetadata as postgres.JSONValue)},
          status = CASE WHEN ${resetResolution} THEN 'pending' ELSE status END,
          last_error = ${lastError},
          resolution_evidence = CASE
            WHEN ${resetResolution} THEN '{}'::jsonb
            ELSE resolution_evidence
          END,
          resolved_at = CASE WHEN ${resetResolution} THEN NULL ELSE resolved_at END,
          updated_at = now()
        WHERE id = ${activeCompensation.id}
      `;
      return;
    }

    const [attempt] = await tx<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM runtime_compensations
      WHERE command_receipt_id = ${receipt.id}
        AND external_resource_kind = ${externalResourceKind}
        AND action = 'adopt'
    `;
    await tx`
      INSERT INTO runtime_compensations (
        id, command_receipt_id, agent_binding_id, canvas_session_id, canvas_run_id,
        external_resource_kind, external_resource_ref, lookup_metadata,
        dedupe_key, action, status, last_error
      ) VALUES (
        ${randomUUID()}, ${receipt.id}, ${receipt.agent_binding_id},
        ${receipt.session_id}, ${receipt.run_id}, ${externalResourceKind},
        ${externalResourceRef}, ${tx.json(lookupMetadata as postgres.JSONValue)},
        ${`${externalResourceKind}:${receipt.command_key}:attempt:${(attempt?.count ?? 0) + 1}`},
        'adopt', 'pending',
        ${lastError}
      )
    `;
  }

  private async attachRuntimeSessionInTransaction(
    tx: postgres.TransactionSql,
    receipt: ReceiptAuthorizationRow,
    runtimeSession: RuntimeSessionAttachment,
    evidence: Record<string, unknown>,
  ): Promise<void> {
    if (receipt.orchestration_phase === 'attached') return;
    if (receipt.result_type !== 'session') {
      throw new Error('Command receipt does not describe a Session');
    }
    if (!['runtime_known', 'reconciling'].includes(receipt.orchestration_phase)) {
      throw new Error(`Runtime Session cannot attach from ${receipt.orchestration_phase}`);
    }
    if (
      receipt.external_resource_kind !== null
      && receipt.external_resource_kind !== 'session'
    ) {
      throw new Error('Runtime resource kind conflicts with Session attach');
    }
    if (
      receipt.external_resource_ref !== null
      && receipt.external_resource_ref !== runtimeSession.externalSessionRef
    ) {
      throw new Error('Runtime Session reference conflicts with recorded resource');
    }

    const [existingRef] = await tx<{
      id: string;
      external_session_ref: string;
      agent_binding_id: string;
    }[]>`
      SELECT id, external_session_ref, agent_binding_id
      FROM session_runtime_refs
      WHERE session_id = ${receipt.session_id} AND is_primary = true AND status = 'active'
      FOR UPDATE
    `;
    if (
      existingRef
      && (
        existingRef.external_session_ref !== runtimeSession.externalSessionRef
        || existingRef.agent_binding_id !== receipt.agent_binding_id
      )
    ) {
      throw new Error('Session already has a different active Runtime reference');
    }
    const runtimeMetadata = {
      ...runtimeSession.metadata,
      replayStatus: runtimeSession.replayStatus,
      ...(runtimeSession.historyDigest
        ? { historyDigest: runtimeSession.historyDigest }
        : {}),
    };
    if (!existingRef) {
      await tx`
        INSERT INTO session_runtime_refs (
          id, session_id, agent_binding_id, external_session_ref, runtime_version,
          is_primary, status, sync_cursor, metadata
        ) VALUES (
          ${randomUUID()}, ${receipt.session_id}, ${receipt.agent_binding_id},
          ${runtimeSession.externalSessionRef}, ${runtimeSession.runtimeVersion}, true,
          'active', '{}'::jsonb, ${tx.json(runtimeMetadata as postgres.JSONValue)}
        )
      `;
    }

    const [compensation] = await tx<CompensationRow[]>`
      SELECT id, status, attempts, external_resource_ref, resolution_evidence, last_error
      FROM runtime_compensations
      WHERE command_receipt_id = ${receipt.id}
        AND external_resource_kind = 'session' AND action = 'adopt'
      ORDER BY (status = 'succeeded') ASC, created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `;
    const lookupMetadata = Object.keys(receipt.external_lookup_metadata).length > 0
      ? receipt.external_lookup_metadata
      : this.compensationMetadata(receipt);
    const compensationId = compensation?.id ?? randomUUID();
    if (!compensation) {
      await tx`
        INSERT INTO runtime_compensations (
          id, command_receipt_id, agent_binding_id, canvas_session_id,
          external_resource_kind, external_resource_ref, lookup_metadata,
          dedupe_key, action, status
        ) VALUES (
          ${compensationId}, ${receipt.id}, ${receipt.agent_binding_id},
          ${receipt.session_id}, 'session', ${runtimeSession.externalSessionRef},
          ${tx.json(lookupMetadata as postgres.JSONValue)},
          ${`session:${receipt.command_key}`}, 'adopt', 'pending'
        )
      `;
    }
    if (compensation?.status !== 'succeeded') {
      await tx`
        UPDATE runtime_compensations
        SET external_resource_ref = COALESCE(
              external_resource_ref, ${runtimeSession.externalSessionRef}
            ),
          status = 'succeeded', attempts = attempts + 1, last_error = NULL,
          resolution_evidence = ${tx.json(evidence as postgres.JSONValue)},
          resolved_at = now(), updated_at = now()
        WHERE id = ${compensationId}
      `;
    }
    await tx`
      UPDATE sessions SET status = 'active', updated_at = now()
      WHERE id = ${receipt.session_id}
    `;
    await tx`
      UPDATE command_receipts
      SET orchestration_phase = 'attached',
        external_resource_kind = COALESCE(external_resource_kind, 'session'),
        external_resource_ref = COALESCE(
          external_resource_ref, ${runtimeSession.externalSessionRef}
        ),
        external_lookup_metadata = CASE
          WHEN external_lookup_metadata = '{}'::jsonb
            THEN ${tx.json(lookupMetadata as postgres.JSONValue)}
          ELSE external_lookup_metadata
        END,
        last_error = NULL, completed_at = COALESCE(completed_at, now())
      WHERE id = ${receipt.id}
    `;
  }

  async bootstrapLocalAlpha(
    input: BootstrapLocalAlphaInput,
  ): Promise<BootstrappedControlPlane> {
    const { defaultModelProviderKey, defaultModelKey, models } = resolveModelSeeds(input);
    const payload = toCanonicalPayload({
      availableModels: models.map((model) => ({
        capabilities: model.capabilities ?? {},
        displayName: model.displayName,
        modelKey: model.modelKey,
        providerKey: model.providerKey,
      })),
      defaultModelKey,
      defaultModelProviderKey,
      displayName: input.displayName,
    });

    return this.sql.begin(async (tx) => {
      await tx`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${input.authSubject}, 0)
        )
      `;
      const receiptId = randomUUID();
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO bootstrap_receipts (
          id, auth_subject, command_key, payload_hash, payload_canonical
        ) VALUES (
          ${receiptId}, ${input.authSubject}, ${input.commandId}, ${payload.hash}, ${payload.text}
        )
        ON CONFLICT (auth_subject, command_key) DO NOTHING
        RETURNING id
      `;
      const [receipt] = await tx<BootstrapReceiptRow[]>`
        SELECT auth_subject, payload_hash, payload_canonical, status,
          account_id, agent_id, agent_binding_id, workspace_id, workflow_id,
          result_payload
        FROM bootstrap_receipts
        WHERE auth_subject = ${input.authSubject}
          AND command_key = ${input.commandId}
        FOR UPDATE
      `;
      if (!receipt) throw new Error('Bootstrap receipt disappeared');
      if (!exactPayloadMatches(receipt, payload)) {
        throw new CommandPayloadConflictError(input.commandId);
      }
      if (receipt.status === 'completed') {
        return parseCompletedBootstrapReceipt(receipt);
      }
      if (inserted.length === 0) {
        throw new Error('Bootstrap receipt is unexpectedly pending');
      }

      const [existingAccount] = await tx<{ id: string; default_agent_id: string | null }[]>`
        SELECT id, default_agent_id
        FROM accounts
        WHERE auth_subject = ${input.authSubject}
        FOR UPDATE
      `;
      const accountId = existingAccount?.id ?? randomUUID();
      if (!existingAccount) {
        await tx`
          INSERT INTO accounts (id, auth_subject, display_name)
          VALUES (${accountId}, ${input.authSubject}, ${input.displayName})
        `;
      }

      let agentId = existingAccount?.default_agent_id ?? null;
      if (agentId) {
        const [ownedAgent] = await tx<{ id: string }[]>`
          SELECT id FROM agents
          WHERE id = ${agentId} AND owner_account_id = ${accountId} AND status = 'active'
          FOR UPDATE
        `;
        if (!ownedAgent) throw new Error('Account default Agent is not active and owned');
      } else {
        agentId = randomUUID();
        await tx`
          INSERT INTO agents (
            id, owner_account_id, name, status, default_model_key
          ) VALUES (
            ${agentId}, ${accountId}, 'Local Alpha Agent', 'active', ${defaultModelKey}
          )
        `;
        await tx`UPDATE accounts SET default_agent_id = ${agentId} WHERE id = ${accountId}`;
      }

      const activeGrant = await tx<{ id: string }[]>`
        SELECT id FROM agent_access_grants
        WHERE agent_id = ${agentId} AND account_id = ${accountId} AND revoked_at IS NULL
        FOR UPDATE
      `;
      if (activeGrant.length === 0) {
        await tx`
          INSERT INTO agent_access_grants (
            id, agent_id, account_id, role, granted_by_account_id
          ) VALUES (
            ${randomUUID()}, ${agentId}, ${accountId}, 'admin', ${accountId}
          )
        `;
      }

      let [binding] = await tx<{ id: string }[]>`
        SELECT id FROM agent_bindings
        WHERE agent_id = ${agentId}
          AND runtime_kind = 'fake'
          AND is_primary = true
          AND status IN ('ready', 'degraded')
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE
      `;
      if (!binding) {
        binding = { id: randomUUID() };
        await tx`
          INSERT INTO agent_bindings (
            id, agent_id, runtime_kind, isolation_key, status, is_primary,
            runtime_version, capabilities
          ) VALUES (
            ${binding.id}, ${agentId}, 'fake', ${`local-alpha:${accountId}`}, 'ready', true,
            'deterministic-v1', '{}'::jsonb
          )
        `;
      }

      const modelIds = new Map<string, string>();
      for (const model of models) {
        const [entry] = await tx<{ id: string }[]>`
          INSERT INTO model_catalog_entries (
            id, runtime_kind, provider_key, model_key, display_name, capabilities,
            availability, discovery_source, observed_at
          ) VALUES (
            ${randomUUID()}, 'fake', ${model.providerKey}, ${model.modelKey},
            ${model.displayName}, ${tx.json(
              (model.capabilities ?? {}) as postgres.JSONValue,
            )},
            'available', 'local-alpha-bootstrap', now()
          )
          ON CONFLICT (runtime_kind, provider_key, model_key) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            capabilities = EXCLUDED.capabilities,
            availability = 'available',
            discovery_source = EXCLUDED.discovery_source,
            observed_at = EXCLUDED.observed_at
          RETURNING id
        `;
        if (!entry) throw new Error(`Model catalog upsert failed: ${model.modelKey}`);
        modelIds.set(`${model.providerKey}\u0000${model.modelKey}`, entry.id);
      }
      const defaultModelEntryId = modelIds.get(
        `${defaultModelProviderKey}\u0000${defaultModelKey}`,
      );
      if (!defaultModelEntryId) throw new Error('Default model entry was not seeded');
      await tx`
        UPDATE agents SET default_model_key = ${defaultModelKey}, updated_at = now()
        WHERE id = ${agentId}
      `;

      let [workspace] = await tx<{ id: string }[]>`
        SELECT id FROM workspaces
        WHERE owner_account_id = ${accountId}
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE
      `;
      if (!workspace) {
        workspace = { id: randomUUID() };
        await tx`
          INSERT INTO workspaces (id, owner_account_id, name)
          VALUES (${workspace.id}, ${accountId}, 'Local Alpha Workspace')
        `;
      }
      await tx`
        INSERT INTO workspace_members (workspace_id, account_id, role)
        VALUES (${workspace.id}, ${accountId}, 'owner')
        ON CONFLICT (workspace_id, account_id) DO UPDATE SET role = 'owner'
      `;

      let [workflow] = await tx<{ id: string; current_trunk_revision_id: string | null }[]>`
        SELECT id, current_trunk_revision_id
        FROM workflows
        WHERE workspace_id = ${workspace.id} AND status = 'active'
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE
      `;
      if (!workflow) {
        workflow = { id: randomUUID(), current_trunk_revision_id: null };
        await tx`
          INSERT INTO workflows (
            id, workspace_id, title, status, created_by_account_id
          ) VALUES (
            ${workflow.id}, ${workspace.id}, 'Local Alpha Workflow', 'active', ${accountId}
          )
        `;
      }

      let trunkRevisionId = workflow.current_trunk_revision_id;
      if (!trunkRevisionId) {
        trunkRevisionId = randomUUID();
        const trunkContent = { blocks: [], type: 'document' };
        const trunkPayload = toCanonicalPayload(trunkContent);
        await tx`
          INSERT INTO trunk_revisions (
            id, workflow_id, revision_number, content, content_hash, created_by_account_id
          ) VALUES (
            ${trunkRevisionId}, ${workflow.id}, 1, ${tx.json(trunkContent)},
            ${trunkPayload.hash}, ${accountId}
          )
        `;
        await tx`
          UPDATE workflows
          SET current_trunk_revision_id = ${trunkRevisionId}, updated_at = now()
          WHERE id = ${workflow.id}
        `;
      }

      const result: BootstrappedControlPlane = {
        accountId,
        authSubject: input.authSubject,
        agentId,
        agentBindingId: binding.id,
        workspaceId: workspace.id,
        workflowId: workflow.id,
        trunkRevisionId,
        defaultModelEntryId,
      };
      await tx`
        UPDATE bootstrap_receipts
        SET status = 'completed', account_id = ${accountId}, agent_id = ${agentId},
          agent_binding_id = ${binding.id}, workspace_id = ${workspace.id},
          workflow_id = ${workflow.id}, result_payload = ${tx.json(
            result as unknown as postgres.JSONValue,
          )},
          completed_at = now()
        WHERE id = ${receiptId}
      `;
      return result;
    });
  }

  async createRootSession(input: CreateRootSessionInput): Promise<CreatedSession> {
    const payload = toCanonicalPayload({
      agentBindingId: input.agentBindingId,
      title: input.title,
      workflowId: input.workflowId,
    });

    return this.sql.begin(async (tx) => {
      const authorization = await this.authorizeWorkflow(
        tx,
        input.actor,
        input.workflowId,
        input.agentBindingId,
        true,
      );
      const proposedReceiptId = randomUUID();
      await tx`
        INSERT INTO command_receipts (
          id, workflow_id, account_id, command_key, command_type,
          payload_hash, payload_canonical
        ) VALUES (
          ${proposedReceiptId}, ${input.workflowId}, ${input.actor.accountId},
          ${input.commandId}, 'create-root-session', ${payload.hash}, ${payload.text}
        )
        ON CONFLICT (workflow_id, command_key) DO NOTHING
      `;
      const [receipt] = await tx<CommandReceiptRow[]>`
        SELECT id, payload_hash, payload_canonical, orchestration_phase,
          result_type, result_id, result_payload
        FROM command_receipts
        WHERE workflow_id = ${input.workflowId} AND command_key = ${input.commandId}
        FOR UPDATE
      `;
      if (!receipt) throw new Error('Root Session command receipt disappeared');
      if (!exactCommandPayloadMatches(receipt, payload)) {
        throw new CommandPayloadConflictError(input.commandId);
      }
      if (receipt.result_payload) {
        return this.replayPreparedSession(tx, receipt, input.workflowId, 'root');
      }

      const model = await this.loadDefaultModel(tx, authorization);

      const sessionId = randomUUID();
      const nodeId = randomUUID();
      const configId = randomUUID();
      const toolPolicy = {
        allowedToolKeys: [],
        approvalRequiredToolKeys: [],
        deniedToolKeys: [],
      };
      const contextPolicy = {};
      await tx`
        INSERT INTO sessions (
          id, workflow_id, agent_binding_id, status, created_by_account_id
        ) VALUES (
          ${sessionId}, ${input.workflowId}, ${input.agentBindingId},
          'provisioning', ${input.actor.accountId}
        )
      `;
      await tx`
        INSERT INTO session_nodes (
          id, workflow_id, session_id, title, node_kind, growth_state
        ) VALUES (
          ${nodeId}, ${input.workflowId}, ${sessionId}, ${input.title},
          'mainline', 'active'
        )
      `;
      await tx`
        INSERT INTO session_config_revisions (
          id, session_id, version, model_entry_id, tool_policy, context_policy,
          created_by_account_id
        ) VALUES (
          ${configId}, ${sessionId}, 1, ${model.id}, ${tx.json(toolPolicy)},
          ${tx.json(contextPolicy)}, ${input.actor.accountId}
        )
      `;
      const config = await this.loadConfig(tx, sessionId, configId);
      const result: CreatedSession = {
        commandReceiptId: receipt.id,
        phase: receipt.orchestration_phase,
        sessionId,
        nodeId,
        status: 'provisioning',
        config,
      };
      await tx`
        UPDATE command_receipts
        SET result_type = 'session', result_id = ${sessionId},
          result_payload = ${tx.json(result as unknown as postgres.JSONValue)}
        WHERE id = ${receipt.id}
      `;
      return result;
    });
  }

  async prepareRun(input: PrepareRunInput): Promise<PreparedRun> {
    return this.sql.begin(async (tx) => {
      const authorization = await this.authorizeSession(
        tx,
        input.actor,
        input.sessionId,
        { lock: true, write: true },
      );
      const payload = toCanonicalPayload({
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        content: input.content,
      });

      const proposedReceiptId = randomUUID();
      await tx`
        INSERT INTO command_receipts (
          id, workflow_id, account_id, command_key, command_type,
          payload_hash, payload_canonical
        ) VALUES (
          ${proposedReceiptId}, ${authorization.workflow_id}, ${input.actor.accountId},
          ${input.commandId}, 'start-run', ${payload.hash}, ${payload.text}
        )
        ON CONFLICT (workflow_id, command_key) DO NOTHING
      `;
      const [receipt] = await tx<CommandReceiptRow[]>`
        SELECT id, payload_hash, payload_canonical, orchestration_phase,
          result_type, result_id, result_payload
        FROM command_receipts
        WHERE workflow_id = ${authorization.workflow_id}
          AND command_key = ${input.commandId}
        FOR UPDATE
      `;
      if (!receipt) throw new Error('Run command receipt disappeared');
      if (!exactCommandPayloadMatches(receipt, payload)) {
        throw new CommandPayloadConflictError(input.commandId);
      }
      if (receipt.result_payload !== null) {
        const value = receipt.result_payload;
        const record = value !== null && typeof value === 'object' && !Array.isArray(value)
          ? value as Record<string, unknown>
          : null;
        if (
          receipt.result_type !== 'run'
          || receipt.result_id === null
          || record === null
          || record.commandReceiptId !== receipt.id
          || record.workflowId !== authorization.workflow_id
          || record.sessionId !== input.sessionId
          || record.runId !== receipt.result_id
          || record.prompt === null
          || typeof record.prompt !== 'object'
          || Array.isArray(record.prompt)
          || record.runtime === null
          || typeof record.runtime !== 'object'
          || Array.isArray(record.runtime)
        ) {
          throw new Error('Invalid persisted Run command result payload');
        }
        const [run] = await tx<{ status: StoredRunStatus }[]>`
          SELECT status::text AS status
          FROM runs
          WHERE id = ${receipt.result_id} AND session_id = ${input.sessionId}
        `;
        if (!run) throw new Error('Invalid persisted Run result DB identity');
        return {
          ...(record as unknown as PreparedRun),
          commandReceiptId: receipt.id,
          phase: receipt.orchestration_phase,
          workflowId: authorization.workflow_id,
          sessionId: input.sessionId,
          runId: receipt.result_id,
          status: run.status,
        };
      }

      const [session] = await tx<PrepareRunSessionRow[]>`
        SELECT session.status::text AS status,
          runtime_ref.external_session_ref,
          runtime_ref.metadata AS runtime_metadata
        FROM sessions session
        LEFT JOIN session_runtime_refs runtime_ref
          ON runtime_ref.session_id = session.id
         AND runtime_ref.is_primary = true
         AND runtime_ref.status = 'active'
        WHERE session.id = ${input.sessionId}
      `;
      if (!session || session.status !== 'active') {
        throw new Error('Session must be active to prepare a Run');
      }
      if (session.external_session_ref === null) {
        throw new Error('Session has no active primary Runtime reference');
      }
      const historyDigest = session.runtime_metadata?.historyDigest;
      if (typeof historyDigest !== 'string') {
        throw new Error('Session Runtime reference has no history digest');
      }

      const config = await this.loadConfig(tx, input.sessionId);
      const model = {
        providerKey: config.model.providerKey,
        modelKey: config.model.modelKey,
      };
      const toolPolicy = runtimeToolPolicy(config.toolPolicy);
      const contextRows = await tx<RuntimeContextRow[]>`
        SELECT id, scope::text AS scope, visibility::text AS visibility,
          source_kind, source_ref, snapshot, provenance
        FROM context_refs
        WHERE (expires_at IS NULL OR expires_at > now())
          AND (
            (visibility = 'private' AND account_id = ${input.actor.accountId})
            OR visibility = 'workspace'
          )
          AND (
            (scope = 'account' AND account_id = ${input.actor.accountId})
            OR (scope = 'agent' AND agent_id = ${authorization.agent_id})
            OR (scope = 'workflow' AND workflow_id = ${authorization.workflow_id})
            OR (scope = 'session' AND session_id = ${input.sessionId})
          )
        ORDER BY created_at, id
      `;
      const context: RuntimeContextSnapshot[] = contextRows.map((row) => ({
        canvasContextRefId: row.id,
        scope: row.scope,
        visibility: row.visibility,
        content: row.snapshot,
        provenance: {
          ...row.provenance,
          sourceKind: row.source_kind,
          sourceRef: row.source_ref,
        },
      }));

      const [idempotentRun] = await tx<{ id: string }[]>`
        SELECT id FROM runs
        WHERE session_id = ${input.sessionId}
          AND idempotency_key = ${input.idempotencyKey}
      `;
      if (idempotentRun) {
        throw new Error(`Run idempotency conflict for ${input.idempotencyKey}`);
      }
      const [nextMessage] = await tx<{ ordinal: number }[]>`
        SELECT (COALESCE(MAX(ordinal), -1) + 1)::integer AS ordinal
        FROM messages
        WHERE session_id = ${input.sessionId}
      `;
      if (!nextMessage) throw new Error('Next Session Message ordinal is unavailable');

      const canvasMessageId = randomUUID();
      await tx`
        INSERT INTO messages (
          id, workflow_id, session_id, ordinal, role,
          actor_account_id, content, status
        ) VALUES (
          ${canvasMessageId}, ${authorization.workflow_id}, ${input.sessionId},
          ${nextMessage.ordinal}, 'user', ${input.actor.accountId},
          ${tx.json(input.content)}, 'completed'
        )
      `;

      const runId = randomUUID();
      await tx`
        INSERT INTO runs (
          id, session_id, agent_binding_id, config_revision_id,
          trigger_message_id, idempotency_key, status, model_snapshot,
          tool_policy_snapshot, context_policy_snapshot
        ) VALUES (
          ${runId}, ${input.sessionId}, ${authorization.agent_binding_id}, ${config.id},
          ${canvasMessageId}, ${input.idempotencyKey}, 'queued', ${tx.json(model)},
          ${tx.json(toolPolicy as unknown as postgres.JSONValue)},
          ${tx.json(context as unknown as postgres.JSONValue)}
        )
      `;

      const binding: RuntimeBindingSnapshot = {
        canvasAgentBindingId: authorization.agent_binding_id,
        agentId: authorization.agent_id,
        runtimeKind: authorization.runtime_kind,
        isolationKey: authorization.isolation_key,
        ...(authorization.endpoint_ref === null
          ? {}
          : { endpointRef: authorization.endpoint_ref }),
        ...(authorization.secret_ref === null
          ? {}
          : { secretRef: authorization.secret_ref }),
      };
      const result: PreparedRun = {
        commandReceiptId: receipt.id,
        phase: receipt.orchestration_phase,
        workflowId: authorization.workflow_id,
        sessionId: input.sessionId,
        runId,
        status: 'queued',
        prompt: {
          canvasMessageId,
          role: 'user',
          content: input.content,
        },
        runtime: {
          binding,
          externalSessionRef: session.external_session_ref,
          expectedHistoryDigest: historyDigest,
          model,
          toolPolicy,
          context,
        },
      };
      await tx`
        UPDATE command_receipts
        SET result_type = 'run', result_id = ${runId},
          result_payload = ${tx.json(result as unknown as postgres.JSONValue)}
        WHERE id = ${receipt.id}
      `;
      return result;
    });
  }

  async prepareAnchoredSession(
    input: PrepareAnchoredSessionInput,
  ): Promise<PreparedAnchoredSession> {
    const command = input.command;
    if (
      command.kind !== 'anchor-trunk'
      || command.anchor.sourceId !== command.sourceRevisionId
    ) {
      throw new Error('Anchor lineage is invalid');
    }
    const payload = toCanonicalPayload(command);

    return this.sql.begin(async (tx) => {
      const authorization = await this.authorizeWorkflow(
        tx,
        input.actor,
        command.workflowId,
        command.agentBindingId,
        true,
      );
      const [sourceRevision] = await tx<{ id: string; content: unknown }[]>`
        SELECT id, content FROM trunk_revisions
        WHERE id = ${command.sourceRevisionId} AND workflow_id = ${command.workflowId}
        FOR SHARE
      `;
      if (!sourceRevision) throw new Error('Anchor lineage is invalid across Workflow');
      if (!containsExactStructuredText(sourceRevision.content, command.anchor.selector.exact)) {
        throw new Error('Anchor selector exact text does not match the source Trunk revision');
      }

      const proposedReceiptId = randomUUID();
      await tx`
        INSERT INTO command_receipts (
          id, workflow_id, account_id, command_key, command_type,
          payload_hash, payload_canonical
        ) VALUES (
          ${proposedReceiptId}, ${command.workflowId}, ${input.actor.accountId},
          ${command.commandId}, 'prepare-anchored-session', ${payload.hash}, ${payload.text}
        )
        ON CONFLICT (workflow_id, command_key) DO NOTHING
      `;
      const [receipt] = await tx<CommandReceiptRow[]>`
        SELECT id, payload_hash, payload_canonical, orchestration_phase,
          result_type, result_id, result_payload
        FROM command_receipts
        WHERE workflow_id = ${command.workflowId} AND command_key = ${command.commandId}
        FOR UPDATE
      `;
      if (!receipt) throw new Error('Anchored Session command receipt disappeared');
      if (!exactCommandPayloadMatches(receipt, payload)) {
        throw new CommandPayloadConflictError(command.commandId);
      }
      if (receipt.result_payload) {
        return this.replayPreparedSession(tx, receipt, command.workflowId, 'anchor');
      }

      const model = await this.loadDefaultModel(tx, authorization);
      const anchorId = randomUUID();
      const sessionId = randomUUID();
      const nodeId = randomUUID();
      const configId = randomUUID();
      const edgeId = randomUUID();
      const toolPolicy = {
        allowedToolKeys: [],
        approvalRequiredToolKeys: [],
        deniedToolKeys: [],
      };
      await tx`
        INSERT INTO branch_anchors (
          id, workflow_id, source_kind, context_trunk_revision_id,
          source_trunk_revision_id, selector, quote, created_by_account_id
        ) VALUES (
          ${anchorId}, ${command.workflowId}, 'trunk_revision', ${command.sourceRevisionId},
          ${command.sourceRevisionId}, ${tx.json(
            command.anchor.selector as unknown as postgres.JSONValue,
          )}, ${command.anchor.selector.exact}, ${input.actor.accountId}
        )
      `;
      await tx`
        INSERT INTO sessions (
          id, workflow_id, agent_binding_id, fork_anchor_id, status,
          created_by_account_id
        ) VALUES (
          ${sessionId}, ${command.workflowId}, ${command.agentBindingId}, ${anchorId},
          'provisioning', ${input.actor.accountId}
        )
      `;
      await tx`
        INSERT INTO session_nodes (
          id, workflow_id, session_id, title, node_kind, growth_state
        ) VALUES (
          ${nodeId}, ${command.workflowId}, ${sessionId}, ${command.title},
          'branch', 'active'
        )
      `;
      await tx`
        INSERT INTO session_edges (
          id, workflow_id, source_session_node_id, target_session_node_id,
          kind, anchor_id, metadata
        ) VALUES (
          ${edgeId}, ${command.workflowId}, NULL, ${nodeId}, 'derives', ${anchorId},
          '{}'::jsonb
        )
      `;
      await tx`
        INSERT INTO session_config_revisions (
          id, session_id, version, model_entry_id, tool_policy, context_policy,
          created_by_account_id
        ) VALUES (
          ${configId}, ${sessionId}, 1, ${model.id}, ${tx.json(toolPolicy)},
          '{}'::jsonb, ${input.actor.accountId}
        )
      `;
      const result: PreparedAnchoredSession = {
        commandReceiptId: receipt.id,
        phase: receipt.orchestration_phase,
        sessionId,
        nodeId,
        anchorId,
        status: 'provisioning',
        config: await this.loadConfig(tx, sessionId, configId),
      };
      await tx`
        UPDATE command_receipts
        SET result_type = 'session', result_id = ${sessionId},
          result_payload = ${tx.json(result as unknown as postgres.JSONValue)}
        WHERE id = ${receipt.id}
      `;
      return result;
    });
  }

  async prepareFork(input: PrepareForkInput): Promise<PreparedFork> {
    const command = input.command;
    if (command.kind !== 'fork-message' || command.anchor.sourceId !== command.atMessageId) {
      throw new Error('Message anchor must reference atMessageId');
    }

    return this.sql.begin(async (tx) => {
      const parentAuthorization = await this.authorizeSession(
        tx,
        input.actor,
        command.parentSessionId,
        { lock: true, write: true },
      );
      if (parentAuthorization.workflow_id !== command.workflowId) {
        throw new Error('Fork parent lineage crosses Workflow');
      }
      const childBindingId = command.agentBindingId ?? parentAuthorization.agent_binding_id;
      const childAuthorization = await this.authorizeWorkflow(
        tx,
        input.actor,
        command.workflowId,
        childBindingId,
        true,
      );
      const [sourceRevision] = await tx<{ id: string }[]>`
        SELECT id FROM trunk_revisions
        WHERE id = ${command.sourceRevisionId} AND workflow_id = ${command.workflowId}
        FOR SHARE
      `;
      if (!sourceRevision) throw new Error('Fork context lineage crosses Workflow');
      const [boundary] = await tx<{
        ordinal: number;
        status: string;
        content: unknown;
      }[]>`
        SELECT ordinal, status, content FROM messages
        WHERE id = ${command.atMessageId}
          AND session_id = ${command.parentSessionId}
          AND workflow_id = ${command.workflowId}
        FOR SHARE
      `;
      if (!boundary) throw new Error('Fork message lineage crosses Session or Workflow');
      const projectedTranscript = await this.loadTranscriptProjection(
        tx,
        command.parentSessionId,
      );
      const boundaryIndex = projectedTranscript.findIndex(
        (message) => message.id === command.atMessageId,
      );
      if (boundaryIndex < 0) throw new Error('Fork boundary is absent from parent transcript');
      const prefixRows = projectedTranscript.slice(0, boundaryIndex + 1);
      if (
        prefixRows.some(
          (message, index) => message.status !== 'completed' || message.ordinal !== index,
        )
      ) {
        throw new Error('Fork transcript prefix must be contiguous and fully completed');
      }
      const transcriptPrefix = prefixRows.map((message) => ({
        canvasMessageId: message.id,
        role: message.role,
        content: message.content,
      }));
      const transcriptPrefixDigest = toCanonicalPayload(transcriptPrefix).hash;
      const [runtimeRef] = await tx<{
        external_session_ref: string;
        metadata: Record<string, unknown>;
      }[]>`
        SELECT external_session_ref, metadata
        FROM session_runtime_refs
        WHERE session_id = ${command.parentSessionId}
          AND is_primary = true AND status = 'active'
        FOR SHARE
      `;
      if (!runtimeRef) throw new Error('Parent Session has no active Runtime reference');
      const expectedParentHistoryDigest = runtimeRef.metadata.historyDigest;
      if (typeof expectedParentHistoryDigest !== 'string') {
        throw new Error('Parent Runtime reference has no history digest');
      }
      const payload = toCanonicalPayload({ command, transcriptPrefix });

      const proposedReceiptId = randomUUID();
      await tx`
        INSERT INTO command_receipts (
          id, workflow_id, account_id, command_key, command_type,
          payload_hash, payload_canonical
        ) VALUES (
          ${proposedReceiptId}, ${command.workflowId}, ${input.actor.accountId},
          ${command.commandId}, 'prepare-fork', ${payload.hash}, ${payload.text}
        )
        ON CONFLICT (workflow_id, command_key) DO NOTHING
      `;
      const [receipt] = await tx<CommandReceiptRow[]>`
        SELECT id, payload_hash, payload_canonical, orchestration_phase,
          result_type, result_id, result_payload
        FROM command_receipts
        WHERE workflow_id = ${command.workflowId} AND command_key = ${command.commandId}
        FOR UPDATE
      `;
      if (!receipt) throw new Error('Fork command receipt disappeared');
      if (!exactCommandPayloadMatches(receipt, payload)) {
        throw new CommandPayloadConflictError(command.commandId);
      }
      if (receipt.result_payload) {
        return this.replayPreparedSession(tx, receipt, command.workflowId, 'fork');
      }
      if (!containsExactStructuredText(boundary.content, command.anchor.selector.exact)) {
        throw new Error('Message anchor selector exact text does not match the boundary message');
      }

      const [parentNode] = await tx<{ id: string }[]>`
        SELECT id FROM session_nodes
        WHERE session_id = ${command.parentSessionId} AND workflow_id = ${command.workflowId}
        FOR SHARE
      `;
      if (!parentNode) throw new Error('Fork parent SessionNode is missing');
      const parentConfig = await this.loadConfig(tx, command.parentSessionId);
      const [availableInheritedModel] = parentAuthorization.runtime_kind
        === childAuthorization.runtime_kind
        ? await tx<{ id: string }[]>`
            SELECT id FROM model_catalog_entries
            WHERE id = ${parentConfig.modelEntryId}
              AND runtime_kind = ${childAuthorization.runtime_kind}::runtime_kind
              AND availability = 'available'
          `
        : [];
      const childModelEntryId = availableInheritedModel?.id
        ?? (await this.loadDefaultModel(tx, childAuthorization)).id;
      const anchorId = randomUUID();
      const sessionId = randomUUID();
      const nodeId = randomUUID();
      const configId = randomUUID();
      await tx`
        INSERT INTO branch_anchors (
          id, workflow_id, source_kind, context_trunk_revision_id,
          source_message_id, selector, quote, created_by_account_id
        ) VALUES (
          ${anchorId}, ${command.workflowId}, 'message', ${command.sourceRevisionId},
          ${command.atMessageId}, ${tx.json(
            command.anchor.selector as unknown as postgres.JSONValue,
          )}, ${command.anchor.selector.exact}, ${input.actor.accountId}
        )
      `;
      await tx`
        INSERT INTO sessions (
          id, workflow_id, agent_binding_id, parent_session_id, fork_anchor_id,
          status, transcript_version, created_by_account_id
        ) VALUES (
          ${sessionId}, ${command.workflowId}, ${childBindingId},
          ${command.parentSessionId}, ${anchorId}, 'provisioning',
          ${transcriptPrefix.length}, ${input.actor.accountId}
        )
      `;
      await tx`
        INSERT INTO session_nodes (
          id, workflow_id, session_id, title, node_kind, growth_state
        ) VALUES (
          ${nodeId}, ${command.workflowId}, ${sessionId}, ${command.title},
          'branch', 'active'
        )
      `;
      await tx`
        INSERT INTO session_edges (
          id, workflow_id, source_session_node_id, target_session_node_id,
          kind, anchor_id, metadata
        ) VALUES (
          ${randomUUID()}, ${command.workflowId}, ${parentNode.id}, ${nodeId},
          'derives', ${anchorId}, '{}'::jsonb
        )
      `;
      await tx`
        INSERT INTO session_config_revisions (
          id, session_id, version, model_entry_id, instructions_overlay,
          tool_policy, context_policy, created_by_account_id
        ) VALUES (
          ${configId}, ${sessionId}, 1, ${childModelEntryId},
          ${parentConfig.instructionsOverlay}, ${tx.json(
            parentConfig.toolPolicy as postgres.JSONValue,
          )}, ${tx.json(parentConfig.contextPolicy as postgres.JSONValue)},
          ${input.actor.accountId}
        )
      `;
      const result: PreparedFork = {
        commandReceiptId: receipt.id,
        phase: receipt.orchestration_phase,
        sessionId,
        nodeId,
        anchorId,
        status: 'provisioning',
        config: await this.loadConfig(tx, sessionId, configId),
        parentSessionId: command.parentSessionId,
        parentExternalSessionRef: runtimeRef.external_session_ref,
        expectedParentHistoryDigest,
        transcriptPrefixDigest,
        transcriptPrefix,
      };
      await tx`
        UPDATE command_receipts
        SET result_type = 'session', result_id = ${sessionId},
          result_payload = ${tx.json(result as unknown as postgres.JSONValue)}
        WHERE id = ${receipt.id}
      `;
      return result;
    });
  }

  async listAvailableModels(input: {
    actor: ActorContext;
    sessionId: string;
  }): Promise<AvailableModel[]> {
    return this.sql.begin(async (tx) => {
      const authorization = await this.authorizeSession(tx, input.actor, input.sessionId);
      const rows = await tx<(StoredModelRow & { availability: 'available' })[]>`
        SELECT id, runtime_kind::text AS runtime_kind, provider_key, model_key,
          display_name, capabilities, availability
        FROM model_catalog_entries
        WHERE runtime_kind = ${authorization.runtime_kind}::runtime_kind
          AND availability = 'available'
        ORDER BY provider_key, model_key, id
      `;
      return rows.map((row) => ({ ...mapModel(row), availability: row.availability }));
    });
  }

  async loadSessionTranscript(input: {
    actor: ActorContext;
    sessionId: string;
  }): Promise<StoredMessage[]> {
    return this.sql.begin(async (tx) => {
      await this.authorizeSession(tx, input.actor, input.sessionId);
      return this.loadTranscriptProjection(tx, input.sessionId);
    });
  }

  async updateSessionConfig(
    input: UpdateSessionConfigInput,
  ): Promise<StoredSessionConfig> {
    return this.sql.begin(async (tx) => {
      const authorization = await this.authorizeSession(tx, input.actor, input.sessionId, {
        lock: true,
        write: true,
      });
      const [existing] = await tx<{
        id: string;
        session_id: string;
        version: number;
        model_entry_id: string | null;
      }[]>`
        SELECT id, session_id, version, model_entry_id
        FROM session_config_revisions
        WHERE id = ${input.commandId}
      `;
      if (existing) {
        if (
          existing.session_id !== input.sessionId
          || existing.version !== input.expectedVersion + 1
          || existing.model_entry_id !== input.modelEntryId
        ) {
          throw new CommandPayloadConflictError(input.commandId);
        }
        return this.loadConfig(tx, input.sessionId, input.commandId);
      }

      const [current] = await tx<{
        id: string;
        version: number;
      }[]>`
        SELECT id, version FROM session_config_revisions
        WHERE session_id = ${input.sessionId}
        ORDER BY version DESC
        LIMIT 1
      `;
      if (!current) throw new Error(`Session config is missing for ${input.sessionId}`);
      if (current.version !== input.expectedVersion) {
        throw new SessionConfigVersionConflictError(input.expectedVersion, current.version);
      }
      const [model] = await tx<{ id: string }[]>`
        SELECT id FROM model_catalog_entries
        WHERE id = ${input.modelEntryId}
          AND runtime_kind = ${authorization.runtime_kind}::runtime_kind
          AND availability = 'available'
      `;
      if (!model) throw new Error('Selected model is not available for this Session runtime');

      await tx`
        INSERT INTO session_config_revisions (
          id, session_id, version, model_entry_id, instructions_overlay,
          tool_policy, context_policy, created_by_account_id
        )
        SELECT ${input.commandId}, ${input.sessionId}, ${input.expectedVersion + 1},
          ${input.modelEntryId}, instructions_overlay, tool_policy, context_policy,
          ${input.actor.accountId}
        FROM session_config_revisions
        WHERE id = ${current.id}
      `;
      await tx`UPDATE sessions SET updated_at = now() WHERE id = ${input.sessionId}`;
      return this.loadConfig(tx, input.sessionId, input.commandId);
    });
  }

  async beginRuntimeDispatch(
    input: BeginRuntimeDispatchInput,
  ): Promise<RuntimeDispatchState> {
    return this.sql.begin(async (tx) => {
      const receipt = await this.authorizeReceipt(
        tx,
        input.actor,
        input.commandReceiptId,
      );
      if (!['canvas_prepared', 'retryable_failure'].includes(receipt.orchestration_phase)) {
        return { phase: receipt.orchestration_phase, dispatchAllowed: false };
      }
      await tx`
        UPDATE command_receipts
        SET orchestration_phase = 'runtime_dispatched', last_error = NULL,
          completed_at = NULL
        WHERE id = ${receipt.id}
      `;
      return { phase: 'runtime_dispatched', dispatchAllowed: true };
    });
  }

  async recordRuntimeResourceKnown(input: RuntimeResourceKnownInput): Promise<void> {
    await this.sql.begin(async (tx) => {
      const receipt = await this.authorizeReceipt(
        tx,
        input.actor,
        input.commandReceiptId,
      );
      if (receipt.orchestration_phase === 'attached') return;
      if (receipt.result_type !== input.externalResourceKind) {
        throw new Error('Runtime resource kind conflicts with the Canvas result');
      }
      if (!input.externalResourceRef.trim()) {
        throw new Error('Runtime resource reference must not be empty');
      }
      if (
        receipt.external_resource_kind !== null
        && receipt.external_resource_kind !== input.externalResourceKind
      ) {
        throw new Error('Runtime resource kind conflicts with the recorded resource');
      }
      if (
        receipt.external_resource_ref !== null
        && receipt.external_resource_ref !== input.externalResourceRef
      ) {
        throw new Error('Runtime resource reference conflicts with the recorded resource');
      }
      if (!['runtime_dispatched', 'runtime_known', 'reconciling'].includes(
        receipt.orchestration_phase,
      )) {
        throw new Error(
          `Runtime resource cannot be recorded from ${receipt.orchestration_phase}`,
        );
      }
      const lookupMetadata = {
        ...receipt.external_lookup_metadata,
        ...this.compensationMetadata(receipt, input.lookupMetadata),
      };
      await tx`
        UPDATE command_receipts
        SET orchestration_phase = 'runtime_known',
          external_resource_kind = ${input.externalResourceKind},
          external_resource_ref = ${input.externalResourceRef},
          external_lookup_metadata = ${tx.json(
            lookupMetadata as postgres.JSONValue,
          )},
          last_error = NULL, completed_at = NULL
        WHERE id = ${receipt.id}
      `;
      await this.upsertPendingCompensation(
        tx,
        receipt,
        input.externalResourceKind,
        input.externalResourceRef,
        lookupMetadata,
        null,
        receipt.orchestration_phase !== 'runtime_known',
      );
    });
  }

  async attachRuntimeSession(input: AttachRuntimeSessionInput): Promise<void> {
    await this.sql.begin(async (tx) => {
      const receipt = await this.authorizeReceipt(
        tx,
        input.actor,
        input.commandReceiptId,
      );
      await this.attachRuntimeSessionInTransaction(tx, receipt, input.runtimeSession, {
        outcome: 'adopted',
        path: 'normal-command',
        externalSessionRef: input.runtimeSession.externalSessionRef,
      });
    });
  }

  async markRuntimeCommandFailure(input: RuntimeCommandFailureInput): Promise<void> {
    await this.sql.begin(async (tx) => {
      const receipt = await this.authorizeReceipt(
        tx,
        input.actor,
        input.commandReceiptId,
      );
      if (
        receipt.orchestration_phase === 'attached'
        || receipt.orchestration_phase === 'terminal_failure'
      ) {
        return;
      }
      if (
        receipt.orchestration_phase === 'runtime_known'
        || receipt.orchestration_phase === 'reconciling'
      ) {
        const externalResourceKind = receipt.result_type;
        const lookupMetadata = Object.keys(receipt.external_lookup_metadata).length > 0
          ? receipt.external_lookup_metadata
          : this.compensationMetadata(receipt);
        await tx`
          UPDATE command_receipts
          SET orchestration_phase = 'reconciling', last_error = ${input.error},
            external_resource_kind = COALESCE(
              external_resource_kind, ${externalResourceKind}
            ),
            external_lookup_metadata = ${tx.json(
              lookupMetadata as postgres.JSONValue,
            )}
          WHERE id = ${receipt.id}
        `;
        await this.upsertPendingCompensation(
          tx,
          receipt,
          externalResourceKind,
          receipt.external_resource_ref,
          lookupMetadata,
          input.error,
          receipt.orchestration_phase !== 'reconciling',
        );
        return;
      }
      const phase = input.retryable ? 'retryable_failure' : 'terminal_failure';
      await tx`
        UPDATE command_receipts
        SET orchestration_phase = ${phase}, last_error = ${input.error},
          completed_at = CASE WHEN ${input.retryable} THEN NULL ELSE now() END
        WHERE id = ${receipt.id}
      `;
    });
  }

  async markRuntimeCommandReconciling(
    input: RuntimeCommandReconcileInput,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      const receipt = await this.authorizeReceipt(
        tx,
        input.actor,
        input.commandReceiptId,
      );
      if (
        receipt.orchestration_phase === 'attached'
        || receipt.orchestration_phase === 'terminal_failure'
      ) {
        return;
      }
      if (receipt.result_type !== input.externalResourceKind) {
        throw new Error('Runtime resource kind conflicts with the Canvas result');
      }
      if (
        receipt.external_resource_kind !== null
        && receipt.external_resource_kind !== input.externalResourceKind
      ) {
        throw new Error('Runtime resource kind conflicts with the recorded resource');
      }
      if (
        receipt.external_resource_ref !== null
        && input.externalResourceRef !== undefined
        && receipt.external_resource_ref !== input.externalResourceRef
      ) {
        throw new Error('Runtime resource reference conflicts with the recorded resource');
      }
      const externalResourceRef = receipt.external_resource_ref
        ?? input.externalResourceRef
        ?? null;
      const lookupMetadata = {
        ...receipt.external_lookup_metadata,
        ...this.compensationMetadata(receipt, input.lookupMetadata),
      };
      await tx`
        UPDATE command_receipts
        SET orchestration_phase = 'reconciling',
          external_resource_kind = ${input.externalResourceKind},
          external_resource_ref = ${externalResourceRef},
          external_lookup_metadata = ${tx.json(
            lookupMetadata as postgres.JSONValue,
          )},
          last_error = ${input.error}, completed_at = NULL
        WHERE id = ${receipt.id}
      `;
      await this.upsertPendingCompensation(
        tx,
        receipt,
        input.externalResourceKind,
        externalResourceRef,
        lookupMetadata,
        input.error,
        receipt.orchestration_phase !== 'reconciling',
      );
    });
  }

  async resolveRuntimeReconciliation(
    input: ResolveRuntimeReconciliationInput,
  ): Promise<RuntimeReconciliationResult> {
    return this.sql.begin(async (tx) => {
      const receipt = await this.authorizeReceipt(
        tx,
        input.actor,
        input.commandReceiptId,
      );
      if (receipt.orchestration_phase === 'attached') {
        if (input.resolution.kind !== 'adopt-session') {
          throw new Error('An attached Runtime resource cannot be resolved as absent');
        }
        return { phase: 'attached', outcome: 'adopted' };
      }
      const [compensation] = await tx<CompensationRow[]>`
        SELECT id, status, attempts, external_resource_ref,
          resolution_evidence, last_error
        FROM runtime_compensations
        WHERE command_receipt_id = ${receipt.id}
          AND external_resource_kind = ${receipt.result_type}
          AND action = 'adopt'
        ORDER BY (status = 'succeeded') ASC, created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE
      `;
      if (
        input.resolution.kind === 'absent'
        && receipt.orchestration_phase === 'retryable_failure'
        && compensation?.status === 'succeeded'
      ) {
        return { phase: 'retryable_failure', outcome: 'absent' };
      }
      if (receipt.orchestration_phase !== 'reconciling') {
        throw new Error(
          `Runtime reconciliation cannot resolve from ${receipt.orchestration_phase}`,
        );
      }
      if (!compensation) {
        throw new Error('Runtime reconciliation has no durable compensation record');
      }
      if (input.resolution.kind === 'adopt-session') {
        await this.attachRuntimeSessionInTransaction(
          tx,
          receipt,
          input.resolution.runtimeSession,
          Object.keys(input.resolution.evidence).length > 0
            ? input.resolution.evidence
            : { outcome: 'adopted' },
        );
        return { phase: 'attached', outcome: 'adopted' };
      }
      if (input.resolution.kind === 'absent') {
        if (receipt.external_resource_ref !== null) {
          throw new Error('A known external resource cannot be resolved as absent');
        }
        const evidence = Object.keys(input.resolution.evidence).length > 0
          ? input.resolution.evidence
          : { outcome: 'absent' };
        await tx`
          UPDATE runtime_compensations
          SET status = 'succeeded', attempts = attempts + 1, last_error = NULL,
            resolution_evidence = ${tx.json(evidence as postgres.JSONValue)},
            resolved_at = now(), updated_at = now()
          WHERE id = ${compensation.id}
        `;
        await tx`
          UPDATE command_receipts
          SET orchestration_phase = 'retryable_failure', last_error = NULL,
            completed_at = NULL
          WHERE id = ${receipt.id}
        `;
        return { phase: 'retryable_failure', outcome: 'absent' };
      }
      await tx`
        UPDATE runtime_compensations
        SET status = 'pending', attempts = attempts + 1,
          last_error = ${input.resolution.error},
          resolution_evidence = ${tx.json(
            input.resolution.evidence as postgres.JSONValue,
          )},
          resolved_at = NULL, updated_at = now()
        WHERE id = ${compensation.id}
          AND (
            resolution_evidence IS DISTINCT FROM ${tx.json(
              input.resolution.evidence as postgres.JSONValue,
            )}
            OR last_error IS DISTINCT FROM ${input.resolution.error}
          )
      `;
      await tx`
        UPDATE command_receipts
        SET last_error = ${input.resolution.error}
        WHERE id = ${receipt.id}
      `;
      return { phase: 'reconciling', outcome: 'unresolved' };
    });
  }

  async getSessionRuntimeContext(input: {
    actor: ActorContext;
    sessionId: string;
  }): Promise<SessionRuntimeContext> {
    return this.sql.begin(async (tx) => {
      await this.authorizeSession(tx, input.actor, input.sessionId);
      const [row] = await tx<{
        workflow_id: string;
        status: string;
        agent_binding_id: string;
        agent_id: string;
        runtime_kind: string;
        isolation_key: string;
        endpoint_ref: string | null;
        secret_ref: string | null;
        external_session_ref: string | null;
        runtime_metadata: Record<string, unknown> | null;
      }[]>`
        SELECT session.workflow_id, session.status::text AS status,
          binding.id AS agent_binding_id, binding.agent_id,
          binding.runtime_kind::text AS runtime_kind, binding.isolation_key,
          binding.endpoint_ref, binding.secret_ref,
          runtime_ref.external_session_ref,
          runtime_ref.metadata AS runtime_metadata
        FROM sessions session
        JOIN agent_bindings binding ON binding.id = session.agent_binding_id
        LEFT JOIN session_runtime_refs runtime_ref
          ON runtime_ref.session_id = session.id
         AND runtime_ref.is_primary = true
         AND runtime_ref.status = 'active'
        WHERE session.id = ${input.sessionId}
      `;
      if (!row) throw new AuthorizationError();
      const contextRows = await tx<{
        id: string;
        scope: string;
        visibility: string;
        source_kind: string;
        source_ref: string;
        snapshot: unknown;
        provenance: Record<string, unknown>;
      }[]>`
        SELECT id, scope::text AS scope, visibility::text AS visibility,
          source_kind, source_ref, snapshot, provenance
        FROM context_refs
        WHERE (expires_at IS NULL OR expires_at > now())
          AND (
            (visibility = 'private' AND account_id = ${input.actor.accountId})
            OR visibility = 'workspace'
          )
          AND (
            (scope = 'account' AND account_id = ${input.actor.accountId})
            OR (scope = 'agent' AND agent_id = ${row.agent_id})
            OR (scope = 'workflow' AND workflow_id = ${row.workflow_id})
            OR (scope = 'session' AND session_id = ${input.sessionId})
          )
        ORDER BY created_at, id
      `;
      const historyDigest = row.runtime_metadata?.historyDigest;
      return {
        sessionId: input.sessionId,
        workflowId: row.workflow_id,
        status: row.status,
        binding: {
          agentBindingId: row.agent_binding_id,
          agentId: row.agent_id,
          runtimeKind: row.runtime_kind,
          isolationKey: row.isolation_key,
          endpointRef: row.endpoint_ref,
          secretRef: row.secret_ref,
        },
        externalSessionRef: row.external_session_ref,
        expectedHistoryDigest: typeof historyDigest === 'string' ? historyDigest : null,
        config: await this.loadConfig(tx, input.sessionId),
        context: contextRows.map((context) => ({
          id: context.id,
          scope: context.scope,
          visibility: context.visibility,
          sourceKind: context.source_kind,
          sourceRef: context.source_ref,
          snapshot: context.snapshot,
          provenance: context.provenance,
        })),
      };
    });
  }

  async hydrateWorkflow(input: {
    actor: ActorContext;
    workflowId: string;
  }): Promise<HydratedWorkflow> {
    return this.sql.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
      await this.authorizeWorkflowMembership(tx, input.actor, input.workflowId);
      await this.hooks.afterHydrateSnapshotEstablished?.();
      const [workflow] = await tx<{
        id: string;
        workspace_id: string;
        title: string;
        status: string;
        current_trunk_revision_id: string | null;
      }[]>`
        SELECT id, workspace_id, title, status::text AS status, current_trunk_revision_id
        FROM workflows WHERE id = ${input.workflowId}
      `;
      if (!workflow) throw new AuthorizationError();
      const [trunk] = workflow.current_trunk_revision_id
        ? await tx<{
            id: string;
            revision_number: number;
            content: unknown;
            content_hash: string;
          }[]>`
            SELECT id, revision_number, content, content_hash
            FROM trunk_revisions WHERE id = ${workflow.current_trunk_revision_id}
          `
        : [];
      const anchors = await tx<{
        id: string;
        source_kind: string;
        context_trunk_revision_id: string;
        source_trunk_revision_id: string | null;
        source_message_id: string | null;
        selector: unknown;
        quote: string | null;
      }[]>`
        SELECT id, source_kind, context_trunk_revision_id, source_trunk_revision_id,
          source_message_id, selector, quote
        FROM branch_anchors
        WHERE workflow_id = ${input.workflowId}
        ORDER BY created_at, id
      `;
      const edges = await tx<{
        id: string;
        source_session_node_id: string | null;
        target_session_node_id: string;
        kind: string;
        anchor_id: string | null;
        metadata: Record<string, unknown>;
      }[]>`
        SELECT id, source_session_node_id, target_session_node_id,
          kind::text AS kind, anchor_id, metadata
        FROM session_edges
        WHERE workflow_id = ${input.workflowId}
        ORDER BY created_at, id
      `;
      const sessionRows = await tx<{
        session_id: string;
        workflow_id: string;
        agent_binding_id: string;
        parent_session_id: string | null;
        fork_anchor_id: string | null;
        status: string;
        transcript_version: number;
        node_id: string;
        node_title: string;
        node_kind: string;
        growth_state: string;
      }[]>`
        SELECT session.id AS session_id, session.workflow_id, session.agent_binding_id,
          session.parent_session_id, session.fork_anchor_id,
          session.status::text AS status, session.transcript_version,
          node.id AS node_id, node.title AS node_title, node.node_kind,
          node.growth_state::text AS growth_state
        FROM sessions session
        JOIN session_nodes node ON node.session_id = session.id
        JOIN agent_bindings binding
          ON binding.id = session.agent_binding_id
         AND binding.status IN ('ready', 'degraded')
        JOIN agents agent ON agent.id = binding.agent_id AND agent.status = 'active'
        WHERE session.workflow_id = ${input.workflowId}
          AND (
            agent.owner_account_id = ${input.actor.accountId}
            OR EXISTS (
              SELECT 1 FROM agent_access_grants access_grant
              WHERE access_grant.agent_id = agent.id
                AND access_grant.account_id = ${input.actor.accountId}
                AND access_grant.revoked_at IS NULL
            )
          )
        ORDER BY session.created_at, session.id
      `;
      const blocks: HydratedWorkflow['blocks'] = [];
      for (const session of sessionRows) {
        const config = await this.loadConfig(tx, session.session_id);
        const messageRows = await this.loadTranscriptProjection(tx, session.session_id);
        const [activeRun] = await tx<{
          id: string;
          status: string;
          last_sequence: number;
        }[]>`
          SELECT run.id, run.status::text AS status,
            COALESCE(MAX(event.sequence), 0)::integer AS last_sequence
          FROM runs run
          LEFT JOIN run_events event ON event.run_id = run.id
          WHERE run.session_id = ${session.session_id}
            AND run.status IN ('queued', 'running', 'waiting_approval', 'reconciling')
          GROUP BY run.id, run.status
          ORDER BY run.created_at DESC, run.id
          LIMIT 1
        `;
        blocks.push({
          session: {
            id: session.session_id,
            workflowId: session.workflow_id,
            agentBindingId: session.agent_binding_id,
            parentSessionId: session.parent_session_id,
            forkAnchorId: session.fork_anchor_id,
            status: session.status,
            transcriptVersion: session.transcript_version,
          },
          node: {
            id: session.node_id,
            title: session.node_title,
            nodeKind: session.node_kind,
            growthState: session.growth_state,
          },
          currentConfig: config,
          messages: messageRows,
          activeRun: activeRun
            ? {
                id: activeRun.id,
                status: activeRun.status,
                lastSequence: activeRun.last_sequence,
              }
            : null,
        });
      }
      const visibleNodeIds = new Set(sessionRows.map((session) => session.node_id));
      const visibleEdges = edges.filter(
        (edge) => visibleNodeIds.has(edge.target_session_node_id)
          && (
            edge.source_session_node_id === null
            || visibleNodeIds.has(edge.source_session_node_id)
          ),
      );
      const visibleAnchorIds = new Set(
        [
          ...sessionRows.map((session) => session.fork_anchor_id),
          ...visibleEdges.map((edge) => edge.anchor_id),
        ].filter((id): id is string => id !== null),
      );
      return {
        workflow: {
          id: workflow.id,
          workspaceId: workflow.workspace_id,
          title: workflow.title,
          status: workflow.status,
          currentTrunkRevisionId: workflow.current_trunk_revision_id,
        },
        trunk: trunk
          ? {
              id: trunk.id,
              revisionNumber: trunk.revision_number,
              content: trunk.content,
              contentHash: trunk.content_hash,
            }
          : null,
        anchors: anchors.filter((anchor) => visibleAnchorIds.has(anchor.id)).map((anchor) => ({
          id: anchor.id,
          sourceKind: anchor.source_kind,
          contextTrunkRevisionId: anchor.context_trunk_revision_id,
          sourceTrunkRevisionId: anchor.source_trunk_revision_id,
          sourceMessageId: anchor.source_message_id,
          selector: anchor.selector,
          quote: anchor.quote,
        })),
        edges: visibleEdges.map((edge) => ({
          id: edge.id,
          sourceSessionNodeId: edge.source_session_node_id,
          targetSessionNodeId: edge.target_session_node_id,
          kind: edge.kind,
          anchorId: edge.anchor_id,
          metadata: edge.metadata,
        })),
        blocks,
      };
    });
  }

  async resolveActorContext(input: { authSubject: string }): Promise<ActorContext | null> {
    const [account] = await this.sql<{ id: string; auth_subject: string }[]>`
      SELECT id, auth_subject FROM accounts WHERE auth_subject = ${input.authSubject}
    `;
    return account ? { accountId: account.id, authSubject: account.auth_subject } : null;
  }

  async resetTestData(): Promise<void> {
    assertResetAllowed(this.databaseUrl);
    await this.sql.unsafe(`
      TRUNCATE TABLE
        domain_events, runtime_compensations, run_events, command_receipts,
        bootstrap_receipts, context_refs, tool_approval_decisions, tool_grants,
        runs, messages, session_config_revisions, session_edges, session_nodes,
        session_runtime_refs, sessions, branch_anchors, trunk_revisions, workflows,
        workspace_members, workspaces, model_catalog_entries, agent_bindings,
        agent_access_grants, agents, accounts
      RESTART IDENTITY CASCADE
    `);
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

export function createPostgresControlPlaneRepository(
  databaseUrl: string,
  hooks: PostgresControlPlaneRepositoryHooks = {},
): PostgresControlPlaneRepository {
  return new PostgresControlPlaneRepository(databaseUrl, hooks);
}
