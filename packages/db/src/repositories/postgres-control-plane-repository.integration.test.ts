import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createPostgresControlPlaneRepository } from './postgres-control-plane-repository';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for repository integration tests');
}

describe('PostgresControlPlaneRepository', () => {
  let repository = createPostgresControlPlaneRepository(databaseUrl);
  const sql = postgres(databaseUrl, { max: 2 });

  beforeEach(async () => repository.resetTestData());
  afterAll(async () => {
    await repository.close();
    await sql.end();
  });

  async function bootstrapFixture() {
    const bootstrap = await repository.bootstrapLocalAlpha({
      commandId: '40404040-4040-4040-8040-404040404040',
      authSubject: 'local:repository-contract',
      displayName: 'Repository contract owner',
      availableModels: [
        {
          providerKey: 'fake',
          modelKey: 'deterministic-v1',
          displayName: 'Deterministic v1',
          capabilities: { streaming: true },
        },
        {
          providerKey: 'fake',
          modelKey: 'deterministic-v2',
          displayName: 'Deterministic v2',
          capabilities: { streaming: true },
        },
      ],
      defaultModelKey: 'deterministic-v1',
    });
    return {
      ...bootstrap,
      actor: {
        accountId: bootstrap.accountId,
        authSubject: bootstrap.authSubject,
      },
    };
  }

  it('bootstraps concurrent identical commands once and compares exact UTF-8 canonical payloads', async () => {
    const input = {
      commandId: '40404040-4040-4040-8040-404040404040',
      authSubject: 'local:repository-contract',
      displayName: 'Repository contract owner é',
      availableModels: [
        {
          providerKey: 'fake',
          modelKey: 'deterministic-v1',
          displayName: 'Deterministic v1',
          capabilities: {},
        },
      ],
      defaultModelKey: 'deterministic-v1',
    } as const;

    const [first, second] = await Promise.all([
      repository.bootstrapLocalAlpha(input),
      repository.bootstrapLocalAlpha({ ...input }),
    ]);

    expect(second).toEqual(first);
    expect(first.defaultModelEntryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    await expect(
      repository.bootstrapLocalAlpha({
        ...input,
        displayName: 'Repository contract owner e\u0301',
      }),
    ).rejects.toThrow(/payload conflict/i);
  });

  it('serializes concurrent different bootstrap commands for one authSubject', async () => {
    const base = {
      authSubject: 'local:shared-subject',
      displayName: 'Shared owner',
      availableModels: [
        {
          providerKey: 'fake',
          modelKey: 'deterministic-v1',
          displayName: 'Deterministic v1',
        },
      ],
      defaultModelKey: 'deterministic-v1',
    } as const;

    const [first, second] = await Promise.all([
      repository.bootstrapLocalAlpha({
        ...base,
        commandId: '41414141-4141-4141-8141-414141414141',
      }),
      repository.bootstrapLocalAlpha({
        ...base,
        commandId: '42424242-4242-4242-8242-424242424242',
      }),
    ]);

    expect(second.accountId).toBe(first.accountId);
    const [count] = await sql<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM accounts
      WHERE auth_subject = ${base.authSubject}
    `;
    expect(count?.count).toBe(1);
  });

  it('rejects ambiguous default model keys and selects an explicit provider identity', async () => {
    const input = {
      commandId: '43434343-4343-4343-8343-434343434343',
      authSubject: 'local:model-identity',
      displayName: 'Model identity owner',
      availableModels: [
        {
          providerKey: 'fake-a',
          modelKey: 'shared-model',
          displayName: 'Shared A',
        },
        {
          providerKey: 'fake-b',
          modelKey: 'shared-model',
          displayName: 'Shared B',
        },
      ],
      defaultModelKey: 'shared-model',
    } as const;

    await expect(repository.bootstrapLocalAlpha(input)).rejects.toThrow(/ambiguous/i);
    const result = await repository.bootstrapLocalAlpha({
      ...input,
      defaultModelProviderKey: 'fake-b',
    });
    const [selected] = await sql<{ provider_key: string; model_key: string }[]>`
      SELECT provider_key, model_key FROM model_catalog_entries
      WHERE id = ${result.defaultModelEntryId}
    `;
    expect(selected).toEqual({ provider_key: 'fake-b', model_key: 'shared-model' });
  });

  it('normalizes and stably sorts model identities before concurrent bootstrap', async () => {
    const firstOrder = [
      {
        providerKey: ' fake-b ',
        modelKey: ' model-b ',
        displayName: ' Model B ',
        capabilities: { z: true, a: true },
      },
      {
        providerKey: 'fake-a',
        modelKey: 'model-a',
        displayName: 'Model A',
        capabilities: { b: true, a: true },
      },
    ] as const;
    const base = {
      commandId: '44444444-4444-4444-8444-444444444444',
      authSubject: 'local:stable-model-order',
      displayName: 'Stable model owner',
      defaultModelProviderKey: 'fake-a',
      defaultModelKey: 'model-a',
    } as const;
    const [first, second] = await Promise.all([
      repository.bootstrapLocalAlpha({ ...base, availableModels: firstOrder }),
      repository.bootstrapLocalAlpha({
        ...base,
        availableModels: [...firstOrder].reverse(),
      }),
    ]);
    expect(second).toEqual(first);
    const identities = await sql<{ provider_key: string; model_key: string }[]>`
      SELECT provider_key, model_key FROM model_catalog_entries
      ORDER BY provider_key, model_key
    `;
    expect(identities).toEqual([
      { provider_key: 'fake-a', model_key: 'model-a' },
      { provider_key: 'fake-b', model_key: 'model-b' },
    ]);

    await expect(
      repository.bootstrapLocalAlpha({
        ...base,
        commandId: '45454545-4545-4545-8545-454545454545',
        availableModels: [
          firstOrder[0],
          { ...firstOrder[0], providerKey: 'fake-b', modelKey: 'model-b' },
        ],
      }),
    ).rejects.toThrow(/duplicate model seed/i);
  });

  it('rejects corrupted completed receipt payloads and same-hash different canonical bytes', async () => {
    const fixture = await bootstrapFixture();
    const [source] = await sql<{
      payload_hash: string;
      payload_canonical: string;
    }[]>`
      SELECT payload_hash, payload_canonical FROM bootstrap_receipts
      WHERE auth_subject = ${fixture.authSubject}
        AND command_key = '40404040-4040-4040-8040-404040404040'
    `;
    if (!source) throw new Error('Bootstrap receipt fixture is missing');

    await sql`
      INSERT INTO bootstrap_receipts (
        id, auth_subject, command_key, payload_hash, payload_canonical, status,
        account_id, agent_id, agent_binding_id, workspace_id, workflow_id,
        result_payload, completed_at
      ) VALUES (
        '46464646-4646-4646-8646-464646464646', ${fixture.authSubject},
        '47474747-4747-4747-8747-474747474747', ${source.payload_hash},
        ${source.payload_canonical}, 'completed', ${fixture.accountId}, ${fixture.agentId},
        ${fixture.agentBindingId}, ${fixture.workspaceId}, ${fixture.workflowId},
        '{"wrong":true}'::jsonb, now()
      )
    `;
    await expect(
      repository.bootstrapLocalAlpha({
        commandId: '47474747-4747-4747-8747-474747474747',
        authSubject: fixture.authSubject,
        displayName: 'Repository contract owner',
        availableModels: [
          {
            providerKey: 'fake',
            modelKey: 'deterministic-v1',
            displayName: 'Deterministic v1',
            capabilities: { streaming: true },
          },
          {
            providerKey: 'fake',
            modelKey: 'deterministic-v2',
            displayName: 'Deterministic v2',
            capabilities: { streaming: true },
          },
        ],
        defaultModelKey: 'deterministic-v1',
      }),
    ).rejects.toThrow(/invalid completed bootstrap receipt/i);

    await sql`
      INSERT INTO bootstrap_receipts (
        id, auth_subject, command_key, payload_hash, payload_canonical
      ) VALUES (
        '48484848-4848-4848-8848-484848484848', ${fixture.authSubject},
        '49494949-4949-4949-8949-494949494949', ${source.payload_hash},
        ${`${source.payload_canonical} `}
      )
    `;
    await expect(
      repository.bootstrapLocalAlpha({
        commandId: '49494949-4949-4949-8949-494949494949',
        authSubject: fixture.authSubject,
        displayName: 'Repository contract owner',
        availableModels: [
          {
            providerKey: 'fake',
            modelKey: 'deterministic-v1',
            displayName: 'Deterministic v1',
            capabilities: { streaming: true },
          },
          {
            providerKey: 'fake',
            modelKey: 'deterministic-v2',
            displayName: 'Deterministic v2',
            capabilities: { streaming: true },
          },
        ],
        defaultModelKey: 'deterministic-v1',
      }),
    ).rejects.toThrow(/payload conflict/i);
  });

  it('keeps one resource graph across commands and closes old connections before replay', async () => {
    const base = {
      authSubject: 'local:resource-cardinality',
      displayName: 'Cardinality owner',
      availableModels: [
        {
          providerKey: 'fake',
          modelKey: 'deterministic-v1',
          displayName: 'Deterministic v1',
          capabilities: { a: 1, b: 2 },
        },
      ],
      defaultModelKey: 'deterministic-v1',
    } as const;
    const first = await repository.bootstrapLocalAlpha({
      ...base,
      commandId: '50505050-5050-4050-8050-505050505050',
    });
    await repository.bootstrapLocalAlpha({
      ...base,
      commandId: '51515151-5151-4151-8151-515151515151',
      availableModels: [
        {
          ...base.availableModels[0],
          capabilities: { b: 2, a: 1 },
        },
      ],
    });
    const [counts] = await sql<Record<string, number>[]>`
      SELECT
        (SELECT count(*)::integer FROM bootstrap_receipts) AS receipts,
        (SELECT count(*)::integer FROM accounts) AS accounts,
        (SELECT count(*)::integer FROM agents) AS agents,
        (SELECT count(*)::integer FROM agent_bindings) AS bindings,
        (SELECT count(*)::integer FROM workspaces) AS workspaces,
        (SELECT count(*)::integer FROM workflows) AS workflows
    `;
    expect(counts).toEqual({
      receipts: 2,
      accounts: 1,
      agents: 1,
      bindings: 1,
      workspaces: 1,
      workflows: 1,
    });

    const closedRepository = repository;
    await closedRepository.close();
    await expect(
      closedRepository.resolveActorContext({ authSubject: base.authSubject }),
    ).rejects.toThrow();
    repository = createPostgresControlPlaneRepository(databaseUrl);
    await expect(
      repository.bootstrapLocalAlpha({
        ...base,
        commandId: '50505050-5050-4050-8050-505050505050',
      }),
    ).resolves.toEqual(first);
  });

  it('creates an idempotent root Session with config v1 and hydrates a stable workflow DTO', async () => {
    const fixture = await bootstrapFixture();
    const input = {
      actor: fixture.actor,
      commandId: '13131313-1313-4313-8313-131313131313',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Root Session',
    } as const;

    const first = await repository.createRootSession(input);
    const second = await repository.createRootSession({ ...input });
    expect(second).toEqual(first);

    const hydrated = await repository.hydrateWorkflow({
      actor: fixture.actor,
      workflowId: fixture.workflowId,
    });
    expect(hydrated.workflow.id).toBe(fixture.workflowId);
    expect(hydrated.trunk?.id).toBe(fixture.trunkRevisionId);
    expect(hydrated.anchors).toEqual([]);
    expect(hydrated.edges).toEqual([]);
    expect(hydrated.blocks).toHaveLength(1);
    expect(hydrated.blocks[0]).toMatchObject({
      session: { id: first.sessionId },
      node: { id: first.nodeId, title: 'Root Session', nodeKind: 'mainline' },
      currentConfig: {
        version: 1,
        modelEntryId: fixture.defaultModelEntryId,
      },
      messages: [],
      activeRun: null,
    });

    const models = await repository.listAvailableModels({
      actor: fixture.actor,
      sessionId: first.sessionId,
    });
    expect(models.map((model) => model.modelKey)).toEqual([
      'deterministic-v1',
      'deterministic-v2',
    ]);
  });

  it('persists an idempotent modelEntryId config update with optimistic versioning', async () => {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '13131313-1313-4313-8313-131313131313',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Configurable Session',
    });
    const models = await repository.listAvailableModels({
      actor: fixture.actor,
      sessionId: session.sessionId,
    });
    const secondModel = models.find((model) => model.modelKey === 'deterministic-v2');
    if (!secondModel) throw new Error('Second fake model fixture is missing');

    const update = {
      actor: fixture.actor,
      sessionId: session.sessionId,
      commandId: '23232323-2323-4323-8323-232323232323',
      expectedVersion: 1,
      modelEntryId: secondModel.id,
    } as const;
    const first = await repository.updateSessionConfig(update);
    const replay = await repository.updateSessionConfig({ ...update });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ version: 2, modelEntryId: secondModel.id });

    await expect(
      repository.updateSessionConfig({
        ...update,
        commandId: '24242424-2424-4424-8424-242424242424',
      }),
    ).rejects.toThrow(/version conflict/i);

    await repository.close();
    repository = createPostgresControlPlaneRepository(databaseUrl);
    const hydrated = await repository.hydrateWorkflow({
      actor: fixture.actor,
      workflowId: fixture.workflowId,
    });
    expect(hydrated.blocks[0]?.currentConfig).toMatchObject({
      version: 2,
      modelEntryId: secondModel.id,
    });
  });

  it('serializes concurrent config idempotency and optimistic-version competitors', async () => {
    const fixture = await bootstrapFixture();
    const models = await repository.listAvailableModels({
      actor: fixture.actor,
      sessionId: (
        await repository.createRootSession({
          actor: fixture.actor,
          commandId: '11212121-2121-4121-8121-212121212121',
          workflowId: fixture.workflowId,
          agentBindingId: fixture.agentBindingId,
          title: 'Same command config',
        })
      ).sessionId,
    });
    const modelV2 = models.find((model) => model.modelKey === 'deterministic-v2');
    if (!modelV2) throw new Error('Fake v2 model fixture is missing');
    const sameSession = (await repository.hydrateWorkflow({
      actor: fixture.actor,
      workflowId: fixture.workflowId,
    })).blocks[0]!.session.id;
    const sameInput = {
      actor: fixture.actor,
      sessionId: sameSession,
      commandId: '11313131-3131-4131-8131-313131313131',
      expectedVersion: 1,
      modelEntryId: modelV2.id,
    } as const;
    const [sameFirst, sameSecond] = await Promise.all([
      repository.updateSessionConfig(sameInput),
      repository.updateSessionConfig({ ...sameInput }),
    ]);
    expect(sameSecond).toEqual(sameFirst);

    const competingSession = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '11414141-4141-4141-8141-414141414141',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Competing config commands',
    });
    const competitors = await Promise.allSettled([
      repository.updateSessionConfig({
        actor: fixture.actor,
        sessionId: competingSession.sessionId,
        commandId: '11515151-5151-4151-8151-515151515151',
        expectedVersion: 1,
        modelEntryId: modelV2.id,
      }),
      repository.updateSessionConfig({
        actor: fixture.actor,
        sessionId: competingSession.sessionId,
        commandId: '11616161-6161-4161-8161-616161616161',
        expectedVersion: 1,
        modelEntryId: modelV2.id,
      }),
    ]);
    expect(competitors.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = competitors.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toMatchObject({
      name: 'SessionConfigVersionConflictError',
    });
  });

  it('deduplicates concurrent root, anchored, and fork commands', async () => {
    const fixture = await bootstrapFixture();
    const rootInput = {
      actor: fixture.actor,
      commandId: '11717171-7171-4171-8171-717171717171',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Concurrent root',
    } as const;
    const [rootFirst, rootSecond] = await Promise.all([
      repository.createRootSession(rootInput),
      repository.createRootSession({ ...rootInput }),
    ]);
    expect(rootSecond).toEqual(rootFirst);

    const anchoredInput = {
      actor: fixture.actor,
      command: {
        kind: 'anchor-trunk' as const,
        commandId: '11818181-8181-4181-8181-818181818181',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Concurrent anchor',
        agentBindingId: fixture.agentBindingId,
        anchor: {
          sourceKind: 'trunk-revision' as const,
          sourceId: fixture.trunkRevisionId,
          selector: { kind: 'text-quote' as const, exact: 'document' },
        },
      },
    };
    const [anchorFirst, anchorSecond] = await Promise.all([
      repository.prepareAnchoredSession(anchoredInput),
      repository.prepareAnchoredSession({
        ...anchoredInput,
        command: { ...anchoredInput.command },
      }),
    ]);
    expect(anchorSecond).toEqual(anchorFirst);

    const boundaryId = '11919191-9191-4191-8191-919191919191';
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${boundaryId}, ${fixture.workflowId}, ${rootFirst.sessionId}, 0, 'user',
        ${fixture.accountId}, ${sql.json({ text: 'concurrent fork' })}, 'completed'
      )
    `;
    await sql`
      UPDATE sessions SET status = 'active', transcript_version = 1
      WHERE id = ${rootFirst.sessionId}
    `;
    await sql`
      INSERT INTO session_runtime_refs (
        id, session_id, agent_binding_id, external_session_ref, runtime_version,
        is_primary, status, metadata
      ) VALUES (
        '12020202-0202-4202-8202-020202020202', ${rootFirst.sessionId},
        ${fixture.agentBindingId}, 'fake-session:concurrent-fork', 'deterministic-v1',
        true, 'active', ${sql.json({ historyDigest: 'sha256:concurrent-fork' })}
      )
    `;
    const forkInput = {
      actor: fixture.actor,
      command: {
        kind: 'fork-message' as const,
        commandId: '12121212-1212-4212-8212-121212121212',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Concurrent fork',
        parentSessionId: rootFirst.sessionId,
        atMessageId: boundaryId,
        agentBindingId: fixture.agentBindingId,
        anchor: {
          sourceKind: 'message' as const,
          sourceId: boundaryId,
          selector: { kind: 'text-quote' as const, exact: 'concurrent fork' },
        },
      },
    };
    const [forkFirst, forkSecond] = await Promise.all([
      repository.prepareFork(forkInput),
      repository.prepareFork({ ...forkInput, command: { ...forkInput.command } }),
    ]);
    expect(forkSecond).toEqual(forkFirst);

    const [counts] = await sql<Record<string, number>[]>`
      SELECT
        count(*) FILTER (
          WHERE command_key IN (
            ${rootInput.commandId}, ${anchoredInput.command.commandId},
            ${forkInput.command.commandId}
          )
        )::integer AS receipts,
        count(DISTINCT result_id) FILTER (
          WHERE command_key IN (
            ${rootInput.commandId}, ${anchoredInput.command.commandId},
            ${forkInput.command.commandId}
          )
        )::integer AS results
      FROM command_receipts
    `;
    expect(counts).toEqual({ receipts: 3, results: 3 });
  });

  it('hydrates one repeatable-read snapshot across a concurrent multi-table update', async () => {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '12222222-2222-4222-8222-222222222222',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Snapshot old node',
    });
    let releaseSnapshot!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let snapshotReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      snapshotReached = resolve;
    });
    await repository.close();
    repository = createPostgresControlPlaneRepository(databaseUrl, {
      afterHydrateSnapshotEstablished: async () => {
        snapshotReached();
        await release;
      },
    });
    const hydration = repository.hydrateWorkflow({
      actor: fixture.actor,
      workflowId: fixture.workflowId,
    });
    await Promise.race([
      reached,
      hydration.then(() => {
        throw new Error('Hydration snapshot test hook was not invoked');
      }),
    ]);
    await sql.begin(async (tx) => {
      await tx`
        UPDATE workflows SET title = 'Snapshot new workflow'
        WHERE id = ${fixture.workflowId}
      `;
      await tx`
        UPDATE session_nodes SET title = 'Snapshot new node'
        WHERE session_id = ${session.sessionId}
      `;
    });
    releaseSnapshot();
    const duringUpdate = await hydration;
    expect(duringUpdate.workflow.title).toBe('Local Alpha Workflow');
    expect(duringUpdate.blocks[0]?.node.title).toBe('Snapshot old node');

    const afterUpdate = await repository.hydrateWorkflow({
      actor: fixture.actor,
      workflowId: fixture.workflowId,
    });
    expect(afterUpdate.workflow.title).toBe('Snapshot new workflow');
    expect(afterUpdate.blocks[0]?.node.title).toBe('Snapshot new node');
  });

  it('replays root, anchored, and fork receipts with the current attached phase after reopen', async () => {
    const fixture = await bootstrapFixture();
    const rootInput = {
      actor: fixture.actor,
      commandId: '72727272-7272-4272-8272-727272727272',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Replay root',
    } as const;
    const root = await repository.createRootSession(rootInput);
    const anchoredInput = {
      actor: fixture.actor,
      command: {
        kind: 'anchor-trunk' as const,
        commandId: '73737373-7373-4373-8373-737373737373',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Replay anchor',
        agentBindingId: fixture.agentBindingId,
        anchor: {
          sourceKind: 'trunk-revision' as const,
          sourceId: fixture.trunkRevisionId,
          selector: { kind: 'text-quote' as const, exact: 'document' },
        },
      },
    };
    const anchored = await repository.prepareAnchoredSession(anchoredInput);
    const boundaryId = '74747474-7474-4474-8474-747474747474';
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${boundaryId}, ${fixture.workflowId}, ${root.sessionId}, 0, 'user',
        ${fixture.accountId}, ${sql.json({ text: 'fork here' })}, 'completed'
      )
    `;
    await sql`
      UPDATE sessions SET status = 'active', transcript_version = 1
      WHERE id = ${root.sessionId}
    `;
    await sql`
      INSERT INTO session_runtime_refs (
        id, session_id, agent_binding_id, external_session_ref, runtime_version,
        is_primary, status, metadata
      ) VALUES (
        '75757575-7575-4575-8575-757575757575', ${root.sessionId},
        ${fixture.agentBindingId}, 'fake-session:replay-parent', 'deterministic-v1',
        true, 'active', ${sql.json({ historyDigest: 'sha256:replay-parent' })}
      )
    `;
    const forkInput = {
      actor: fixture.actor,
      command: {
        kind: 'fork-message' as const,
        commandId: '76767676-7676-4676-8676-767676767676',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Replay fork',
        parentSessionId: root.sessionId,
        atMessageId: boundaryId,
        agentBindingId: fixture.agentBindingId,
        anchor: {
          sourceKind: 'message' as const,
          sourceId: boundaryId,
          selector: { kind: 'text-quote' as const, exact: 'fork here' },
        },
      },
    };
    const fork = await repository.prepareFork(forkInput);

    async function markAttached(
      commandReceiptId: string,
      commandId: string,
      sessionId: string,
      externalSessionRef: string,
    ) {
      await sql`
        UPDATE command_receipts SET orchestration_phase = 'runtime_dispatched'
        WHERE id = ${commandReceiptId}
      `;
      await sql`
        UPDATE command_receipts
        SET orchestration_phase = 'runtime_known', external_resource_kind = 'session',
          external_resource_ref = ${externalSessionRef},
          external_lookup_metadata = ${sql.json({ commandId, canvasSessionId: sessionId })}
        WHERE id = ${commandReceiptId}
      `;
      await sql`
        UPDATE command_receipts
        SET orchestration_phase = 'attached', completed_at = now()
        WHERE id = ${commandReceiptId}
      `;
    }
    await markAttached(root.commandReceiptId, rootInput.commandId, root.sessionId, 'runtime:root');
    await markAttached(
      anchored.commandReceiptId,
      anchoredInput.command.commandId,
      anchored.sessionId,
      'runtime:anchor',
    );
    await markAttached(
      fork.commandReceiptId,
      forkInput.command.commandId,
      fork.sessionId,
      'runtime:fork',
    );

    await repository.close();
    repository = createPostgresControlPlaneRepository(databaseUrl);
    await expect(repository.createRootSession(rootInput)).resolves.toMatchObject({
      commandReceiptId: root.commandReceiptId,
      sessionId: root.sessionId,
      phase: 'attached',
    });
    await expect(repository.prepareAnchoredSession(anchoredInput)).resolves.toMatchObject({
      commandReceiptId: anchored.commandReceiptId,
      sessionId: anchored.sessionId,
      anchorId: anchored.anchorId,
      phase: 'attached',
    });
    await expect(repository.prepareFork(forkInput)).resolves.toMatchObject({
      commandReceiptId: fork.commandReceiptId,
      sessionId: fork.sessionId,
      anchorId: fork.anchorId,
      phase: 'attached',
    });
  });

  it('rejects a malformed persisted command result instead of trusting its JSON shape', async () => {
    const fixture = await bootstrapFixture();
    const original = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '77777777-7777-4777-8777-777777777777',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Validated replay',
    });
    const [canonical] = await sql<{
      payload_hash: string;
      payload_canonical: string;
    }[]>`
      SELECT payload_hash, payload_canonical FROM command_receipts
      WHERE id = ${original.commandReceiptId}
    `;
    if (!canonical) throw new Error('Original command receipt is missing');
    await sql`
      INSERT INTO command_receipts (
        id, workflow_id, account_id, command_key, command_type,
        payload_hash, payload_canonical, result_type, result_id, result_payload
      ) VALUES (
        '78787878-7878-4878-8878-787878787878', ${fixture.workflowId},
        ${fixture.accountId}, '79797979-7979-4979-8979-797979797979',
        'create-root-session', ${canonical.payload_hash}, ${canonical.payload_canonical},
        'session', ${original.sessionId}, ${sql.json({ malformed: true })}
      )
    `;

    await expect(
      repository.createRootSession({
        actor: fixture.actor,
        commandId: '79797979-7979-4979-8979-797979797979',
        workflowId: fixture.workflowId,
        agentBindingId: fixture.agentBindingId,
        title: 'Validated replay',
      }),
    ).rejects.toThrow(/invalid|malformed|result payload/i);
  });

  it('resolves default and inherited models from the concrete target Agent binding', async () => {
    const fixture = await bootstrapFixture();
    const fakeV2 = await sql<{ id: string }[]>`
      SELECT id FROM model_catalog_entries
      WHERE runtime_kind = 'fake' AND provider_key = 'fake'
        AND model_key = 'deterministic-v2'
    `;
    if (!fakeV2[0]) throw new Error('Fake v2 model fixture is missing');

    const fakeAgentId = '80808080-8080-4080-8080-808080808080';
    const fakeBindingId = '81818181-8181-4181-8181-818181818181';
    await sql`
      INSERT INTO agents (id, owner_account_id, name, status, default_model_key)
      VALUES (
        ${fakeAgentId}, ${fixture.accountId}, 'Target fake Agent', 'active',
        'deterministic-v2'
      )
    `;
    await sql`
      INSERT INTO agent_bindings (
        id, agent_id, runtime_kind, isolation_key, status, is_primary, runtime_version
      ) VALUES (
        ${fakeBindingId}, ${fakeAgentId}, 'fake', 'target-fake', 'ready', true,
        'deterministic-v2'
      )
    `;
    const targetRoot = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '82828282-8282-4282-8282-828282828282',
      workflowId: fixture.workflowId,
      agentBindingId: fakeBindingId,
      title: 'Target fake root',
    });
    expect(targetRoot.config.modelEntryId).toBe(fakeV2[0].id);
    const targetAnchor = await repository.prepareAnchoredSession({
      actor: fixture.actor,
      command: {
        kind: 'anchor-trunk',
        commandId: '83838383-8383-4383-8383-838383838383',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Target fake anchor',
        agentBindingId: fakeBindingId,
        anchor: {
          sourceKind: 'trunk-revision',
          sourceId: fixture.trunkRevisionId,
          selector: { kind: 'text-quote', exact: 'document' },
        },
      },
    });
    expect(targetAnchor.config.modelEntryId).toBe(fakeV2[0].id);

    const parent = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '84848484-8484-4484-8484-848484848484',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Model inheritance parent',
    });
    const boundaryId = '85858585-8585-4585-8585-858585858585';
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${boundaryId}, ${fixture.workflowId}, ${parent.sessionId}, 0, 'user',
        ${fixture.accountId}, ${sql.json({ text: 'model fork' })}, 'completed'
      )
    `;
    await sql`
      UPDATE sessions SET status = 'active', transcript_version = 1
      WHERE id = ${parent.sessionId}
    `;
    await sql`
      INSERT INTO session_runtime_refs (
        id, session_id, agent_binding_id, external_session_ref, runtime_version,
        is_primary, status, metadata
      ) VALUES (
        '86868686-8686-4686-8686-868686868686', ${parent.sessionId},
        ${fixture.agentBindingId}, 'fake-session:model-parent', 'deterministic-v1', true,
        'active', ${sql.json({ historyDigest: 'sha256:model-parent' })}
      )
    `;
    const sameRuntimeFork = await repository.prepareFork({
      actor: fixture.actor,
      command: {
        kind: 'fork-message',
        commandId: '87878787-8787-4787-8787-878787878787',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Same runtime fork',
        parentSessionId: parent.sessionId,
        atMessageId: boundaryId,
        agentBindingId: fakeBindingId,
        anchor: {
          sourceKind: 'message',
          sourceId: boundaryId,
          selector: { kind: 'text-quote', exact: 'model fork' },
        },
      },
    });
    expect(sameRuntimeFork.config.modelEntryId).toBe(fixture.defaultModelEntryId);

    const hermesModelId = '88888888-8888-4888-8888-888888888888';
    const hermesAgentId = '89898989-8989-4989-8989-898989898989';
    const hermesBindingId = '90909090-9090-4090-8090-909090909090';
    await sql`
      INSERT INTO model_catalog_entries (
        id, runtime_kind, provider_key, model_key, display_name, capabilities,
        availability, discovery_source, observed_at
      ) VALUES (
        ${hermesModelId}, 'hermes-acp', 'hermes', 'hermes-default', 'Hermes default',
        '{}'::jsonb, 'available', 'repository-test', now()
      )
    `;
    await sql`
      INSERT INTO agents (id, owner_account_id, name, status, default_model_key)
      VALUES (
        ${hermesAgentId}, ${fixture.accountId}, 'Target Hermes Agent', 'active',
        'hermes-default'
      )
    `;
    await sql`
      INSERT INTO agent_bindings (
        id, agent_id, runtime_kind, isolation_key, status, is_primary, runtime_version
      ) VALUES (
        ${hermesBindingId}, ${hermesAgentId}, 'hermes-acp', 'target-hermes', 'ready',
        true, 'hermes-test'
      )
    `;
    const crossRuntimeFork = await repository.prepareFork({
      actor: fixture.actor,
      command: {
        kind: 'fork-message',
        commandId: '91919191-9191-4191-8191-919191919191',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Cross runtime fork',
        parentSessionId: parent.sessionId,
        atMessageId: boundaryId,
        agentBindingId: hermesBindingId,
        anchor: {
          sourceKind: 'message',
          sourceId: boundaryId,
          selector: { kind: 'text-quote', exact: 'model fork' },
        },
      },
    });
    expect(crossRuntimeFork.config.modelEntryId).toBe(hermesModelId);
  });

  it('fails closed when a target Agent default model key has multiple providers', async () => {
    const fixture = await bootstrapFixture();
    await sql`
      INSERT INTO model_catalog_entries (
        id, runtime_kind, provider_key, model_key, display_name, capabilities,
        availability, discovery_source, observed_at
      ) VALUES
        (
          '92929292-9292-4292-8292-929292929292', 'fake', 'provider-a',
          'ambiguous-default', 'Ambiguous A', '{}'::jsonb, 'available',
          'repository-test', now()
        ),
        (
          '93939393-9393-4393-8393-939393939393', 'fake', 'provider-b',
          'ambiguous-default', 'Ambiguous B', '{}'::jsonb, 'available',
          'repository-test', now()
        )
    `;
    const agentId = '94949494-9494-4494-8494-949494949494';
    const bindingId = '95959595-9595-4595-8595-959595959595';
    await sql`
      INSERT INTO agents (id, owner_account_id, name, status, default_model_key)
      VALUES (
        ${agentId}, ${fixture.accountId}, 'Ambiguous Agent', 'active',
        'ambiguous-default'
      )
    `;
    await sql`
      INSERT INTO agent_bindings (
        id, agent_id, runtime_kind, isolation_key, status, is_primary, runtime_version
      ) VALUES (
        ${bindingId}, ${agentId}, 'fake', 'ambiguous-agent', 'ready', true,
        'deterministic-v1'
      )
    `;
    await expect(
      repository.createRootSession({
        actor: fixture.actor,
        commandId: '96969696-9696-4696-8696-969696969696',
        workflowId: fixture.workflowId,
        agentBindingId: bindingId,
        title: 'Ambiguous model root',
      }),
    ).rejects.toThrow(/ambiguous/i);
  });

  it('revalidates account identity, workspace membership, and live Agent authorization', async () => {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '13131313-1313-4313-8313-131313131313',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Authorized Session',
    });

    await expect(
      repository.listAvailableModels({
        actor: { ...fixture.actor, authSubject: 'forged:subject' },
        sessionId: session.sessionId,
      }),
    ).rejects.toThrow(/unauthorized/i);

    await sql`
      DELETE FROM workspace_members
      WHERE workspace_id = ${fixture.workspaceId} AND account_id = ${fixture.accountId}
    `;
    await expect(
      repository.hydrateWorkflow({
        actor: fixture.actor,
        workflowId: fixture.workflowId,
      }),
    ).rejects.toThrow(/unauthorized/i);

    await sql`
      INSERT INTO workspace_members (workspace_id, account_id, role)
      VALUES (${fixture.workspaceId}, ${fixture.accountId}, 'owner')
    `;
    await sql`
      UPDATE agent_access_grants SET revoked_at = now()
      WHERE agent_id = ${fixture.agentId} AND account_id = ${fixture.accountId}
    `;
    await expect(
      repository.listAvailableModels({
        actor: fixture.actor,
        sessionId: session.sessionId,
      }),
    ).resolves.toHaveLength(2);
    await sql`UPDATE agents SET status = 'disabled' WHERE id = ${fixture.agentId}`;
    await expect(
      repository.listAvailableModels({
        actor: fixture.actor,
        sessionId: session.sessionId,
      }),
    ).rejects.toThrow(/unauthorized/i);

    await repository.close();
    repository = createPostgresControlPlaneRepository(databaseUrl);
    await expect(
      repository.resolveActorContext({ authSubject: fixture.authSubject }),
    ).resolves.toEqual(fixture.actor);
  });

  it('hydrates only Sessions whose concrete Agent is visible to a Workspace viewer', async () => {
    const fixture = await bootstrapFixture();
    const visibleSession = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '25252525-2525-4525-8525-252525252525',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Visible Agent Session',
    });
    const hiddenAgentId = '26262626-2626-4626-8626-262626262626';
    const hiddenBindingId = '27272727-2727-4727-8727-272727272727';
    await sql`
      INSERT INTO agents (id, owner_account_id, name, status, default_model_key)
      VALUES (
        ${hiddenAgentId}, ${fixture.accountId}, 'Hidden Agent', 'active',
        'deterministic-v1'
      )
    `;
    await sql`
      INSERT INTO agent_bindings (
        id, agent_id, runtime_kind, isolation_key, status, is_primary, runtime_version
      ) VALUES (
        ${hiddenBindingId}, ${hiddenAgentId}, 'fake', 'hidden-agent', 'ready', true,
        'deterministic-v1'
      )
    `;
    const hiddenSession = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '28282828-2828-4828-8828-282828282828',
      workflowId: fixture.workflowId,
      agentBindingId: hiddenBindingId,
      title: 'Hidden Agent Session',
    });

    const viewerAccountId = '29292929-2929-4929-8929-292929292929';
    const viewerActor = {
      accountId: viewerAccountId,
      authSubject: 'local:agent-scoped-viewer',
    };
    await sql`
      INSERT INTO accounts (id, auth_subject, display_name)
      VALUES (${viewerAccountId}, ${viewerActor.authSubject}, 'Agent-scoped viewer')
    `;
    await sql`
      INSERT INTO workspace_members (workspace_id, account_id, role)
      VALUES (${fixture.workspaceId}, ${viewerAccountId}, 'viewer')
    `;
    await sql`
      INSERT INTO agent_access_grants (
        id, agent_id, account_id, role, granted_by_account_id
      ) VALUES (
        '30303030-3030-4030-8030-303030303030', ${fixture.agentId},
        ${viewerAccountId}, 'use', ${fixture.accountId}
      )
    `;

    const hydrated = await repository.hydrateWorkflow({
      actor: viewerActor,
      workflowId: fixture.workflowId,
    });
    expect(hydrated.blocks.map((block) => block.session.id)).toEqual([
      visibleSession.sessionId,
    ]);
    expect(hydrated.blocks.some((block) => block.session.id === hiddenSession.sessionId)).toBe(
      false,
    );
    expect(hydrated.edges).toEqual([]);
    expect(hydrated.anchors).toEqual([]);

    await sql`
      UPDATE agent_access_grants SET revoked_at = now()
      WHERE agent_id = ${fixture.agentId} AND account_id = ${viewerAccountId}
    `;
    await expect(
      repository.hydrateWorkflow({
        actor: viewerActor,
        workflowId: fixture.workflowId,
      }),
    ).resolves.toMatchObject({ blocks: [] });

    await expect(
      repository.loadSessionTranscript({
        actor: viewerActor,
        sessionId: hiddenSession.sessionId,
      }),
    ).rejects.toThrow(/unauthorized/i);
  });

  it('prepares trunk-anchored and exact-prefix message-fork Sessions with valid lineage', async () => {
    const fixture = await bootstrapFixture();
    const root = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '52525252-5252-4252-8252-525252525252',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Root for lineage',
    });
    const models = await repository.listAvailableModels({
      actor: fixture.actor,
      sessionId: root.sessionId,
    });
    const secondModel = models.find((model) => model.modelKey === 'deterministic-v2');
    if (!secondModel) throw new Error('Second fake model fixture is missing');
    await repository.updateSessionConfig({
      actor: fixture.actor,
      sessionId: root.sessionId,
      commandId: '53535353-5353-4353-8353-535353535353',
      expectedVersion: 1,
      modelEntryId: secondModel.id,
    });

    const messageIds = [
      '54545454-5454-4454-8454-545454545454',
      '55555555-5555-4555-8555-555555555555',
      '56565656-5656-4656-8656-565656565656',
    ] as const;
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${messageIds[0]}, ${fixture.workflowId}, ${root.sessionId}, 0, 'user',
        ${fixture.accountId}, ${sql.json({ text: 'first' })}, 'completed'
      )
    `;
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_agent_id, content, status
      ) VALUES (
        ${messageIds[1]}, ${fixture.workflowId}, ${root.sessionId}, 1, 'assistant',
        ${fixture.agentId}, ${sql.json({ text: 'é' })}, 'completed'
      )
    `;
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${messageIds[2]}, ${fixture.workflowId}, ${root.sessionId}, 2, 'user',
        ${fixture.accountId}, ${sql.json({ text: 'excluded' })}, 'completed'
      )
    `;
    await sql`
      UPDATE sessions SET transcript_version = 3, status = 'active'
      WHERE id = ${root.sessionId}
    `;
    await sql`
      INSERT INTO session_runtime_refs (
        id, session_id, agent_binding_id, external_session_ref, runtime_version,
        is_primary, status, sync_cursor, metadata
      ) VALUES (
        '57575757-5757-4757-8757-575757575757', ${root.sessionId},
        ${fixture.agentBindingId}, 'fake-session:root', 'deterministic-v1', true,
        'active', '{}'::jsonb, ${sql.json({ historyDigest: 'sha256:parent' })}
      )
    `;

    const anchored = await repository.prepareAnchoredSession({
      actor: fixture.actor,
      command: {
        kind: 'anchor-trunk',
        commandId: '58585858-5858-4858-8858-585858585858',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Anchored branch',
        agentBindingId: fixture.agentBindingId,
        anchor: {
          sourceKind: 'trunk-revision',
          sourceId: fixture.trunkRevisionId,
          selector: { kind: 'text-quote', exact: 'document' },
        },
      },
    });
    expect(anchored.config).toMatchObject({
      version: 1,
      modelEntryId: fixture.defaultModelEntryId,
    });

    const forkInput = {
      actor: fixture.actor,
      command: {
        kind: 'fork-message' as const,
        commandId: '59595959-5959-4959-8959-595959595959',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Message fork',
        parentSessionId: root.sessionId,
        atMessageId: messageIds[1],
        agentBindingId: fixture.agentBindingId,
        anchor: {
          sourceKind: 'message' as const,
          sourceId: messageIds[1],
          selector: { kind: 'text-quote' as const, exact: 'é' },
        },
      },
    };
    const fork = await repository.prepareFork(forkInput);
    expect(fork.parentSessionId).toBe(root.sessionId);
    expect(fork.parentExternalSessionRef).toBe('fake-session:root');
    expect(fork.expectedParentHistoryDigest).toBe('sha256:parent');
    expect(fork.config).toMatchObject({ version: 1, modelEntryId: secondModel.id });
    expect(fork.transcriptPrefix).toEqual([
      { canvasMessageId: messageIds[0], role: 'user', content: { text: 'first' } },
      { canvasMessageId: messageIds[1], role: 'assistant', content: { text: 'é' } },
    ]);

    const hydrated = await repository.hydrateWorkflow({
      actor: fixture.actor,
      workflowId: fixture.workflowId,
    });
    const anchoredBlock = hydrated.blocks.find(
      (block) => block.session.id === anchored.sessionId,
    );
    const forkBlock = hydrated.blocks.find((block) => block.session.id === fork.sessionId);
    expect(anchoredBlock?.session).toMatchObject({
      parentSessionId: null,
      forkAnchorId: anchored.anchorId,
    });
    expect(forkBlock?.session).toMatchObject({
      parentSessionId: root.sessionId,
      forkAnchorId: fork.anchorId,
    });
    expect(
      hydrated.edges.find((edge) => edge.targetSessionNodeId === anchored.nodeId),
    ).toMatchObject({ sourceSessionNodeId: null, anchorId: anchored.anchorId });
    expect(
      hydrated.edges.find((edge) => edge.targetSessionNodeId === fork.nodeId),
    ).toMatchObject({ sourceSessionNodeId: root.nodeId, anchorId: fork.anchorId });

    await repository.close();
    repository = createPostgresControlPlaneRepository(databaseUrl);
    const childTranscript = await repository.loadSessionTranscript({
      actor: fixture.actor,
      sessionId: fork.sessionId,
    });
    expect(childTranscript.map(({ id, role, content }) => ({ id, role, content }))).toEqual([
      { id: messageIds[0], role: 'user', content: { text: 'first' } },
      { id: messageIds[1], role: 'assistant', content: { text: 'é' } },
    ]);
    const reopenedHydration = await repository.hydrateWorkflow({
      actor: fixture.actor,
      workflowId: fixture.workflowId,
    });
    expect(
      reopenedHydration.blocks.find((block) => block.session.id === fork.sessionId)?.messages
        .map(({ id }) => id),
    ).toEqual([messageIds[0], messageIds[1]]);
    expect(
      reopenedHydration.blocks.find((block) => block.session.id === root.sessionId)?.session.status,
    ).toBe('active');

    await expect(
      repository.prepareFork({
        ...forkInput,
        command: {
          ...forkInput.command,
          commandId: '60606060-6060-4060-8060-606060606060',
          anchor: { ...forkInput.command.anchor, sourceId: messageIds[0] },
        },
      }),
    ).rejects.toThrow(/anchor.*atMessage/i);

    await sql`
      UPDATE messages SET content = ${sql.json({ text: 'e\u0301' })}
      WHERE id = ${messageIds[1]}
    `;
    await expect(repository.prepareFork(forkInput)).rejects.toThrow(/payload conflict/i);
  });

  it('rejects cross-workflow trunk, parent, and message lineage', async () => {
    const first = await bootstrapFixture();
    const firstRoot = await repository.createRootSession({
      actor: first.actor,
      commandId: '61616161-6161-4161-8161-616161616161',
      workflowId: first.workflowId,
      agentBindingId: first.agentBindingId,
      title: 'First workflow root',
    });
    const second = await repository.bootstrapLocalAlpha({
      commandId: '62626262-6262-4262-8262-626262626262',
      authSubject: 'local:second-workflow',
      displayName: 'Second owner',
      availableModels: [
        {
          providerKey: 'fake',
          modelKey: 'deterministic-v1',
          displayName: 'Deterministic v1',
        },
      ],
      defaultModelKey: 'deterministic-v1',
    });
    const secondActor = { accountId: second.accountId, authSubject: second.authSubject };
    const secondRoot = await repository.createRootSession({
      actor: secondActor,
      commandId: '63636363-6363-4363-8363-636363636363',
      workflowId: second.workflowId,
      agentBindingId: second.agentBindingId,
      title: 'Second workflow root',
    });
    const secondMessageId = '64646464-6464-4464-8464-646464646464';
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${secondMessageId}, ${second.workflowId}, ${secondRoot.sessionId}, 0, 'user',
        ${second.accountId}, ${sql.json({ text: 'foreign' })}, 'completed'
      )
    `;

    await expect(
      repository.prepareAnchoredSession({
        actor: first.actor,
        command: {
          kind: 'anchor-trunk',
          commandId: '65656565-6565-4565-8565-656565656565',
          workflowId: first.workflowId,
          sourceRevisionId: second.trunkRevisionId,
          title: 'Foreign trunk',
          agentBindingId: first.agentBindingId,
          anchor: {
            sourceKind: 'trunk-revision',
            sourceId: second.trunkRevisionId,
            selector: { kind: 'text-quote', exact: 'foreign' },
          },
        },
      }),
    ).rejects.toThrow(/lineage/i);
    await expect(
      repository.prepareFork({
        actor: first.actor,
        command: {
          kind: 'fork-message',
          commandId: '66666666-6666-4666-8666-666666666666',
          workflowId: first.workflowId,
          sourceRevisionId: first.trunkRevisionId,
          title: 'Foreign parent',
          parentSessionId: secondRoot.sessionId,
          atMessageId: secondMessageId,
          agentBindingId: first.agentBindingId,
          anchor: {
            sourceKind: 'message',
            sourceId: secondMessageId,
            selector: { kind: 'text-quote', exact: 'foreign' },
          },
        },
      }),
    ).rejects.toThrow(/lineage|unauthorized/i);
    await expect(
      repository.prepareFork({
        actor: first.actor,
        command: {
          kind: 'fork-message',
          commandId: '67676767-6767-4767-8767-676767676767',
          workflowId: first.workflowId,
          sourceRevisionId: first.trunkRevisionId,
          title: 'Foreign message',
          parentSessionId: firstRoot.sessionId,
          atMessageId: secondMessageId,
          agentBindingId: first.agentBindingId,
          anchor: {
            sourceKind: 'message',
            sourceId: secondMessageId,
            selector: { kind: 'text-quote', exact: 'foreign' },
          },
        },
      }),
    ).rejects.toThrow(/lineage/i);
  });

  it('freezes a fork prefix and preserves the complete ancestor prefix for a fork-of-fork', async () => {
    const fixture = await bootstrapFixture();
    const root = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '31313131-3131-4131-8131-313131313131',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Frozen root',
    });
    const rootMessageIds = [
      '32323232-3232-4232-8232-323232323232',
      '33333333-3333-4333-8333-333333333333',
    ] as const;
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${rootMessageIds[0]}, ${fixture.workflowId}, ${root.sessionId}, 0, 'user',
        ${fixture.accountId}, ${sql.json({ text: 'root user' })}, 'completed'
      )
    `;
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_agent_id, content, status
      ) VALUES (
        ${rootMessageIds[1]}, ${fixture.workflowId}, ${root.sessionId}, 1, 'assistant',
        ${fixture.agentId}, ${sql.json({ text: 'root answer' })}, 'completed'
      )
    `;
    await sql`
      UPDATE sessions SET transcript_version = 2, status = 'active'
      WHERE id = ${root.sessionId}
    `;
    await sql`
      INSERT INTO session_runtime_refs (
        id, session_id, agent_binding_id, external_session_ref, runtime_version,
        is_primary, status, metadata
      ) VALUES (
        '34343434-3434-4434-8434-343434343434', ${root.sessionId},
        ${fixture.agentBindingId}, 'fake-session:frozen-root', 'deterministic-v1', true,
        'active', ${sql.json({ historyDigest: 'sha256:frozen-root' })}
      )
    `;
    const child = await repository.prepareFork({
      actor: fixture.actor,
      command: {
        kind: 'fork-message',
        commandId: '35353535-3535-4535-8535-353535353535',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Frozen child',
        parentSessionId: root.sessionId,
        atMessageId: rootMessageIds[1],
        agentBindingId: fixture.agentBindingId,
        anchor: {
          sourceKind: 'message',
          sourceId: rootMessageIds[1],
          selector: { kind: 'text-quote', exact: 'root answer' },
        },
      },
    });

    await sql`
      UPDATE messages SET content = ${sql.json({ text: 'mutated after child birth' })}
      WHERE id = ${rootMessageIds[0]}
    `;
    const frozenAfterParentMutation = await repository.loadSessionTranscript({
      actor: fixture.actor,
      sessionId: child.sessionId,
    });
    expect(frozenAfterParentMutation.map(({ id, content }) => ({ id, content }))).toEqual([
      { id: rootMessageIds[0], content: { text: 'root user' } },
      { id: rootMessageIds[1], content: { text: 'root answer' } },
    ]);

    const childDirectMessageId = '36363636-3636-4636-8636-363636363636';
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${childDirectMessageId}, ${fixture.workflowId}, ${child.sessionId}, 2, 'user',
        ${fixture.accountId}, ${sql.json({ text: 'child direct' })}, 'completed'
      )
    `;
    await sql`
      UPDATE sessions SET transcript_version = 3, status = 'active'
      WHERE id = ${child.sessionId}
    `;
    await sql`
      INSERT INTO session_runtime_refs (
        id, session_id, agent_binding_id, external_session_ref, runtime_version,
        is_primary, status, metadata
      ) VALUES (
        '37373737-3737-4737-8737-373737373737', ${child.sessionId},
        ${fixture.agentBindingId}, 'fake-session:frozen-child', 'deterministic-v1', true,
        'active', ${sql.json({ historyDigest: 'sha256:frozen-child' })}
      )
    `;
    const grandchild = await repository.prepareFork({
      actor: fixture.actor,
      command: {
        kind: 'fork-message',
        commandId: '38383838-3838-4838-8838-383838383838',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Frozen grandchild',
        parentSessionId: child.sessionId,
        atMessageId: childDirectMessageId,
        agentBindingId: fixture.agentBindingId,
        anchor: {
          sourceKind: 'message',
          sourceId: childDirectMessageId,
          selector: { kind: 'text-quote', exact: 'child direct' },
        },
      },
    });
    expect(grandchild.transcriptPrefix.map(({ canvasMessageId }) => canvasMessageId)).toEqual([
      rootMessageIds[0],
      rootMessageIds[1],
      childDirectMessageId,
    ]);

    await repository.close();
    repository = createPostgresControlPlaneRepository(databaseUrl);
    const reopened = await repository.loadSessionTranscript({
      actor: fixture.actor,
      sessionId: grandchild.sessionId,
    });
    expect(reopened.map(({ id, content }) => ({ id, content }))).toEqual([
      { id: rootMessageIds[0], content: { text: 'root user' } },
      { id: rootMessageIds[1], content: { text: 'root answer' } },
      { id: childDirectMessageId, content: { text: 'child direct' } },
    ]);
  });

  it('rejects forged exact selectors without persisting partial lineage state', async () => {
    const fixture = await bootstrapFixture();
    const root = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '97979797-9797-4797-8797-979797979797',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Selector source',
    });
    const boundaryId = '98989898-9898-4898-8898-989898989898';
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${boundaryId}, ${fixture.workflowId}, ${root.sessionId}, 0, 'user',
        ${fixture.accountId}, ${sql.json({ text: 'real boundary text' })}, 'completed'
      )
    `;
    await sql`
      UPDATE sessions SET status = 'active', transcript_version = 1
      WHERE id = ${root.sessionId}
    `;
    await sql`
      INSERT INTO session_runtime_refs (
        id, session_id, agent_binding_id, external_session_ref, runtime_version,
        is_primary, status, metadata
      ) VALUES (
        '99999999-9999-4999-8999-999999999999', ${root.sessionId},
        ${fixture.agentBindingId}, 'fake-session:selector-source', 'deterministic-v1',
        true, 'active', ${sql.json({ historyDigest: 'sha256:selector-source' })}
      )
    `;
    const [before] = await sql<Record<string, number>[]>`
      SELECT
        (SELECT count(*)::integer FROM sessions) AS sessions,
        (SELECT count(*)::integer FROM branch_anchors) AS anchors,
        (SELECT count(*)::integer FROM command_receipts) AS receipts
    `;

    await expect(
      repository.prepareAnchoredSession({
        actor: fixture.actor,
        command: {
          kind: 'anchor-trunk',
          commandId: '10101010-1010-4010-8010-101010101010',
          workflowId: fixture.workflowId,
          sourceRevisionId: fixture.trunkRevisionId,
          title: 'Forged trunk quote',
          agentBindingId: fixture.agentBindingId,
          anchor: {
            sourceKind: 'trunk-revision',
            sourceId: fixture.trunkRevisionId,
            selector: { kind: 'text-quote', exact: 'not in the trunk' },
          },
        },
      }),
    ).rejects.toThrow(/selector exact.*does not match/i);
    await expect(
      repository.prepareFork({
        actor: fixture.actor,
        command: {
          kind: 'fork-message',
          commandId: '10202020-2020-4020-8020-202020202020',
          workflowId: fixture.workflowId,
          sourceRevisionId: fixture.trunkRevisionId,
          title: 'Forged message quote',
          parentSessionId: root.sessionId,
          atMessageId: boundaryId,
          agentBindingId: fixture.agentBindingId,
          anchor: {
            sourceKind: 'message',
            sourceId: boundaryId,
            selector: { kind: 'text-quote', exact: 'not in the message' },
          },
        },
      }),
    ).rejects.toThrow(/selector exact.*does not match/i);
    const [after] = await sql<Record<string, number>[]>`
      SELECT
        (SELECT count(*)::integer FROM sessions) AS sessions,
        (SELECT count(*)::integer FROM branch_anchors) AS anchors,
        (SELECT count(*)::integer FROM command_receipts) AS receipts
    `;
    expect(after).toEqual(before);
  });

  it('rejects fork prefixes containing incomplete messages or ordinal gaps', async () => {
    const fixture = await bootstrapFixture();

    async function createParent(
      commandId: string,
      title: string,
      externalSessionRef: string,
      runtimeRefId: string,
    ) {
      const parent = await repository.createRootSession({
        actor: fixture.actor,
        commandId,
        workflowId: fixture.workflowId,
        agentBindingId: fixture.agentBindingId,
        title,
      });
      await sql`
        UPDATE sessions SET status = 'active', transcript_version = 2
        WHERE id = ${parent.sessionId}
      `;
      await sql`
        INSERT INTO session_runtime_refs (
          id, session_id, agent_binding_id, external_session_ref, runtime_version,
          is_primary, status, metadata
        ) VALUES (
          ${runtimeRefId}, ${parent.sessionId}, ${fixture.agentBindingId},
          ${externalSessionRef}, 'deterministic-v1', true, 'active',
          ${sql.json({ historyDigest: `sha256:${externalSessionRef}` })}
        )
      `;
      return parent;
    }

    const incompleteParent = await createParent(
      '10303030-3030-4030-8030-303030303030',
      'Incomplete prefix parent',
      'fake-session:incomplete-prefix',
      '10404040-4040-4040-8040-404040404040',
    );
    const incompleteIds = [
      '10505050-5050-4050-8050-505050505050',
      '10606060-6060-4060-8060-606060606060',
    ] as const;
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES
        (
          ${incompleteIds[0]}, ${fixture.workflowId}, ${incompleteParent.sessionId}, 0,
          'user', ${fixture.accountId}, ${sql.json({ text: 'partial prefix' })}, 'partial'
        ),
        (
          ${incompleteIds[1]}, ${fixture.workflowId}, ${incompleteParent.sessionId}, 1,
          'user', ${fixture.accountId}, ${sql.json({ text: 'completed boundary' })},
          'completed'
        )
    `;
    await expect(
      repository.prepareFork({
        actor: fixture.actor,
        command: {
          kind: 'fork-message',
          commandId: '10707070-7070-4070-8070-707070707070',
          workflowId: fixture.workflowId,
          sourceRevisionId: fixture.trunkRevisionId,
          title: 'Incomplete prefix fork',
          parentSessionId: incompleteParent.sessionId,
          atMessageId: incompleteIds[1],
          agentBindingId: fixture.agentBindingId,
          anchor: {
            sourceKind: 'message',
            sourceId: incompleteIds[1],
            selector: { kind: 'text-quote', exact: 'completed boundary' },
          },
        },
      }),
    ).rejects.toThrow(/contiguous and fully completed/i);

    const gapParent = await createParent(
      '10808080-8080-4080-8080-808080808080',
      'Gap prefix parent',
      'fake-session:gap-prefix',
      '10909090-9090-4090-8090-909090909090',
    );
    const gapBoundaryId = '11010101-0101-4101-8101-010101010101';
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role, actor_account_id, content, status
      ) VALUES (
        ${gapBoundaryId}, ${fixture.workflowId}, ${gapParent.sessionId}, 1, 'user',
        ${fixture.accountId}, ${sql.json({ text: 'gap boundary' })}, 'completed'
      )
    `;
    await expect(
      repository.prepareFork({
        actor: fixture.actor,
        command: {
          kind: 'fork-message',
          commandId: '11111111-1111-4111-8111-111111111111',
          workflowId: fixture.workflowId,
          sourceRevisionId: fixture.trunkRevisionId,
          title: 'Gap prefix fork',
          parentSessionId: gapParent.sessionId,
          atMessageId: gapBoundaryId,
          agentBindingId: fixture.agentBindingId,
          anchor: {
            sourceKind: 'message',
            sourceId: gapBoundaryId,
            selector: { kind: 'text-quote', exact: 'gap boundary' },
          },
        },
      }),
    ).rejects.toThrow(/contiguous and fully completed/i);
  });

  it('grants one dispatch lease and atomically adopts a known Runtime Session after reopen', async () => {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '68686868-6868-4868-8868-686868686868',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Dispatch Session',
    });

    const leases = await Promise.all([
      repository.beginRuntimeDispatch({
        actor: fixture.actor,
        commandReceiptId: session.commandReceiptId,
      }),
      repository.beginRuntimeDispatch({
        actor: fixture.actor,
        commandReceiptId: session.commandReceiptId,
      }),
    ]);
    expect(leases.filter((lease) => lease.dispatchAllowed)).toHaveLength(1);
    expect(leases.every((lease) => lease.phase === 'runtime_dispatched')).toBe(true);

    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session:dispatch',
    });
    const [known] = await sql<{
      orchestration_phase: string;
      compensation_count: number;
      compensation_status: string;
    }[]>`
      SELECT receipt.orchestration_phase,
        count(compensation.id)::integer AS compensation_count,
        max(compensation.status) AS compensation_status
      FROM command_receipts receipt
      LEFT JOIN runtime_compensations compensation
        ON compensation.command_receipt_id = receipt.id
      WHERE receipt.id = ${session.commandReceiptId}
      GROUP BY receipt.id
    `;
    expect(known).toEqual({
      orchestration_phase: 'runtime_known',
      compensation_count: 1,
      compensation_status: 'pending',
    });

    await repository.close();
    repository = createPostgresControlPlaneRepository(databaseUrl);
    await repository.markRuntimeCommandReconciling({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session:dispatch',
      error: 'attach response lost',
    });
    await expect(
      repository.resolveRuntimeReconciliation({
        actor: fixture.actor,
        commandReceiptId: session.commandReceiptId,
        resolution: {
          kind: 'absent',
          evidence: { listSessions: 'incorrectly-missing' },
        },
      }),
    ).rejects.toThrow(/known external resource.*absent/i);
    const adopted = await repository.resolveRuntimeReconciliation({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      resolution: {
        kind: 'adopt-session',
        runtimeSession: {
          externalSessionRef: 'fake-session:dispatch',
          runtimeVersion: 'deterministic-v1',
          replayStatus: 'complete',
          historyDigest: 'sha256:dispatch-history',
          metadata: { source: 'reconciliation' },
        },
        evidence: { lookup: 'single-match' },
      },
    });
    expect(adopted).toMatchObject({ phase: 'attached', outcome: 'adopted' });
    await expect(
      repository.resolveRuntimeReconciliation({
        actor: fixture.actor,
        commandReceiptId: session.commandReceiptId,
        resolution: {
          kind: 'adopt-session',
          runtimeSession: {
            externalSessionRef: 'fake-session:dispatch',
            runtimeVersion: 'deterministic-v1',
            replayStatus: 'complete',
            historyDigest: 'sha256:dispatch-history',
            metadata: { source: 'reconciliation' },
          },
          evidence: { lookup: 'single-match' },
        },
      }),
    ).resolves.toMatchObject({ phase: 'attached' });

    await repository.markRuntimeCommandFailure({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      retryable: false,
      error: 'late failure must not regress attach',
    });
    await repository.markRuntimeCommandReconciling({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session:dispatch',
      error: 'late unknown must not regress attach',
    });
    const runtimeContext = await repository.getSessionRuntimeContext({
      actor: fixture.actor,
      sessionId: session.sessionId,
    });
    expect(runtimeContext).toMatchObject({
      sessionId: session.sessionId,
      externalSessionRef: 'fake-session:dispatch',
      expectedHistoryDigest: 'sha256:dispatch-history',
      status: 'active',
    });
    const [attached] = await sql<{
      orchestration_phase: string;
      compensation_status: string;
      refs: number;
    }[]>`
      SELECT receipt.orchestration_phase,
        max(compensation.status) AS compensation_status,
        count(runtime_ref.id)::integer AS refs
      FROM command_receipts receipt
      LEFT JOIN runtime_compensations compensation
        ON compensation.command_receipt_id = receipt.id
      LEFT JOIN session_runtime_refs runtime_ref
        ON runtime_ref.session_id = receipt.result_id
      WHERE receipt.id = ${session.commandReceiptId}
      GROUP BY receipt.id
    `;
    expect(attached).toEqual({
      orchestration_phase: 'attached',
      compensation_status: 'succeeded',
      refs: 1,
    });
  });

  it('atomically attaches a known Runtime Session on the normal command path', async () => {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '71717171-7171-4171-8171-717171717171',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Normal attach Session',
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
    });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session:normal-attach',
    });
    const attachInput = {
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      runtimeSession: {
        externalSessionRef: 'fake-session:normal-attach',
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete' as const,
        historyDigest: 'sha256:normal-attach',
        metadata: { source: 'normal' },
      },
    };
    await repository.attachRuntimeSession(attachInput);
    await expect(repository.attachRuntimeSession({ ...attachInput })).resolves.toBeUndefined();

    const [state] = await sql<{
      session_status: string;
      orchestration_phase: string;
      compensation_status: string;
      refs: number;
    }[]>`
      SELECT session.status AS session_status, receipt.orchestration_phase,
        compensation.status AS compensation_status,
        count(runtime_ref.id)::integer AS refs
      FROM command_receipts receipt
      JOIN sessions session ON session.id = receipt.result_id
      JOIN runtime_compensations compensation
        ON compensation.command_receipt_id = receipt.id
      LEFT JOIN session_runtime_refs runtime_ref ON runtime_ref.session_id = session.id
      WHERE receipt.id = ${session.commandReceiptId}
      GROUP BY session.status, receipt.orchestration_phase, compensation.status
    `;
    expect(state).toEqual({
      session_status: 'active',
      orchestration_phase: 'attached',
      compensation_status: 'succeeded',
      refs: 1,
    });
  });

  it('resolves absent resources to retryable and keeps unresolved lookup idempotent', async () => {
    const fixture = await bootstrapFixture();
    const absentSession = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '69696969-6969-4969-8969-696969696969',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Absent Session',
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: absentSession.commandReceiptId,
    });
    await repository.markRuntimeCommandReconciling({
      actor: fixture.actor,
      commandReceiptId: absentSession.commandReceiptId,
      externalResourceKind: 'session',
      lookupMetadata: { transport: 'timeout' },
      error: 'outcome unknown',
    });
    const absent = await repository.resolveRuntimeReconciliation({
      actor: fixture.actor,
      commandReceiptId: absentSession.commandReceiptId,
      resolution: {
        kind: 'absent',
        evidence: { listSessions: 'no-match' },
      },
    });
    expect(absent).toMatchObject({ phase: 'retryable_failure', outcome: 'absent' });
    await expect(
      repository.beginRuntimeDispatch({
        actor: fixture.actor,
        commandReceiptId: absentSession.commandReceiptId,
      }),
    ).resolves.toMatchObject({ phase: 'runtime_dispatched', dispatchAllowed: true });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: absentSession.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session:retry-after-absence',
    });
    await repository.attachRuntimeSession({
      actor: fixture.actor,
      commandReceiptId: absentSession.commandReceiptId,
      runtimeSession: {
        externalSessionRef: 'fake-session:retry-after-absence',
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete',
        historyDigest: 'sha256:retry-after-absence',
        metadata: { source: 'retry-after-absence' },
      },
    });
    await expect(
      repository.getSessionRuntimeContext({
        actor: fixture.actor,
        sessionId: absentSession.sessionId,
      }),
    ).resolves.toMatchObject({
      status: 'active',
      externalSessionRef: 'fake-session:retry-after-absence',
      expectedHistoryDigest: 'sha256:retry-after-absence',
    });
    const [retryCompensations] = await sql<{
      total: number;
      succeeded: number;
    }[]>`
      SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE status = 'succeeded')::integer AS succeeded
      FROM runtime_compensations
      WHERE command_receipt_id = ${absentSession.commandReceiptId}
    `;
    expect(retryCompensations).toEqual({ total: 2, succeeded: 2 });

    const unresolvedSession = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '70707070-7070-4070-8070-707070707070',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Unresolved Session',
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: unresolvedSession.commandReceiptId,
    });
    await repository.markRuntimeCommandReconciling({
      actor: fixture.actor,
      commandReceiptId: unresolvedSession.commandReceiptId,
      externalResourceKind: 'session',
      lookupMetadata: { transport: 'timeout' },
      error: 'outcome unknown',
    });
    const unresolvedInput = {
      actor: fixture.actor,
      commandReceiptId: unresolvedSession.commandReceiptId,
      resolution: {
        kind: 'unresolved' as const,
        evidence: { listSessions: 'ambiguous' },
        error: 'multiple candidates',
      },
    };
    const first = await repository.resolveRuntimeReconciliation(unresolvedInput);
    const replay = await repository.resolveRuntimeReconciliation({ ...unresolvedInput });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ phase: 'reconciling', outcome: 'unresolved' });
    const [compensation] = await sql<{
      attempts: number;
      status: string;
      resolution_evidence: Record<string, unknown>;
    }[]>`
      SELECT attempts, status, resolution_evidence
      FROM runtime_compensations
      WHERE command_receipt_id = ${unresolvedSession.commandReceiptId}
    `;
    expect(compensation).toEqual({
      attempts: 1,
      status: 'pending',
      resolution_evidence: { listSessions: 'ambiguous' },
    });
  });
});
