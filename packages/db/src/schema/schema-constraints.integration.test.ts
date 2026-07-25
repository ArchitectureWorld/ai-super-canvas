import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assertDisposableTestDatabase } from '../testing/disposable-test-database';

const databaseUrl = process.env.DATABASE_URL;
const appDatabaseUrl = process.env.APP_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for schema integration tests');
}
if (!appDatabaseUrl) {
  throw new Error('APP_DATABASE_URL is required for schema integration tests');
}

assertDisposableTestDatabase(databaseUrl);
assertDisposableTestDatabase(appDatabaseUrl);

const sql = postgres(databaseUrl, { max: 10 });
const appSql = postgres(appDatabaseUrl, { max: 2 });
const appDatabaseRole = decodeURIComponent(new URL(appDatabaseUrl).username);

if (appDatabaseRole !== 'canvas_s1_app') {
  throw new Error('APP_DATABASE_URL must use the isolated canvas_s1_app role');
}

const tableNames = [
  'accounts',
  'agent_access_grants',
  'agent_bindings',
  'agents',
  'bootstrap_receipts',
  'branch_anchors',
  'command_receipts',
  'context_refs',
  'domain_events',
  'messages',
  'model_catalog_entries',
  'run_events',
  'runs',
  'runtime_compensations',
  'session_config_revisions',
  'session_edges',
  'session_nodes',
  'session_runtime_refs',
  'sessions',
  'tool_approval_decisions',
  'tool_grants',
  'trunk_revisions',
  'workflows',
  'workspace_members',
  'workspaces',
] as const;

const enumNames = [
  'binding_status',
  'context_scope',
  'context_visibility',
  'growth_state',
  'message_role',
  'run_status',
  'runtime_kind',
  'session_edge_kind',
  'session_status',
  'tool_grant_effect',
  'tool_grant_scope',
  'workflow_status',
] as const;

const invariantFunctionNames = [
  'assert_account_default_agent',
  'validate_account_default_agent_trigger',
  'validate_grant_default_agent_trigger',
  'validate_agent_owner_default_agent_trigger',
  'assert_session_authorized',
  'validate_session_authorization_trigger',
  'assert_workflow_derives_acyclic',
  'assert_session_lineage',
  'validate_session_edge_lineage_trigger',
  'validate_session_lineage_trigger',
  'validate_branch_anchor_lineage_trigger',
  'validate_message_lineage_trigger',
  'validate_session_node_lineage_trigger',
  'validate_command_receipt_update',
  'validate_bootstrap_receipt_update',
  'assert_runtime_compensation_hierarchy',
  'validate_runtime_compensation_hierarchy_trigger',
  'validate_session_compensation_hierarchy_trigger',
  'validate_run_compensation_hierarchy_trigger',
  'protect_domain_events',
  'mark_domain_event_published',
  'validate_runtime_compensation_update',
] as const;

type Seed = {
  accountId: string;
  agentBindingId: string;
  agentId: string;
  trunkRevisionId: string;
  workflowId: string;
  workspaceId: string;
};

async function seedControlPlane(): Promise<Seed> {
  const accountId = randomUUID();
  const agentId = randomUUID();
  const agentBindingId = randomUUID();
  const workspaceId = randomUUID();
  const workflowId = randomUUID();
  const trunkRevisionId = randomUUID();

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO accounts (id, auth_subject, display_name)
      VALUES (${accountId}, ${`auth:${accountId}`}, 'Owner')
    `;
    await tx`
      INSERT INTO agents (id, owner_account_id, name, status)
      VALUES (${agentId}, ${accountId}, 'Owner Agent', 'active')
    `;
    await tx`
      INSERT INTO agent_bindings (
        id, agent_id, runtime_kind, isolation_key, status, is_primary
      ) VALUES (
        ${agentBindingId}, ${agentId}, 'fake', ${`isolation:${agentBindingId}`}, 'ready', true
      )
    `;
    await tx`
      INSERT INTO workspaces (id, owner_account_id, name)
      VALUES (${workspaceId}, ${accountId}, 'Workspace')
    `;
    await tx`
      INSERT INTO workspace_members (workspace_id, account_id, role)
      VALUES (${workspaceId}, ${accountId}, 'owner')
    `;
    await tx`
      INSERT INTO workflows (
        id, workspace_id, title, status, created_by_account_id
      ) VALUES (${workflowId}, ${workspaceId}, 'Workflow', 'active', ${accountId})
    `;
    await tx`
      INSERT INTO trunk_revisions (
        id, workflow_id, revision_number, content, content_hash, created_by_account_id
      ) VALUES (
        ${trunkRevisionId}, ${workflowId}, 1, '{}'::jsonb, 'trunk-1', ${accountId}
      )
    `;
    await tx`
      UPDATE workflows
      SET current_trunk_revision_id = ${trunkRevisionId}
      WHERE id = ${workflowId}
    `;
  });

  return {
    accountId,
    agentBindingId,
    agentId,
    trunkRevisionId,
    workflowId,
    workspaceId,
  };
}

async function createSession(seed: Seed, sessionId = randomUUID()): Promise<string> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO sessions (
        id, workflow_id, agent_binding_id, status, created_by_account_id
      ) VALUES (
        ${sessionId}, ${seed.workflowId}, ${seed.agentBindingId}, 'active', ${seed.accountId}
      )
    `;
    await tx`
      INSERT INTO session_nodes (
        id, workflow_id, session_id, title, node_kind, growth_state
      ) VALUES (
        ${randomUUID()}, ${seed.workflowId}, ${sessionId}, 'Node', 'mainline', 'active'
      )
    `;
  });
  return sessionId;
}

async function getSessionNodeId(sessionId: string): Promise<string> {
  const [node] = await sql<{ id: string }[]>`
    SELECT id FROM session_nodes WHERE session_id = ${sessionId}
  `;
  if (!node) throw new Error(`SessionNode fixture missing for ${sessionId}`);
  return node.id;
}

async function createRun(seed: Seed, sessionId: string): Promise<string> {
  const configRevisionId = randomUUID();
  const triggerMessageId = randomUUID();
  const runId = randomUUID();
  const runtimeSessionRefId = randomUUID();
  const runtimeSessionExternalRef = `runtime-session:${runId}`;
  const expectedHistoryDigest = `history:${runId}`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO session_config_revisions (
        id, session_id, version, created_by_account_id
      ) VALUES (${configRevisionId}, ${sessionId}, 1, ${seed.accountId})
    `;
    await tx`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${triggerMessageId}, ${seed.workflowId}, ${sessionId}, 0, 'user',
        ${seed.accountId}, '{}'::jsonb, 'completed'
      )
    `;
    await tx`
      INSERT INTO session_runtime_refs (
        id, session_id, agent_binding_id, external_session_ref,
        runtime_version, is_primary, status, metadata
      ) VALUES (
        ${runtimeSessionRefId}, ${sessionId}, ${seed.agentBindingId},
        ${runtimeSessionExternalRef}, 'test-runtime-v1', true, 'active',
        ${tx.json({ historyDigest: expectedHistoryDigest })}
      )
    `;
    await tx`
      INSERT INTO runs (
        id, session_id, agent_binding_id, config_revision_id, trigger_message_id,
        idempotency_key, status, model_snapshot, tool_policy_snapshot,
        context_policy_snapshot, runtime_session_ref_id,
        runtime_session_external_ref, expected_history_digest,
        runtime_binding_snapshot
      ) VALUES (
        ${runId}, ${sessionId}, ${seed.agentBindingId}, ${configRevisionId},
        ${triggerMessageId}, ${`run:${runId}`}, 'queued',
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${runtimeSessionRefId}, ${runtimeSessionExternalRef},
        ${expectedHistoryDigest}, ${tx.json({
          canvasAgentBindingId: seed.agentBindingId,
          agentId: seed.agentId,
          runtimeKind: 'fake',
          isolationKey: `isolation:${seed.agentBindingId}`,
        })}
      )
    `;
  });
  return runId;
}

async function createMessageAnchor(
  seed: Seed,
  sessionId: string,
  ordinal: number,
): Promise<{ anchorId: string; messageId: string }> {
  const messageId = randomUUID();
  const anchorId = randomUUID();

  await sql`
    INSERT INTO messages (
      id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
    ) VALUES (
      ${messageId}, ${seed.workflowId}, ${sessionId}, ${ordinal}, 'user',
      ${seed.accountId}, '{"text":"fork"}'::jsonb, 'completed'
    )
  `;
  await sql`
    INSERT INTO branch_anchors (
      id, workflow_id, source_kind, context_trunk_revision_id,
      source_message_id, selector, quote, created_by_account_id
    ) VALUES (
      ${anchorId}, ${seed.workflowId}, 'message', ${seed.trunkRevisionId},
      ${messageId}, '{"type":"text-quote"}'::jsonb, 'fork', ${seed.accountId}
    )
  `;

  return { anchorId, messageId };
}

beforeAll(async () => {
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO "${appDatabaseRole}"`);
  await sql.unsafe(
    `GRANT SELECT, UPDATE, DELETE ON TABLE public.domain_events TO "${appDatabaseRole}"`,
  );
  await sql.unsafe(
    `GRANT EXECUTE ON FUNCTION public.mark_domain_event_published(uuid, timestamptz) TO "${appDatabaseRole}"`,
  );
});

beforeEach(async () => {
  await sql.unsafe(
    `TRUNCATE TABLE ${tableNames.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await Promise.all([appSql.end(), sql.end()]);
});

describe('S1 PostgreSQL schema invariants', () => {
  it('installs the complete table and enum catalog', async () => {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(${tableNames as readonly string[]})
      ORDER BY table_name
    `;
    const enums = await sql<{ typname: string }[]>`
      SELECT typname
      FROM pg_type
      WHERE typtype = 'e'
        AND typname = ANY(${enumNames as readonly string[]})
      ORDER BY typname
    `;

    expect(tables.map(({ table_name }) => table_name)).toEqual([...tableNames]);
    expect(enums.map(({ typname }) => typname)).toEqual([...enumNames]);
  });

  it('enforces composite foreign keys and partial uniqueness', async () => {
    const first = await seedControlPlane();
    const second = await seedControlPlane();
    const sessionId = await createSession(first);

    await expect(
      sql`
        INSERT INTO session_nodes (
          id, workflow_id, session_id, title, node_kind, growth_state
        ) VALUES (
          ${randomUUID()}, ${second.workflowId}, ${sessionId}, 'Cross-workflow', 'branch', 'active'
        )
      `,
    ).rejects.toThrow();

    await expect(
      sql`
        INSERT INTO tool_grants (
          id, account_id, scope, workflow_id, session_id, tool_key, effect,
          issued_by_account_id
        ) VALUES (
          ${randomUUID()}, ${first.accountId}, 'session', ${second.workflowId},
          ${sessionId}, 'filesystem.read', 'allow', ${first.accountId}
        )
      `,
    ).rejects.toThrow();
    await expect(
      sql`
        INSERT INTO context_refs (
          id, account_id, workflow_id, session_id, scope, visibility,
          source_kind, source_ref, provenance
        ) VALUES (
          ${randomUUID()}, ${first.accountId}, ${second.workflowId}, ${sessionId},
          'session', 'workspace', 'test', 'cross-workflow', '{}'::jsonb
        )
      `,
    ).rejects.toThrow();

    await sql`
      INSERT INTO session_runtime_refs (
        id, session_id, agent_binding_id, external_session_ref, runtime_version,
        is_primary, status
      ) VALUES (
        ${randomUUID()}, ${sessionId}, ${first.agentBindingId}, 'runtime-session-1',
        'fake-runtime-1', true, 'active'
      )
    `;
    await expect(
      sql`
        INSERT INTO session_runtime_refs (
          id, session_id, agent_binding_id, external_session_ref, runtime_version,
          is_primary, status
        ) VALUES (
          ${randomUUID()}, ${sessionId}, ${first.agentBindingId}, 'runtime-session-2',
          'fake-runtime-1', true, 'active'
        )
      `,
    ).rejects.toThrow();
  });

  it('defers Workflow current-trunk validation until commit', async () => {
    const first = await seedControlPlane();
    const second = await seedControlPlane();

    await expect(
      sql.begin(async (tx) => {
        await tx`
          UPDATE workflows
          SET current_trunk_revision_id = ${second.trunkRevisionId}
          WHERE id = ${first.workflowId}
        `;
      }),
    ).rejects.toThrow();
  });

  it('requires an owned or actively granted default Agent at commit', async () => {
    const owner = await seedControlPlane();
    const consumerId = randomUUID();
    const grantId = randomUUID();

    await sql`
      INSERT INTO accounts (id, auth_subject, display_name)
      VALUES (${consumerId}, ${`auth:${consumerId}`}, 'Consumer')
    `;
    await sql`
      INSERT INTO agent_access_grants (
        id, agent_id, account_id, role, granted_by_account_id
      ) VALUES (${grantId}, ${owner.agentId}, ${consumerId}, 'use', ${owner.accountId})
    `;
    await sql`
      UPDATE accounts SET default_agent_id = ${owner.agentId} WHERE id = ${consumerId}
    `;

    await expect(
      sql.begin(async (tx) => {
        await tx`
          UPDATE agent_access_grants SET revoked_at = now() WHERE id = ${grantId}
        `;
      }),
    ).rejects.toThrow();

    await sql.begin(async (tx) => {
      await tx`UPDATE accounts SET default_agent_id = NULL WHERE id = ${consumerId}`;
      await tx`UPDATE agent_access_grants SET revoked_at = now() WHERE id = ${grantId}`;
    });
  });

  it('serializes concurrent default-Agent grant and ownership removal', async () => {
    const owner = await seedControlPlane();
    const replacementOwnerId = randomUUID();
    const grantId = randomUUID();
    await sql`
      INSERT INTO accounts (id, auth_subject, display_name)
      VALUES (${replacementOwnerId}, ${`auth:${replacementOwnerId}`}, 'Replacement Owner')
    `;
    await sql`
      INSERT INTO agent_access_grants (
        id, agent_id, account_id, role, granted_by_account_id
      ) VALUES (${grantId}, ${owner.agentId}, ${owner.accountId}, 'admin', ${owner.accountId})
    `;
    await sql`
      UPDATE accounts SET default_agent_id = ${owner.agentId} WHERE id = ${owner.accountId}
    `;

    const firstClient = postgres(databaseUrl, { max: 1 });
    const secondClient = postgres(databaseUrl, { max: 1 });
    let ready = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const synchronize = async (): Promise<void> => {
      ready += 1;
      if (ready === 2) release();
      await barrier;
    };

    try {
      const results = await Promise.allSettled([
        firstClient.begin(async (tx) => {
          await tx`UPDATE agent_access_grants SET revoked_at = now() WHERE id = ${grantId}`;
          await synchronize();
        }),
        secondClient.begin(async (tx) => {
          await tx`
            UPDATE agents SET owner_account_id = ${replacementOwnerId} WHERE id = ${owner.agentId}
          `;
          await synchronize();
        }),
      ]);

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      const [state] = await sql<{
        active_grant: boolean;
        owner_account_id: string;
      }[]>`
        SELECT agent.owner_account_id,
          EXISTS (
            SELECT 1
            FROM agent_access_grants grant_row
            WHERE grant_row.id = ${grantId}
              AND grant_row.revoked_at IS NULL
          ) AS active_grant
        FROM agents agent
        WHERE agent.id = ${owner.agentId}
      `;
      expect(state?.owner_account_id === owner.accountId || state?.active_grant).toBe(true);
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
    }
  });

  it('pins every invariant function to the hardened search path', async () => {
    const functions = await sql<{ proname: string; search_path: string | null }[]>`
      SELECT procedure.proname,
        (
          SELECT setting
          FROM unnest(procedure.proconfig) setting
          WHERE setting LIKE 'search_path=%'
        ) AS search_path
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname = ANY(${invariantFunctionNames as readonly string[]})
      ORDER BY procedure.proname
    `;

    expect(functions).toHaveLength(invariantFunctionNames.length);
    expect(new Set(functions.map(({ search_path }) => search_path))).toEqual(
      new Set(['search_path=pg_catalog, public, pg_temp']),
    );
  });

  it('cannot bypass default-Agent validation with a TEMP accounts shadow', async () => {
    const owner = await seedControlPlane();
    const replacementOwnerId = randomUUID();
    const grantId = randomUUID();
    await sql`
      INSERT INTO accounts (id, auth_subject, display_name)
      VALUES (${replacementOwnerId}, ${`auth:${replacementOwnerId}`}, 'Replacement Owner')
    `;
    await sql`
      INSERT INTO agent_access_grants (
        id, agent_id, account_id, role, granted_by_account_id
      ) VALUES (${grantId}, ${owner.agentId}, ${owner.accountId}, 'admin', ${owner.accountId})
    `;
    await sql`
      UPDATE accounts SET default_agent_id = ${owner.agentId} WHERE id = ${owner.accountId}
    `;

    const shadowClient = postgres(databaseUrl, { max: 1 });
    try {
      await expect(
        shadowClient.begin(async (tx) => {
          await tx`CREATE TEMP TABLE accounts (id uuid, default_agent_id uuid) ON COMMIT DROP`;
          await tx`
            INSERT INTO accounts (id, default_agent_id) VALUES (${owner.accountId}, NULL)
          `;
          await tx`UPDATE public.agent_access_grants SET revoked_at = now() WHERE id = ${grantId}`;
          await tx`
            UPDATE public.agents
            SET owner_account_id = ${replacementOwnerId}
            WHERE id = ${owner.agentId}
          `;
        }),
      ).rejects.toThrow();
    } finally {
      await shadowClient.end();
    }
  });

  it('authorizes Session creation through Workspace membership and Agent grants', async () => {
    const owner = await seedControlPlane();
    const runnerId = randomUUID();

    await sql`
      INSERT INTO accounts (id, auth_subject, display_name)
      VALUES (${runnerId}, ${`auth:${runnerId}`}, 'Runner')
    `;

    await expect(
      sql.begin(async (tx) => {
        await tx`
          INSERT INTO sessions (
            id, workflow_id, agent_binding_id, status, created_by_account_id
          ) VALUES (
            ${randomUUID()}, ${owner.workflowId}, ${owner.agentBindingId}, 'active', ${runnerId}
          )
        `;
        await tx`
          INSERT INTO session_nodes (
            id, workflow_id, session_id, title, node_kind, growth_state
          )
          SELECT ${randomUUID()}, ${owner.workflowId}, id, 'Runner Node', 'mainline', 'active'
          FROM sessions
          WHERE created_by_account_id = ${runnerId}
          ORDER BY created_at DESC
          LIMIT 1
        `;
      }),
    ).rejects.toThrow();

    await sql`
      INSERT INTO workspace_members (workspace_id, account_id, role)
      VALUES (${owner.workspaceId}, ${runnerId}, 'runner')
    `;
    await sql`
      INSERT INTO agent_access_grants (
        id, agent_id, account_id, role, granted_by_account_id
      ) VALUES (${randomUUID()}, ${owner.agentId}, ${runnerId}, 'use', ${owner.accountId})
    `;
    await sql.begin(async (tx) => {
      const sessionId = randomUUID();
      await tx`
        INSERT INTO sessions (
          id, workflow_id, agent_binding_id, status, created_by_account_id
        ) VALUES (
          ${sessionId}, ${owner.workflowId}, ${owner.agentBindingId}, 'active', ${runnerId}
        )
      `;
      await tx`
        INSERT INTO session_nodes (
          id, workflow_id, session_id, title, node_kind, growth_state
        ) VALUES (
          ${randomUUID()}, ${owner.workflowId}, ${sessionId}, 'Runner Node', 'mainline', 'active'
        )
      `;
    });
  });

  it('requires Workspace membership for Session creation even when the creator owns it', async () => {
    const owner = await seedControlPlane();

    await sql`
      DELETE FROM workspace_members
      WHERE workspace_id = ${owner.workspaceId}
        AND account_id = ${owner.accountId}
    `;

    await expect(
      sql.begin(async (tx) => {
        await tx`
          INSERT INTO sessions (
            id, workflow_id, agent_binding_id, status, created_by_account_id
          ) VALUES (
            ${randomUUID()}, ${owner.workflowId}, ${owner.agentBindingId},
            'active', ${owner.accountId}
          )
        `;
        await tx`
          INSERT INTO session_nodes (
            id, workflow_id, session_id, title, node_kind, growth_state
          )
          SELECT ${randomUUID()}, ${owner.workflowId}, id, 'Owner Node', 'mainline', 'active'
          FROM sessions
          WHERE workflow_id = ${owner.workflowId}
          ORDER BY created_at DESC
          LIMIT 1
        `;
      }),
    ).rejects.toThrow();

    await sql`
      INSERT INTO workspace_members (workspace_id, account_id, role)
      VALUES (${owner.workspaceId}, ${owner.accountId}, 'owner')
    `;
    await sql.begin(async (tx) => {
      const sessionId = randomUUID();
      await tx`
        INSERT INTO sessions (
          id, workflow_id, agent_binding_id, status, created_by_account_id
        ) VALUES (
          ${sessionId}, ${owner.workflowId}, ${owner.agentBindingId},
          'active', ${owner.accountId}
        )
      `;
      await tx`
        INSERT INTO session_nodes (
          id, workflow_id, session_id, title, node_kind, growth_state
        ) VALUES (
          ${randomUUID()}, ${owner.workflowId}, ${sessionId}, 'Owner Node', 'mainline', 'active'
        )
      `;
    });
  });

  it('rejects a Session inserted without its SessionNode at commit', async () => {
    const seed = await seedControlPlane();
    await expect(
      sql.begin(async (tx) => {
        await tx`
          INSERT INTO sessions (
            id, workflow_id, agent_binding_id, status, created_by_account_id
          ) VALUES (
            ${randomUUID()}, ${seed.workflowId}, ${seed.agentBindingId}, 'active', ${seed.accountId}
          )
        `;
      }),
    ).rejects.toThrow();
  });

  it('rejects deleting the only SessionNode while its Session remains', async () => {
    const seed = await seedControlPlane();
    const sessionId = await createSession(seed);
    await expect(
      sql.begin(async (tx) => {
        await tx`DELETE FROM session_nodes WHERE session_id = ${sessionId}`;
      }),
    ).rejects.toThrow();
  });

  it('rejects rebinding the only SessionNode away from its Session', async () => {
    const seed = await seedControlPlane();
    const firstSessionId = await createSession(seed);
    const secondSessionId = await createSession(seed);
    const firstNodeId = await getSessionNodeId(firstSessionId);
    await expect(
      sql.begin(async (tx) => {
        await tx`DELETE FROM session_nodes WHERE session_id = ${secondSessionId}`;
        await tx`
          UPDATE session_nodes SET session_id = ${secondSessionId} WHERE id = ${firstNodeId}
        `;
      }),
    ).rejects.toThrow();
  });

  it('allows Session deletion to cascade through its SessionNode', async () => {
    const seed = await seedControlPlane();
    const sessionId = await createSession(seed);
    await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
    const [remaining] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM session_nodes WHERE session_id = ${sessionId}
    `;
    expect(remaining?.count).toBe(0);
  });

  it('rejects inconsistent derives lineage at commit', async () => {
    const seed = await seedControlPlane();
    const parentSessionId = await createSession(seed);
    const otherSessionId = await createSession(seed);
    const childSessionId = randomUUID();
    const parentNodeId = await getSessionNodeId(parentSessionId);
    const otherNodeId = await getSessionNodeId(otherSessionId);
    const { anchorId } = await createMessageAnchor(seed, parentSessionId, 0);

    const childNodeId = randomUUID();

    await expect(
      sql.begin(async (tx) => {
        await tx`
          INSERT INTO sessions (
            id, workflow_id, agent_binding_id, parent_session_id, fork_anchor_id,
            status, created_by_account_id
          ) VALUES (
            ${childSessionId}, ${seed.workflowId}, ${seed.agentBindingId}, ${parentSessionId},
            ${anchorId}, 'active', ${seed.accountId}
          )
        `;
        await tx`
          INSERT INTO session_nodes (
            id, workflow_id, session_id, title, node_kind, growth_state
          ) VALUES (
            ${childNodeId}, ${seed.workflowId}, ${childSessionId}, 'Child', 'branch', 'active'
          )
        `;
        await tx`
          INSERT INTO session_edges (
            id, workflow_id, source_session_node_id, target_session_node_id, kind, anchor_id
          ) VALUES (
            ${randomUUID()}, ${seed.workflowId}, ${otherNodeId}, ${childNodeId}, 'derives', ${anchorId}
          )
        `;
      }),
    ).rejects.toThrow();

    expect(parentNodeId).not.toBe(otherNodeId);
  });

  it('serializes concurrent derives writes on the Workflow row and rejects a cycle', async () => {
    const seed = await seedControlPlane();
    const firstSessionId = await createSession(seed);
    const secondSessionId = await createSession(seed);
    const firstNodeId = await getSessionNodeId(firstSessionId);
    const secondNodeId = await getSessionNodeId(secondSessionId);
    const firstAnchor = await createMessageAnchor(seed, firstSessionId, 0);
    const secondAnchor = await createMessageAnchor(seed, secondSessionId, 0);
    const firstClient = postgres(databaseUrl, { max: 1 });
    const secondClient = postgres(databaseUrl, { max: 1 });
    let ready = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const writeEdge = async (
      client: ReturnType<typeof postgres>,
      targetSessionId: string,
      parentSessionId: string,
      anchorId: string,
      sourceNodeId: string,
      targetNodeId: string,
    ) =>
      client.begin(async (tx) => {
        await tx`
          UPDATE sessions
          SET parent_session_id = ${parentSessionId}, fork_anchor_id = ${anchorId}
          WHERE id = ${targetSessionId}
        `;
        await tx`
          INSERT INTO session_edges (
            id, workflow_id, source_session_node_id, target_session_node_id, kind, anchor_id
          ) VALUES (
            ${randomUUID()}, ${seed.workflowId}, ${sourceNodeId}, ${targetNodeId}, 'derives', ${anchorId}
          )
        `;
        ready += 1;
        if (ready === 2) release();
        await barrier;
      });

    try {
      const results = await Promise.allSettled([
        writeEdge(
          firstClient,
          secondSessionId,
          firstSessionId,
          firstAnchor.anchorId,
          firstNodeId,
          secondNodeId,
        ),
        writeEdge(
          secondClient,
          firstSessionId,
          secondSessionId,
          secondAnchor.anchorId,
          secondNodeId,
          firstNodeId,
        ),
      ]);

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
    }
  });

  it('enforces command phases, append-only DomainEvents, and compensation lookup data', async () => {
    const seed = await seedControlPlane();
    const commandReceiptId = randomUUID();
    const eventId = randomUUID();

    await sql`
      INSERT INTO command_receipts (
        id, workflow_id, account_id, command_key, command_type, payload_hash,
        payload_canonical, orchestration_phase
      ) VALUES (
        ${commandReceiptId}, ${seed.workflowId}, ${seed.accountId}, 'command-1',
        'create-session', 'payload-1', '{"command":"one"}', 'canvas_prepared'
      )
    `;
    await sql`
      UPDATE command_receipts
      SET orchestration_phase = 'runtime_dispatched'
      WHERE id = ${commandReceiptId}
    `;
    await sql`
      UPDATE command_receipts
      SET orchestration_phase = 'runtime_known',
          external_resource_kind = 'session',
          external_resource_ref = 'external-session-1'
      WHERE id = ${commandReceiptId}
    `;
    await sql`
      UPDATE command_receipts
      SET orchestration_phase = 'attached',
          result_type = 'session',
          result_id = ${randomUUID()},
          result_payload = '{}'::jsonb,
          completed_at = now()
      WHERE id = ${commandReceiptId}
    `;
    await expect(
      sql`
        UPDATE command_receipts
        SET orchestration_phase = 'runtime_known'
        WHERE id = ${commandReceiptId}
      `,
    ).rejects.toThrow();

    const lookupOnlyReceiptId = randomUUID();
    await sql`
      INSERT INTO command_receipts (
        id, workflow_id, account_id, command_key, command_type, payload_hash,
        payload_canonical, orchestration_phase, external_resource_kind,
        external_lookup_metadata, result_type, result_id, result_payload, completed_at
      ) VALUES (
        ${lookupOnlyReceiptId}, ${seed.workflowId}, ${seed.accountId}, 'command-lookup',
        'start-run', 'payload-lookup', '{"command":"lookup"}', 'attached', 'run',
        '{"commandId":"command-lookup","canvasRunId":"pending"}'::jsonb,
        'run', ${randomUUID()}, '{}'::jsonb, now()
      )
    `;
    const [storedReceipt] = await sql<
      { external_resource_ref: string | null; payload_canonical: string }[]
    >`
      SELECT external_resource_ref, payload_canonical
      FROM command_receipts
      WHERE id = ${lookupOnlyReceiptId}
    `;
    expect(storedReceipt).toEqual({
      external_resource_ref: null,
      payload_canonical: '{"command":"lookup"}',
    });

    const adoptedReceiptId = randomUUID();
    const retryableReceiptId = randomUUID();
    await sql`
      INSERT INTO command_receipts (
        id, workflow_id, account_id, command_key, command_type, payload_hash,
        payload_canonical, orchestration_phase, external_lookup_metadata
      ) VALUES (
        ${adoptedReceiptId}, ${seed.workflowId}, ${seed.accountId}, 'command-adopt',
        'start-run', 'payload-adopt', '{"command":"adopt"}', 'reconciling',
        '{"commandId":"command-adopt","canvasRunId":"pending"}'::jsonb
      ), (
        ${retryableReceiptId}, ${seed.workflowId}, ${seed.accountId}, 'command-absent',
        'start-run', 'payload-absent', '{"command":"absent"}', 'reconciling',
        '{"commandId":"command-absent","canvasRunId":"pending"}'::jsonb
      )
    `;
    await sql`
      UPDATE command_receipts
      SET orchestration_phase = 'runtime_known',
          external_resource_kind = 'run',
          external_resource_ref = 'adopted-run'
      WHERE id = ${adoptedReceiptId}
    `;
    await sql`
      UPDATE command_receipts
      SET orchestration_phase = 'retryable_failure'
      WHERE id = ${retryableReceiptId}
    `;
    await expect(
      sql`
        INSERT INTO command_receipts (
          id, workflow_id, account_id, command_key, command_type, payload_hash,
          payload_canonical, orchestration_phase, external_resource_kind,
          external_lookup_metadata
        ) VALUES (
          ${randomUUID()}, ${seed.workflowId}, ${seed.accountId}, 'invalid-lookup',
          'start-run', 'invalid-lookup', '{"command":"invalid"}', 'runtime_known',
          'run', '[]'::jsonb
        )
      `,
    ).rejects.toThrow();

    await sql`
      INSERT INTO domain_events (
        id, account_id, workspace_id, workflow_id, aggregate_type, aggregate_id,
        aggregate_sequence, event_type, event_version, payload, occurred_at, recorded_at
      ) VALUES (
        ${eventId}, ${seed.accountId}, ${seed.workspaceId}, ${seed.workflowId},
        'workflow', ${seed.workflowId}, 1, 'workflow.created', 1, '{}'::jsonb, now(), now()
      )
    `;
    await expect(
      sql`UPDATE domain_events SET payload = '{"tampered":true}'::jsonb WHERE id = ${eventId}`,
    ).rejects.toThrow();
    await expect(sql`DELETE FROM domain_events WHERE id = ${eventId}`).rejects.toThrow();
    await sql`SELECT mark_domain_event_published(${eventId}, now())`;
    const [published] = await sql<{ publish_attempts: number; published_at: Date | null }[]>`
      SELECT publish_attempts, published_at FROM domain_events WHERE id = ${eventId}
    `;
    expect(published?.publish_attempts).toBe(1);
    expect(published?.published_at).toBeInstanceOf(Date);

    await expect(
      sql`
        INSERT INTO runtime_compensations (
          id, command_receipt_id, agent_binding_id, external_resource_kind,
          lookup_metadata, dedupe_key, action, status
        ) VALUES (
          ${randomUUID()}, ${commandReceiptId}, ${seed.agentBindingId}, 'session',
          '{}'::jsonb, 'missing-lookup', 'reconcile', 'pending'
        )
      `,
    ).rejects.toThrow();
    await expect(
      sql`
        INSERT INTO runtime_compensations (
          id, command_receipt_id, agent_binding_id, external_resource_kind,
          external_resource_ref, lookup_metadata, dedupe_key, action, status
        ) VALUES (
          ${randomUUID()}, ${commandReceiptId}, ${seed.agentBindingId}, 'session',
          'known-session', '{}'::jsonb, 'missing-lookup-with-ref', 'reconcile', 'pending'
        )
      `,
    ).rejects.toThrow();
    await sql`
      INSERT INTO runtime_compensations (
        id, command_receipt_id, agent_binding_id, external_resource_kind,
        lookup_metadata, dedupe_key, action, status
      ) VALUES (
        ${randomUUID()}, ${commandReceiptId}, ${seed.agentBindingId}, 'session',
        ${sql.json({ commandId: commandReceiptId, canvasSessionId: randomUUID() })},
        'lookup-ok', 'reconcile', 'pending'
      )
    `;
  });

  it('accepts DomainEvents whose aggregate ID matches their declared hierarchy level', async () => {
    const seed = await seedControlPlane();
    const sessionId = await createSession(seed);
    const runId = await createRun(seed, sessionId);
    const events = [
      {
        aggregateId: seed.workspaceId,
        aggregateType: 'workspace',
        workflowId: null,
        sessionId: null,
        runId: null,
      },
      {
        aggregateId: seed.workflowId,
        aggregateType: 'workflow',
        workflowId: seed.workflowId,
        sessionId: null,
        runId: null,
      },
      {
        aggregateId: sessionId,
        aggregateType: 'session',
        workflowId: seed.workflowId,
        sessionId,
        runId: null,
      },
      {
        aggregateId: runId,
        aggregateType: 'run',
        workflowId: seed.workflowId,
        sessionId,
        runId,
      },
    ] as const;

    for (const [index, event] of events.entries()) {
      await sql`
        INSERT INTO domain_events (
          id, account_id, workspace_id, workflow_id, session_id, run_id,
          aggregate_type, aggregate_id, aggregate_sequence, event_type,
          event_version, payload, occurred_at, recorded_at
        ) VALUES (
          ${randomUUID()}, ${seed.accountId}, ${seed.workspaceId}, ${event.workflowId},
          ${event.sessionId}, ${event.runId}, ${event.aggregateType}, ${event.aggregateId},
          ${index + 1}, ${`${event.aggregateType}.created`}, 1, '{}'::jsonb, now(), now()
        )
      `;
    }
  });

  it('rejects DomainEvents whose aggregate ID or type contradicts their hierarchy level', async () => {
    const seed = await seedControlPlane();
    const sessionId = await createSession(seed);
    const runId = await createRun(seed, sessionId);
    const invalidEvents = [
      {
        aggregateId: seed.workflowId,
        aggregateType: 'workspace',
        workflowId: null,
        sessionId: null,
        runId: null,
      },
      {
        aggregateId: seed.workspaceId,
        aggregateType: 'workflow',
        workflowId: seed.workflowId,
        sessionId: null,
        runId: null,
      },
      {
        aggregateId: seed.workflowId,
        aggregateType: 'session',
        workflowId: seed.workflowId,
        sessionId,
        runId: null,
      },
      {
        aggregateId: sessionId,
        aggregateType: 'run',
        workflowId: seed.workflowId,
        sessionId,
        runId,
      },
      {
        aggregateId: seed.workspaceId,
        aggregateType: 'unknown',
        workflowId: null,
        sessionId: null,
        runId: null,
      },
    ] as const;

    for (const [index, event] of invalidEvents.entries()) {
      await expect(sql`
        INSERT INTO domain_events (
          id, account_id, workspace_id, workflow_id, session_id, run_id,
          aggregate_type, aggregate_id, aggregate_sequence, event_type,
          event_version, payload, occurred_at, recorded_at
        ) VALUES (
          ${randomUUID()}, ${seed.accountId}, ${seed.workspaceId}, ${event.workflowId},
          ${event.sessionId}, ${event.runId}, ${event.aggregateType}, ${event.aggregateId},
          ${index + 10}, 'invalid.aggregate', 1, '{}'::jsonb, now(), now()
        )
      `).rejects.toThrow();
    }
  });

  it('only lets mark_domain_event_published update DomainEvent publish fields', async () => {
    const seed = await seedControlPlane();
    const directUpdateEventId = randomUUID();
    const publishEventId = randomUUID();

    await sql`
      INSERT INTO domain_events (
        id, account_id, workspace_id, workflow_id, aggregate_type, aggregate_id,
        aggregate_sequence, event_type, event_version, payload, occurred_at, recorded_at
      ) VALUES (
        ${directUpdateEventId}, ${seed.accountId}, ${seed.workspaceId}, ${seed.workflowId},
        'workflow', ${seed.workflowId}, 1, 'workflow.created', 1, '{}'::jsonb, now(), now()
      ), (
        ${publishEventId}, ${seed.accountId}, ${seed.workspaceId}, ${seed.workflowId},
        'workflow', ${seed.workflowId}, 2, 'workflow.updated', 1, '{}'::jsonb, now(), now()
      )
    `;

    const [identity] = await appSql<{ current_user: string }[]>`SELECT current_user`;
    const [ownership] = await sql<{ table_owner: string }[]>`
      SELECT pg_get_userbyid(table_record.relowner) AS table_owner
      FROM pg_class table_record
      JOIN pg_namespace namespace ON namespace.oid = table_record.relnamespace
      WHERE namespace.nspname = 'public'
        AND table_record.relname = 'domain_events'
    `;
    expect(identity?.current_user).toBe(appDatabaseRole);
    expect(ownership?.table_owner).not.toBe(appDatabaseRole);

    await expect(
      appSql.begin(async (tx) => {
        await tx`SELECT set_config('ai_super_canvas.domain_event_publish', '1', true)`;
        await tx`
          UPDATE domain_events
          SET published_at = now(), publish_attempts = 41
          WHERE id = ${directUpdateEventId}
        `;
      }),
    ).rejects.toThrow();

    const [unchanged] = await sql<
      { publish_attempts: number; published_at: Date | null }[]
    >`
      SELECT publish_attempts, published_at
      FROM domain_events
      WHERE id = ${directUpdateEventId}
    `;
    expect(unchanged).toEqual({ publish_attempts: 0, published_at: null });

    await expect(
      appSql.begin(async (tx) => {
        await tx`SELECT set_config('ai_super_canvas.domain_event_publish', '1', true)`;
        await tx`
          UPDATE domain_events
          SET payload = '{"tampered":true}'::jsonb
          WHERE id = ${directUpdateEventId}
        `;
      }),
    ).rejects.toThrow();
    await expect(
      appSql`DELETE FROM domain_events WHERE id = ${directUpdateEventId}`,
    ).rejects.toThrow();

    await appSql`SELECT public.mark_domain_event_published(${publishEventId}, now())`;
    const [published] = await sql<
      { publish_attempts: number; published_at: Date | null }[]
    >`
      SELECT publish_attempts, published_at
      FROM domain_events
      WHERE id = ${publishEventId}
    `;
    expect(published?.publish_attempts).toBe(1);
    expect(published?.published_at).toBeInstanceOf(Date);
  });

  it('keeps S4 lineage columns null in S1', async () => {
    const seed = await seedControlPlane();

    await expect(
      sql`
        INSERT INTO trunk_revisions (
          id, workflow_id, revision_number, content, content_hash,
          created_by_account_id, created_from_proposal_id
        ) VALUES (
          ${randomUUID()}, ${seed.workflowId}, 2, '{}'::jsonb, 'trunk-2',
          ${seed.accountId}, ${randomUUID()}
        )
      `,
    ).rejects.toThrow();

    await expect(
      sql`
        INSERT INTO branch_anchors (
          id, workflow_id, source_kind, context_trunk_revision_id,
          source_artifact_id, selector, created_by_account_id
        ) VALUES (
          ${randomUUID()}, ${seed.workflowId}, 'artifact', ${seed.trunkRevisionId},
          ${randomUUID()}, '{}'::jsonb, ${seed.accountId}
        )
      `,
    ).rejects.toThrow();
  });

  it('keeps compensation Session, Run, Binding, and receipt hierarchy aligned', async () => {
    const first = await seedControlPlane();
    const second = await seedControlPlane();
    const sessionId = await createSession(first);
    const configRevisionId = randomUUID();
    const triggerMessageId = randomUUID();
    const runId = randomUUID();
    const commandReceiptId = randomUUID();
    const runtimeSessionRefId = randomUUID();
    const runtimeSessionExternalRef = `runtime-session:${runId}`;
    const expectedHistoryDigest = `history:${runId}`;
    const secondSessionId = await createSession(second);
    const lookupMetadata = sql.json({
      commandId: commandReceiptId,
      canvasRunId: runId,
    });

    await sql`
      INSERT INTO session_config_revisions (
        id, session_id, version, created_by_account_id
      ) VALUES (${configRevisionId}, ${sessionId}, 1, ${first.accountId})
    `;
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${triggerMessageId}, ${first.workflowId}, ${sessionId}, 0, 'user',
        ${first.accountId}, '{}'::jsonb, 'completed'
      )
    `;
    await sql`
      INSERT INTO session_runtime_refs (
        id, session_id, agent_binding_id, external_session_ref,
        runtime_version, is_primary, status, metadata
      ) VALUES (
        ${runtimeSessionRefId}, ${sessionId}, ${first.agentBindingId},
        ${runtimeSessionExternalRef}, 'test-runtime-v1', true, 'active',
        ${sql.json({ historyDigest: expectedHistoryDigest })}
      )
    `;
    await sql`
      INSERT INTO runs (
        id, session_id, agent_binding_id, config_revision_id, trigger_message_id,
        idempotency_key, status, model_snapshot, tool_policy_snapshot,
        context_policy_snapshot, runtime_session_ref_id,
        runtime_session_external_ref, expected_history_digest,
        runtime_binding_snapshot
      ) VALUES (
        ${runId}, ${sessionId}, ${first.agentBindingId}, ${configRevisionId},
        ${triggerMessageId}, 'run-1', 'queued',
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${runtimeSessionRefId}, ${runtimeSessionExternalRef},
        ${expectedHistoryDigest}, ${sql.json({
          canvasAgentBindingId: first.agentBindingId,
          agentId: first.agentId,
          runtimeKind: 'fake',
          isolationKey: `isolation:${first.agentBindingId}`,
        })}
      )
    `;
    await sql`
      INSERT INTO command_receipts (
        id, workflow_id, account_id, command_key, command_type, payload_hash,
        payload_canonical, orchestration_phase
      ) VALUES (
        ${commandReceiptId}, ${first.workflowId}, ${first.accountId}, 'compensation-1',
        'start-run', 'compensation-1', '{"command":"compensation"}', 'reconciling'
      )
    `;

    await expect(
      sql`
        INSERT INTO runtime_compensations (
          id, command_receipt_id, agent_binding_id, canvas_run_id,
          external_resource_kind, lookup_metadata, dedupe_key, action, status
        ) VALUES (
          ${randomUUID()}, ${commandReceiptId}, ${first.agentBindingId}, ${runId},
          'run', ${lookupMetadata}, 'missing-session', 'reconcile', 'pending'
        )
      `,
    ).rejects.toThrow();
    await expect(
      sql`
        INSERT INTO runtime_compensations (
          id, command_receipt_id, agent_binding_id, canvas_session_id,
          external_resource_kind, lookup_metadata, dedupe_key, action, status
        ) VALUES (
          ${randomUUID()}, ${commandReceiptId}, ${second.agentBindingId}, ${sessionId},
          'session', ${lookupMetadata}, 'wrong-binding', 'reconcile', 'pending'
        )
      `,
    ).rejects.toThrow();
    await expect(
      sql`
        INSERT INTO runtime_compensations (
          id, command_receipt_id, agent_binding_id, canvas_session_id,
          external_resource_kind, lookup_metadata, dedupe_key, action, status
        ) VALUES (
          ${randomUUID()}, ${commandReceiptId}, ${second.agentBindingId},
          ${secondSessionId}, 'session', ${lookupMetadata},
          'wrong-workflow', 'reconcile', 'pending'
        )
      `,
    ).rejects.toThrow();
  });

  it('makes a succeeded Runtime compensation terminal and immutable', async () => {
    const seed = await seedControlPlane();
    const commandReceiptId = randomUUID();
    const compensationId = randomUUID();

    await sql`
      INSERT INTO command_receipts (
        id, workflow_id, account_id, command_key, command_type, payload_hash,
        payload_canonical, orchestration_phase
      ) VALUES (
        ${commandReceiptId}, ${seed.workflowId}, ${seed.accountId}, 'compensation-state',
        'reconcile-runtime', 'compensation-state', '{"command":"reconcile"}',
        'reconciling'
      )
    `;
    await sql`
      INSERT INTO runtime_compensations (
        id, command_receipt_id, agent_binding_id, external_resource_kind,
        lookup_metadata, dedupe_key, action, status
      ) VALUES (
        ${compensationId}, ${commandReceiptId}, ${seed.agentBindingId}, 'session',
        ${sql.json({ commandId: commandReceiptId, canvasSessionId: randomUUID() })},
        'compensation-state', 'reconcile', 'pending'
      )
    `;
    await sql`
      UPDATE runtime_compensations
      SET status = 'succeeded',
          resolution_evidence = '{"outcome":"adopted"}'::jsonb,
          resolved_at = now(),
          updated_at = now()
      WHERE id = ${compensationId}
    `;

    await expect(
      sql`
        UPDATE runtime_compensations
        SET status = 'failed', resolved_at = NULL, updated_at = now()
        WHERE id = ${compensationId}
      `,
    ).rejects.toThrow();
    await expect(
      sql`
        UPDATE runtime_compensations
        SET action = 'destroy', updated_at = now()
        WHERE id = ${compensationId}
      `,
    ).rejects.toThrow();
  });

  it('freezes attached command results and completed bootstrap receipts', async () => {
    const seed = await seedControlPlane();
    const commandReceiptId = randomUUID();
    const bootstrapReceiptId = randomUUID();

    await sql`
      INSERT INTO command_receipts (
        id, workflow_id, account_id, command_key, command_type, payload_hash,
        payload_canonical, orchestration_phase, external_resource_kind,
        external_resource_ref, result_type, result_id, result_payload, completed_at
      ) VALUES (
        ${commandReceiptId}, ${seed.workflowId}, ${seed.accountId}, 'attached-command',
        'create-session', 'attached-command', '{"command":"attached"}', 'attached',
        'session', 'external-session', 'session', ${randomUUID()}, '{}'::jsonb, now()
      )
    `;
    await expect(
      sql`
        UPDATE command_receipts
        SET result_payload = '{"tampered":true}'::jsonb
        WHERE id = ${commandReceiptId}
      `,
    ).rejects.toThrow();
    await expect(
      sql`
        UPDATE command_receipts
        SET external_resource_ref = 'different-session'
        WHERE id = ${commandReceiptId}
      `,
    ).rejects.toThrow();

    await sql`
      INSERT INTO bootstrap_receipts (
        id, auth_subject, command_key, payload_hash, payload_canonical, status,
        account_id, agent_id, agent_binding_id, workspace_id, workflow_id,
        result_payload, completed_at
      ) VALUES (
        ${bootstrapReceiptId}, 'auth:bootstrap', 'bootstrap-1', 'bootstrap-1',
        '{"command":"bootstrap"}', 'completed', ${seed.accountId}, ${seed.agentId},
        ${seed.agentBindingId}, ${seed.workspaceId}, ${seed.workflowId}, '{}'::jsonb, now()
      )
    `;
    await expect(
      sql`
        UPDATE bootstrap_receipts
        SET result_payload = '{"tampered":true}'::jsonb
        WHERE id = ${bootstrapReceiptId}
      `,
    ).rejects.toThrow();
  });

  it('keeps committed lineage immutable across Edge, Anchor, Message, and Node mutations', async () => {
    const seed = await seedControlPlane();
    const parentSessionId = await createSession(seed);
    const unrelatedSessionId = await createSession(seed);
    const parentNodeId = await getSessionNodeId(parentSessionId);
    const childSessionId = randomUUID();
    const childNodeId = randomUUID();
    const edgeId = randomUUID();
    const { anchorId, messageId } = await createMessageAnchor(seed, parentSessionId, 0);
    const unrelatedMessageId = randomUUID();

    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${unrelatedMessageId}, ${seed.workflowId}, ${unrelatedSessionId}, 0, 'user',
        ${seed.accountId}, '{}'::jsonb, 'completed'
      )
    `;
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO sessions (
          id, workflow_id, agent_binding_id, parent_session_id, fork_anchor_id,
          status, created_by_account_id
        ) VALUES (
          ${childSessionId}, ${seed.workflowId}, ${seed.agentBindingId}, ${parentSessionId},
          ${anchorId}, 'active', ${seed.accountId}
        )
      `;
      await tx`
        INSERT INTO session_nodes (
          id, workflow_id, session_id, title, node_kind, growth_state
        ) VALUES (
          ${childNodeId}, ${seed.workflowId}, ${childSessionId}, 'Child', 'branch', 'active'
        )
      `;
      await tx`
        INSERT INTO session_edges (
          id, workflow_id, source_session_node_id, target_session_node_id, kind, anchor_id
        ) VALUES (
          ${edgeId}, ${seed.workflowId}, ${parentNodeId}, ${childNodeId}, 'derives', ${anchorId}
        )
      `;
    });

    await expect(
      sql.begin(async (tx) => {
        await tx`DELETE FROM session_edges WHERE id = ${edgeId}`;
      }),
    ).rejects.toThrow();
    await expect(
      sql.begin(async (tx) => {
        await tx`
          UPDATE session_edges
          SET kind = 'references', anchor_id = NULL
          WHERE id = ${edgeId}
        `;
      }),
    ).rejects.toThrow();
    await expect(
      sql.begin(async (tx) => {
        await tx`
          UPDATE branch_anchors
          SET source_message_id = ${unrelatedMessageId}
          WHERE id = ${anchorId}
        `;
      }),
    ).rejects.toThrow();
    await expect(
      sql.begin(async (tx) => {
        await tx`
          UPDATE messages SET session_id = ${unrelatedSessionId} WHERE id = ${messageId}
        `;
      }),
    ).rejects.toThrow();
    await expect(
      sql.begin(async (tx) => {
        await tx`
          UPDATE session_nodes SET session_id = ${unrelatedSessionId} WHERE id = ${childNodeId}
        `;
      }),
    ).rejects.toThrow();
  });

  it('installs usable scope-specific indexes for authorized ContextRef loading', async () => {
    const expectedIndexes = [
      'context_refs_account_authorized_idx',
      'context_refs_agent_authorized_idx',
      'context_refs_session_authorized_idx',
      'context_refs_workflow_authorized_idx',
    ];
    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'context_refs'
        AND indexname = ANY(${expectedIndexes})
      ORDER BY indexname
    `;
    expect(indexes.map((index) => index.indexname)).toEqual(expectedIndexes);

    const actorId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const sessionId = randomUUID();
    const plan = await sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      return tx<{ 'QUERY PLAN': unknown }[]>`
        EXPLAIN (FORMAT JSON)
        SELECT id
        FROM (
          SELECT id, created_at
          FROM context_refs
          WHERE scope = 'account'
            AND visibility = 'private'
            AND account_id = ${actorId}
            AND (expires_at IS NULL OR expires_at > now())
          UNION ALL
          SELECT id, created_at
          FROM context_refs
          WHERE scope = 'agent'
            AND visibility = 'private'
            AND agent_id = ${agentId}
            AND account_id = ${actorId}
            AND (expires_at IS NULL OR expires_at > now())
          UNION ALL
          SELECT id, created_at
          FROM context_refs
          WHERE scope = 'workflow'
            AND workflow_id = ${workflowId}
            AND (
              visibility = 'workspace'
              OR (visibility = 'private' AND account_id = ${actorId})
            )
            AND (expires_at IS NULL OR expires_at > now())
          UNION ALL
          SELECT id, created_at
          FROM context_refs
          WHERE scope = 'session'
            AND session_id = ${sessionId}
            AND (
              visibility = 'workspace'
              OR (visibility = 'private' AND account_id = ${actorId})
            )
            AND (expires_at IS NULL OR expires_at > now())
        ) authorized_contexts
        ORDER BY created_at, id
      `;
    });
    const serializedPlan = JSON.stringify(plan);
    for (const indexName of expectedIndexes) {
      expect(serializedPlan).toContain(indexName);
    }
  });

  it('installs immutable Runtime input columns and the Run-to-ref foreign key', async () => {
    const columns = await sql<{
      column_name: string;
      is_nullable: string;
    }[]>`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'runs'
        AND column_name IN (
          'expected_history_digest',
          'runtime_binding_snapshot',
          'runtime_session_external_ref',
          'runtime_session_ref_id'
        )
      ORDER BY column_name
    `;
    expect(columns).toEqual([
      {
        column_name: 'expected_history_digest',
        is_nullable: 'NO',
      },
      {
        column_name: 'runtime_binding_snapshot',
        is_nullable: 'NO',
      },
      {
        column_name: 'runtime_session_external_ref',
        is_nullable: 'NO',
      },
      {
        column_name: 'runtime_session_ref_id',
        is_nullable: 'NO',
      },
    ]);

    const foreignKeys = await sql<{ conname: string }[]>`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'runs'::regclass
        AND contype = 'f'
      ORDER BY conname
    `;
    expect(foreignKeys.map((foreignKey) => foreignKey.conname))
      .toContain('runs_runtime_session_ref_fk');

    const triggers = await sql<{ tgname: string }[]>`
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = 'runs'::regclass
        AND NOT tgisinternal
      ORDER BY tgname
    `;
    expect(triggers.map((trigger) => trigger.tgname))
      .toContain('protect_run_runtime_input_snapshot_trigger');
  });
});
