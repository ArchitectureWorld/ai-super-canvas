import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { PersistableRunEvent } from './control-plane-run-types';
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

  async function prepareRuntimeRun(input: {
    suffix: string;
    content?: string;
    attachRun?: boolean;
  }) {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '70707070-1010-4010-8010-101010101010',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: `Runtime Run ${input.suffix}`,
    });
    const externalSessionRef = `fake-session-${input.suffix}`;
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
    });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: externalSessionRef,
    });
    await repository.attachRuntimeSession({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      runtimeSession: {
        externalSessionRef,
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete',
        historyDigest: `history-${input.suffix}`,
        metadata: { fixture: input.suffix },
      },
    });
    const prepared = await repository.prepareRun({
      actor: fixture.actor,
      commandId: '71717171-1010-4010-8010-101010101010',
      idempotencyKey: `run-${input.suffix}`,
      sessionId: session.sessionId,
      content: input.content ?? `Prompt ${input.suffix}`,
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
    });
    const externalRunRef = `fake-run-${input.suffix}`;
    if (input.attachRun !== false) {
      await repository.recordRuntimeResourceKnown({
        actor: fixture.actor,
        commandReceiptId: prepared.commandReceiptId,
        externalResourceKind: 'run',
        externalResourceRef: externalRunRef,
      });
      await repository.attachRuntimeRun({
        actor: fixture.actor,
        commandReceiptId: prepared.commandReceiptId,
        runtimeRun: {
          externalRunRef,
          acceptedAt: '2026-07-18T04:00:00.000Z',
        },
      });
    }
    return { fixture, session, prepared, externalSessionRef, externalRunRef };
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

  it('continues fork ordinals through a normal Run completion before a grandchild fork', async () => {
    const { fixture, session: root, prepared: rootRun } = await prepareRuntimeRun({
      suffix: 'fork-ordinal-root',
    });
    await repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: rootRun.runId,
      event: {
        runtimeEventKey: 'fork-ordinal-root-completed',
        eventType: 'run.completed',
        payload: { status: 'succeeded' },
        occurredAt: '2026-07-18T05:00:00.000Z',
        message: {
          role: 'assistant',
          content: { text: 'Root completion for fork' },
        },
        terminal: { status: 'succeeded' },
      },
    });
    const rootTranscript = await repository.loadSessionTranscript({
      actor: fixture.actor,
      sessionId: root.sessionId,
    });
    const rootBoundary = rootTranscript.at(-1)!;

    const child = await repository.prepareFork({
      actor: fixture.actor,
      command: {
        kind: 'fork-message',
        commandId: '81818181-8181-4181-8181-818181818181',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Ordinal child',
        parentSessionId: root.sessionId,
        atMessageId: rootBoundary.id,
        agentBindingId: fixture.agentBindingId,
        anchor: {
          sourceKind: 'message',
          sourceId: rootBoundary.id,
          selector: { kind: 'text-quote', exact: 'Root completion for fork' },
        },
      },
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: child.commandReceiptId,
    });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: child.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session:fork-ordinal-child',
    });
    await repository.attachRuntimeSession({
      actor: fixture.actor,
      commandReceiptId: child.commandReceiptId,
      runtimeSession: {
        externalSessionRef: 'fake-session:fork-ordinal-child',
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete',
        historyDigest: 'sha256:fork-ordinal-child',
        metadata: {},
      },
    });

    const childRun = await repository.prepareRun({
      actor: fixture.actor,
      commandId: '82828282-8282-4282-8282-828282828282',
      idempotencyKey: 'fork-ordinal-child-run',
      sessionId: child.sessionId,
      content: 'Child prompt after inherited prefix',
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: childRun.commandReceiptId,
    });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: childRun.commandReceiptId,
      externalResourceKind: 'run',
      externalResourceRef: 'fake-run:fork-ordinal-child',
    });
    await repository.attachRuntimeRun({
      actor: fixture.actor,
      commandReceiptId: childRun.commandReceiptId,
      runtimeRun: {
        externalRunRef: 'fake-run:fork-ordinal-child',
        acceptedAt: '2026-07-18T05:00:01.000Z',
      },
    });
    await repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: childRun.runId,
      event: {
        runtimeEventKey: 'fork-ordinal-child-completed',
        eventType: 'run.completed',
        payload: { status: 'succeeded' },
        occurredAt: '2026-07-18T05:00:02.000Z',
        message: {
          role: 'assistant',
          content: { text: 'Child completion for grandchild' },
        },
        terminal: { status: 'succeeded' },
      },
    });
    const childTranscript = await repository.loadSessionTranscript({
      actor: fixture.actor,
      sessionId: child.sessionId,
    });
    const childBoundary = childTranscript.at(-1)!;

    const grandchild = await repository.prepareFork({
      actor: fixture.actor,
      command: {
        kind: 'fork-message',
        commandId: '83838383-8383-4383-8383-838383838383',
        workflowId: fixture.workflowId,
        sourceRevisionId: fixture.trunkRevisionId,
        title: 'Ordinal grandchild',
        parentSessionId: child.sessionId,
        atMessageId: childBoundary.id,
        agentBindingId: fixture.agentBindingId,
        anchor: {
          sourceKind: 'message',
          sourceId: childBoundary.id,
          selector: { kind: 'text-quote', exact: 'Child completion for grandchild' },
        },
      },
    });
    expect(childTranscript.map((message) => message.ordinal)).toEqual([0, 1, 2, 3]);
    expect(grandchild.transcriptPrefix.map((message) => message.canvasMessageId)).toEqual(
      childTranscript.map((message) => message.id),
    );
    const [childState] = await sql<{ transcript_version: number }[]>`
      SELECT transcript_version FROM sessions WHERE id = ${child.sessionId}
    `;
    expect(childState?.transcript_version).toBe(4);
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

  it('returns an absent reconciled Run to a fresh dispatch lease', async () => {
    const { fixture, prepared } = await prepareRuntimeRun({
      suffix: 'run-absent-retry',
      attachRun: false,
    });
    await repository.markRuntimeCommandReconciling({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
      externalResourceKind: 'run',
      lookupMetadata: { transport: 'timeout' },
      error: 'Run dispatch outcome unknown',
    });
    await expect(repository.resolveRuntimeReconciliation({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
      resolution: {
        kind: 'absent',
        evidence: { listRuns: 'no-match' },
      },
    })).resolves.toEqual({ phase: 'retryable_failure', outcome: 'absent' });

    const [retryableState] = await sql<{
      phase: string;
      receipt_error: string | null;
      run_status: string;
      run_error: string | null;
      run_completed: Date | null;
      compensation_status: string;
    }[]>`
      SELECT receipt.orchestration_phase::text AS phase,
        receipt.last_error AS receipt_error, run.status::text AS run_status,
        run.error_message AS run_error, run.completed_at AS run_completed,
        compensation.status::text AS compensation_status
      FROM command_receipts receipt
      JOIN runs run ON run.id = receipt.result_id
      JOIN runtime_compensations compensation
        ON compensation.command_receipt_id = receipt.id
      WHERE receipt.id = ${prepared.commandReceiptId}
    `;
    await expect(repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
    })).resolves.toEqual({ phase: 'runtime_dispatched', dispatchAllowed: true });
    expect(retryableState).toMatchObject({
      phase: 'retryable_failure',
      receipt_error: null,
      run_status: 'failed',
      run_error: null,
      compensation_status: 'succeeded',
    });
    expect(retryableState?.run_completed).toBeInstanceOf(Date);

    const [leasedState] = await sql<{
      phase: string;
      run_status: string;
      run_error: string | null;
      run_completed: Date | null;
    }[]>`
      SELECT receipt.orchestration_phase::text AS phase,
        run.status::text AS run_status, run.error_message AS run_error,
        run.completed_at AS run_completed
      FROM command_receipts receipt
      JOIN runs run ON run.id = receipt.result_id
      WHERE receipt.id = ${prepared.commandReceiptId}
    `;
    expect(leasedState).toEqual({
      phase: 'runtime_dispatched',
      run_status: 'queued',
      run_error: null,
      run_completed: null,
    });
  });

  it('prepares one idempotent Run under concurrency and rejects payload or idempotency conflicts', async () => {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '10101010-1010-4010-8010-101010101010',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: '真实后端测试',
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
    });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session-repository-run',
    });
    await repository.attachRuntimeSession({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      runtimeSession: {
        externalSessionRef: 'fake-session-repository-run',
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete',
        historyDigest: 'empty-history-digest',
        metadata: {},
      },
    });

    const input = {
      actor: fixture.actor,
      commandId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'browser-run-1',
      sessionId: session.sessionId,
      content: '请返回确定性测试回复',
    } as const;
    const [first, replay] = await Promise.all([
      repository.prepareRun(input),
      repository.prepareRun({ ...input }),
    ]);

    expect(replay).toEqual(first);
    expect(first.phase).toBe('canvas_prepared');
    expect(first.status).toBe('queued');
    expect(first.prompt).toMatchObject({ role: 'user', content: input.content });
    expect(first.runtime.externalSessionRef).toBe('fake-session-repository-run');
    expect(first.runtime.model).toMatchObject({
      providerKey: 'fake',
      modelKey: 'deterministic-v1',
    });
    expect(first.runtime.toolPolicy).toEqual({
      allowedToolKeys: [],
      deniedToolKeys: [],
      approvalRequiredToolKeys: [],
    });

    await expect(
      repository.prepareRun({
        ...input,
        content: '同一个 commandId 的不同内容',
      }),
    ).rejects.toThrow(/payload conflict/i);
    const idempotencyError = await repository.prepareRun({
      ...input,
      commandId: '12121212-1212-4212-8212-121212121212',
      content: '同一个 idempotencyKey 的不同命令',
    }).then(() => null, (reason: unknown) => reason);
    expect(idempotencyError).toMatchObject({
      name: 'RunIdempotencyConflictError',
      code: 'run_idempotency_conflict',
      message: `Run idempotency conflict for ${input.idempotencyKey}`,
    });

    const [counts] = await sql<{
      messages: number;
      runs: number;
      receipts: number;
      start_run_receipts: number;
    }[]>`
      SELECT
        (SELECT count(*)::integer FROM messages
          WHERE session_id = ${session.sessionId}) AS messages,
        (SELECT count(*)::integer FROM runs
          WHERE session_id = ${session.sessionId}) AS runs,
        (SELECT count(*)::integer FROM command_receipts
          WHERE workflow_id = ${fixture.workflowId}
            AND command_key = ${input.commandId}) AS receipts,
        (SELECT count(*)::integer FROM command_receipts
          WHERE workflow_id = ${fixture.workflowId}
            AND command_type = 'start-run') AS start_run_receipts
    `;
    expect(counts).toEqual({
      messages: 1,
      runs: 1,
      receipts: 1,
      start_run_receipts: 1,
    });
  });

  it('rejects a second active Run with a stable domain error and no new state', async () => {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '45454545-1010-4010-8010-101010101010',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Active Run conflict Session',
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
    });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session-active-run-conflict',
    });
    await repository.attachRuntimeSession({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      runtimeSession: {
        externalSessionRef: 'fake-session-active-run-conflict',
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete',
        historyDigest: 'active-run-conflict-history',
        metadata: {},
      },
    });
    await repository.prepareRun({
      actor: fixture.actor,
      commandId: '46464646-1010-4010-8010-101010101010',
      idempotencyKey: 'first-active-run',
      sessionId: session.sessionId,
      content: 'Keep this Run queued',
    });
    const countState = async () => {
      const [counts] = await sql<{
        messages: number;
        runs: number;
        receipts: number;
      }[]>`
        SELECT
          (SELECT count(*)::integer FROM messages
            WHERE session_id = ${session.sessionId}) AS messages,
          (SELECT count(*)::integer FROM runs
            WHERE session_id = ${session.sessionId}) AS runs,
          (SELECT count(*)::integer FROM command_receipts
            WHERE workflow_id = ${fixture.workflowId}
              AND command_type = 'start-run') AS receipts
      `;
      return counts;
    };
    const before = await countState();

    const error = await repository.prepareRun({
      actor: fixture.actor,
      commandId: '47474747-1010-4010-8010-101010101010',
      idempotencyKey: 'second-active-run',
      sessionId: session.sessionId,
      content: 'This Run must not be created',
    }).then(() => null, (reason: unknown) => reason);

    expect(error).toMatchObject({
      name: 'ActiveRunConflictError',
      code: 'active_run_conflict',
      message: `Session ${session.sessionId} already has an active Run`,
    });
    expect(await countState()).toEqual(before);
  });

  it('maps Run unique-constraint races to stable domain errors', async () => {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '48484848-1010-4010-8010-101010101010',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Active Run race Session',
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
    });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session-active-run-race',
    });
    await repository.attachRuntimeSession({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      runtimeSession: {
        externalSessionRef: 'fake-session-active-run-race',
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete',
        historyDigest: 'active-run-race-history',
        metadata: {},
      },
    });
    const dormantMessageId = '49494949-1010-4010-8010-101010101010';
    const dormantRunId = '50505050-1010-4010-8010-101010101010';
    const [config] = await sql<{ id: string }[]>`
      SELECT id FROM session_config_revisions
      WHERE session_id = ${session.sessionId}
      ORDER BY version DESC
      LIMIT 1
    `;
    if (!config) throw new Error('Active Run race config fixture is missing');
    const [runtimeRef] = await sql<{
      id: string;
      external_session_ref: string;
      expected_history_digest: string;
    }[]>`
      SELECT id, external_session_ref,
        metadata->>'historyDigest' AS expected_history_digest
      FROM session_runtime_refs
      WHERE session_id = ${session.sessionId}
        AND agent_binding_id = ${fixture.agentBindingId}
        AND is_primary = true AND status = 'active'
    `;
    if (!runtimeRef) throw new Error('Active Run race Runtime ref fixture is missing');
    await sql`
      INSERT INTO messages (
        id, workflow_id, session_id, ordinal, role,
        actor_account_id, content, status
      ) VALUES (
        ${dormantMessageId}, ${fixture.workflowId}, ${session.sessionId}, 0,
        'user', ${fixture.accountId}, ${sql.json('Dormant race Run')}, 'completed'
      )
    `;
    await sql`
      UPDATE sessions SET transcript_version = 1 WHERE id = ${session.sessionId}
    `;
    await sql`
      INSERT INTO runs (
        id, session_id, agent_binding_id, config_revision_id,
        trigger_message_id, idempotency_key, status,
        runtime_session_ref_id, runtime_session_external_ref,
        expected_history_digest, runtime_binding_snapshot,
        model_snapshot, tool_policy_snapshot, context_policy_snapshot
      ) VALUES (
        ${dormantRunId}, ${session.sessionId}, ${fixture.agentBindingId}, ${config.id},
        ${dormantMessageId}, 'dormant-race-run', 'failed',
        ${runtimeRef.id}, ${runtimeRef.external_session_ref},
        ${runtimeRef.expected_history_digest},
        ${sql.json({
          canvasAgentBindingId: fixture.agentBindingId,
          agentId: fixture.agentId,
          runtimeKind: 'fake',
          isolationKey: 'local-alpha',
        })},
        ${sql.json({ providerKey: 'fake', modelKey: 'deterministic-v1' })},
        ${sql.json({
          allowedToolKeys: [],
          deniedToolKeys: [],
          approvalRequiredToolKeys: [],
        })}, '[]'::jsonb
      )
    `;

    const lockKey = 8_675_309;
    const lockSql = postgres(databaseUrl, { max: 1 });
    await sql.unsafe(`
      CREATE FUNCTION test_wait_before_run_message()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.content IN (
          to_jsonb('Force active Run fallback'::text),
          to_jsonb('Force idempotency fallback'::text)
        ) THEN
          PERFORM pg_advisory_xact_lock(${lockKey});
        END IF;
        RETURN NEW;
      END;
      $function$;
      CREATE TRIGGER test_wait_before_run_message
      BEFORE INSERT ON messages
      FOR EACH ROW
      EXECUTE FUNCTION test_wait_before_run_message();
    `);
    const forceConstraintRace = async (
      commandId: string,
      idempotencyKey: string,
      content: string,
      createConflict: () => Promise<unknown>,
    ) => {
      let released = false;
      let pending: Promise<unknown> | null = null;
      await lockSql`SELECT pg_advisory_lock(${lockKey})`;
      pending = repository.prepareRun({
        actor: fixture.actor,
        commandId,
        idempotencyKey,
        sessionId: session.sessionId,
        content,
      }).then(() => null, (reason: unknown) => reason);
      try {
        let waitingForAdvisoryLock = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const [waiting] = await sql<{ found: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory' AND granted = false
            ) AS found
          `;
          waitingForAdvisoryLock = waiting?.found ?? false;
          if (waitingForAdvisoryLock) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (waitingForAdvisoryLock) await createConflict();
        await lockSql`SELECT pg_advisory_unlock(${lockKey})`;
        released = true;
        return {
          error: await pending,
          waitingForAdvisoryLock,
        };
      } finally {
        if (!released) await lockSql`SELECT pg_advisory_unlock(${lockKey})`;
        await pending;
      }
    };
    try {
      const activeRace = await forceConstraintRace(
        '51515151-1010-4010-8010-101010101010',
        'active-run-fallback',
        'Force active Run fallback',
        () => sql`UPDATE runs SET status = 'queued' WHERE id = ${dormantRunId}`,
      );

      expect(activeRace.waitingForAdvisoryLock).toBe(true);
      expect(activeRace.error).toMatchObject({
        name: 'ActiveRunConflictError',
        code: 'active_run_conflict',
        message: `Session ${session.sessionId} already has an active Run`,
      });
      await sql`UPDATE runs SET status = 'failed' WHERE id = ${dormantRunId}`;

      const idempotencyRace = await forceConstraintRace(
        '52525252-1010-4010-8010-101010101010',
        'idempotency-fallback',
        'Force idempotency fallback',
        () => sql`
          UPDATE runs
          SET idempotency_key = 'idempotency-fallback'
          WHERE id = ${dormantRunId}
        `,
      );

      expect(idempotencyRace.waitingForAdvisoryLock).toBe(true);
      expect(idempotencyRace.error).toMatchObject({
        name: 'RunIdempotencyConflictError',
        code: 'run_idempotency_conflict',
        message: 'Run idempotency conflict for idempotency-fallback',
      });
    } finally {
      await lockSql.end();
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS test_wait_before_run_message ON messages;
        DROP FUNCTION IF EXISTS test_wait_before_run_message();
      `);
    }
  });

  it('rejects malformed stored Runtime tool policies without leaving Run state', async () => {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '13131313-1010-4010-8010-101010101010',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Malformed tool policy Session',
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
    });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session-malformed-tool-policy',
    });
    await repository.attachRuntimeSession({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      runtimeSession: {
        externalSessionRef: 'fake-session-malformed-tool-policy',
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete',
        historyDigest: 'malformed-tool-policy-history',
        metadata: {},
      },
    });

    async function attempt(
      commandId: string,
      idempotencyKey: string,
      toolPolicy: postgres.JSONValue,
    ) {
      if (toolPolicy === null) {
        await sql`
          UPDATE session_config_revisions
          SET tool_policy = 'null'::jsonb
          WHERE session_id = ${session.sessionId}
        `;
      } else {
        await sql`
          UPDATE session_config_revisions
          SET tool_policy = ${sql.json(toolPolicy)}
          WHERE session_id = ${session.sessionId}
        `;
      }
      const error = await repository.prepareRun({
        actor: fixture.actor,
        commandId,
        idempotencyKey,
        sessionId: session.sessionId,
        content: 'This Run must roll back',
      }).then(() => null, (reason: unknown) => reason);
      const [counts] = await sql<{
        messages: number;
        runs: number;
        receipts: number;
      }[]>`
        SELECT
          (SELECT count(*)::integer FROM messages
            WHERE session_id = ${session.sessionId}) AS messages,
          (SELECT count(*)::integer FROM runs
            WHERE session_id = ${session.sessionId}) AS runs,
          (SELECT count(*)::integer FROM command_receipts
            WHERE workflow_id = ${fixture.workflowId}
              AND command_type = 'start-run') AS receipts
      `;
      return { error, counts };
    }

    const jsonNull = await attempt(
      '14141414-1010-4010-8010-101010101010',
      'malformed-policy-null',
      null,
    );
    const invalidField = await attempt(
      '15151515-1010-4010-8010-101010101010',
      'malformed-policy-field',
      {
        allowedToolKeys: ['read'],
        deniedToolKeys: 'not-an-array',
        approvalRequiredToolKeys: [],
      },
    );

    for (const result of [jsonNull, invalidField]) {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe(
        'Stored Runtime tool policy is invalid',
      );
      expect(result.counts).toEqual({ messages: 0, runs: 0, receipts: 0 });
    }
  });

  it('replays current Run state and rejects corrupted persisted PreparedRun payloads', async () => {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '16161616-1010-4010-8010-101010101010',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Strict Run replay Session',
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
    });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session-strict-run-replay',
    });
    await repository.attachRuntimeSession({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      runtimeSession: {
        externalSessionRef: 'fake-session-strict-run-replay',
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete',
        historyDigest: 'strict-run-replay-history',
        metadata: {},
      },
    });
    const input = {
      actor: fixture.actor,
      commandId: '17171717-1010-4010-8010-101010101010',
      idempotencyKey: 'strict-run-replay',
      sessionId: session.sessionId,
      content: 'Replay this prepared Run strictly',
    } as const;
    const first = await repository.prepareRun(input);

    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: first.commandReceiptId,
    });
    await sql`UPDATE runs SET status = 'running' WHERE id = ${first.runId}`;
    await expect(repository.prepareRun({ ...input })).resolves.toMatchObject({
      phase: 'runtime_dispatched',
      status: 'running',
    });

    const [sourceReceipt] = await sql<{
      payload_hash: string;
      payload_canonical: string;
    }[]>`
      SELECT payload_hash, payload_canonical
      FROM command_receipts
      WHERE id = ${first.commandReceiptId}
    `;
    if (!sourceReceipt) throw new Error('Prepared Run receipt fixture is missing');
    const authoritativeTampering = [
      {
        receiptId: '39393939-1010-4010-8010-101010101010',
        commandId: '40404040-1010-4010-8010-101010101010',
        field: 'isolationKey',
        value: 'tampered-isolation-key',
      },
      {
        receiptId: '41414141-1010-4010-8010-101010101010',
        commandId: '42424242-1010-4010-8010-101010101010',
        field: 'externalSessionRef',
        value: 'tampered-external-session-ref',
      },
      {
        receiptId: '43434343-1010-4010-8010-101010101010',
        commandId: '44444444-1010-4010-8010-101010101010',
        field: 'expectedHistoryDigest',
        value: 'tampered-history-digest',
      },
    ] as const;
    const tamperingResults: unknown[] = [];
    for (const tampering of authoritativeTampering) {
      const runtime = tampering.field === 'isolationKey'
        ? {
            ...first.runtime,
            binding: {
              ...first.runtime.binding,
              isolationKey: tampering.value,
            },
          }
        : {
            ...first.runtime,
            [tampering.field]: tampering.value,
          };
      await sql`
        INSERT INTO command_receipts (
          id, workflow_id, account_id, command_key, command_type,
          payload_hash, payload_canonical, orchestration_phase,
          result_type, result_id, result_payload
        ) VALUES (
          ${tampering.receiptId}, ${fixture.workflowId}, ${fixture.accountId},
          ${tampering.commandId}, 'start-run', ${sourceReceipt.payload_hash},
          ${sourceReceipt.payload_canonical}, 'runtime_dispatched', 'run', ${first.runId},
          ${sql.json({
            ...first,
            commandReceiptId: tampering.receiptId,
            runtime,
          } as unknown as postgres.JSONValue)}
        )
      `;
      tamperingResults.push(await repository.prepareRun({
        ...input,
        commandId: tampering.commandId,
      }).then(() => null, (reason: unknown) => reason));
    }
    for (const result of tamperingResults) {
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(
        /invalid persisted Run command result payload/i,
      );
    }

    const corruptReceiptId = '18181818-1010-4010-8010-101010101010';
    const corruptCommandId = '19191919-1010-4010-8010-101010101010';
    await sql`
      INSERT INTO command_receipts (
        id, workflow_id, account_id, command_key, command_type,
        payload_hash, payload_canonical, orchestration_phase,
        result_type, result_id, result_payload
      ) VALUES (
        ${corruptReceiptId}, ${fixture.workflowId}, ${fixture.accountId},
        ${corruptCommandId}, 'start-run', ${sourceReceipt.payload_hash},
        ${sourceReceipt.payload_canonical}, 'runtime_dispatched', 'run', ${first.runId},
        ${sql.json({
          ...first,
          commandReceiptId: corruptReceiptId,
          prompt: {},
          runtime: {},
        })}
      )
    `;
    await expect(repository.prepareRun({
      ...input,
      commandId: corruptCommandId,
    })).rejects.toThrow(
      /invalid persisted Run command result payload/i,
    );

    const wrongTypeReceiptId = '20202020-1010-4010-8010-101010101010';
    const wrongTypeCommandId = '21212121-1010-4010-8010-101010101010';
    await sql`
      INSERT INTO command_receipts (
        id, workflow_id, account_id, command_key, command_type,
        payload_hash, payload_canonical, orchestration_phase,
        result_type, result_id, result_payload
      ) VALUES (
        ${wrongTypeReceiptId}, ${fixture.workflowId}, ${fixture.accountId},
        ${wrongTypeCommandId}, 'create-root-session', ${sourceReceipt.payload_hash},
        ${sourceReceipt.payload_canonical}, 'runtime_dispatched', 'run', ${first.runId},
        ${sql.json({
          ...first,
          commandReceiptId: wrongTypeReceiptId,
        } as unknown as postgres.JSONValue)}
      )
    `;
    await expect(repository.prepareRun({
      ...input,
      commandId: wrongTypeCommandId,
    })).rejects.toThrow(
      /invalid persisted Run command result payload/i,
    );

    const nullPayloadCommandId = '37373737-1010-4010-8010-101010101010';
    await sql`
      INSERT INTO command_receipts (
        id, workflow_id, account_id, command_key, command_type,
        payload_hash, payload_canonical, orchestration_phase,
        result_type, result_id, result_payload
      ) VALUES (
        '38383838-1010-4010-8010-101010101010', ${fixture.workflowId},
        ${fixture.accountId}, ${nullPayloadCommandId}, 'start-run',
        ${sourceReceipt.payload_hash}, ${sourceReceipt.payload_canonical},
        'runtime_dispatched', 'run', ${first.runId}, 'null'::jsonb
      )
    `;
    await expect(repository.prepareRun({
      ...input,
      commandId: nullPayloadCommandId,
    })).rejects.toThrow(/invalid persisted Run command result payload/i);
  });

  it('stores immutable Runtime Session identity and history digest on a prepared Run', async () => {
    const suffix = 'immutable-runtime-input';
    const {
      session,
      prepared,
      externalSessionRef,
    } = await prepareRuntimeRun({
      suffix,
      attachRun: false,
    });

    const [snapshot] = await sql<{
      expected_history_digest: string;
      runtime_binding_snapshot: Record<string, unknown>;
      runtime_session_external_ref: string;
      runtime_session_ref_id: string;
      source_runtime_session_ref_id: string;
    }[]>`
      SELECT run.expected_history_digest,
        run.runtime_binding_snapshot,
        run.runtime_session_external_ref,
        run.runtime_session_ref_id,
        runtime_ref.id AS source_runtime_session_ref_id
      FROM runs run
      JOIN session_runtime_refs runtime_ref
        ON runtime_ref.session_id = run.session_id
       AND runtime_ref.external_session_ref = ${externalSessionRef}
      WHERE run.id = ${prepared.runId}
        AND run.session_id = ${session.sessionId}
    `;

    expect(snapshot).toMatchObject({
      expected_history_digest: `history-${suffix}`,
      runtime_binding_snapshot: prepared.runtime.binding,
      runtime_session_external_ref: externalSessionRef,
    });
    expect(snapshot?.runtime_session_ref_id)
      .toBe(snapshot?.source_runtime_session_ref_id);
    expect(snapshot?.runtime_session_ref_id).toBeTruthy();

    await expect(sql`
      UPDATE runs
      SET runtime_session_ref_id = ${'00000000-0000-4000-8000-000000000001'}
      WHERE id = ${prepared.runId}
    `).rejects.toThrow(/Run Runtime input snapshot is immutable/i);
    await expect(sql`
      UPDATE runs
      SET runtime_session_external_ref = 'tampered-runtime-session-ref'
      WHERE id = ${prepared.runId}
    `).rejects.toThrow(/Run Runtime input snapshot is immutable/i);
    await expect(sql`
      UPDATE runs
      SET expected_history_digest = 'tampered-history-digest'
      WHERE id = ${prepared.runId}
    `).rejects.toThrow(/Run Runtime input snapshot is immutable/i);
    await expect(sql`
      UPDATE runs
      SET runtime_binding_snapshot = '{}'::jsonb
      WHERE id = ${prepared.runId}
    `).rejects.toThrow(/Run Runtime input snapshot is immutable/i);
  });

  it('replays a terminal Run from its immutable input after live history advances', async () => {
    const suffix = 'immutable-terminal-replay';
    const {
      fixture,
      session,
      prepared,
      externalSessionRef,
    } = await prepareRuntimeRun({ suffix });
    const input = {
      actor: fixture.actor,
      commandId: '71717171-1010-4010-8010-101010101010',
      idempotencyKey: `run-${suffix}`,
      sessionId: session.sessionId,
      content: `Prompt ${suffix}`,
    } as const;

    await repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        runtimeEventKey: 'immutable-terminal-completed',
        eventType: 'run.completed',
        payload: { status: 'succeeded' },
        occurredAt: '2026-07-24T00:00:00.000Z',
        terminal: { status: 'succeeded' },
      },
    });
    await repository.syncRuntimeSessionHistory({
      actor: fixture.actor,
      sessionId: session.sessionId,
      historyDigest: 'history-after-terminal-run',
    });
    await sql`
      UPDATE agent_bindings SET isolation_key = 'rotated-after-terminal'
      WHERE id = ${fixture.agentBindingId}
    `;

    await expect(repository.prepareRun({ ...input })).resolves.toMatchObject({
      commandReceiptId: prepared.commandReceiptId,
      phase: 'attached',
      status: 'succeeded',
      runtime: {
        externalSessionRef,
        expectedHistoryDigest: `history-${suffix}`,
        binding: {
          isolationKey: prepared.runtime.binding.isolationKey,
        },
      },
    });
  });

  it('replays terminal failure after the snapshotted Runtime Session ref errors', async () => {
    const suffix = 'immutable-session-not-found-replay';
    const {
      fixture,
      session,
      prepared,
      externalSessionRef,
    } = await prepareRuntimeRun({
      suffix,
      attachRun: false,
    });
    const input = {
      actor: fixture.actor,
      commandId: '71717171-1010-4010-8010-101010101010',
      idempotencyKey: `run-${suffix}`,
      sessionId: session.sessionId,
      content: `Prompt ${suffix}`,
    } as const;

    await repository.markRuntimeSessionUnavailable({
      actor: fixture.actor,
      sessionId: session.sessionId,
      error: 'runtime_adapter:session_not_found:not-applied',
    });
    await repository.markRuntimeCommandFailure({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
      retryable: false,
      error: 'runtime_adapter:session_not_found:not-applied',
    });

    await expect(repository.prepareRun({ ...input })).resolves.toMatchObject({
      commandReceiptId: prepared.commandReceiptId,
      phase: 'terminal_failure',
      status: 'failed',
      runtime: {
        externalSessionRef,
        expectedHistoryDigest: `history-${suffix}`,
      },
    });
  });

  it('freezes server-selected model, tool, and authorized context snapshots', async () => {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '34343434-1010-4010-8010-101010101010',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Server snapshot Session',
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
    });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session-server-snapshots',
    });
    await repository.attachRuntimeSession({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      runtimeSession: {
        externalSessionRef: 'fake-session-server-snapshots',
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete',
        historyDigest: 'server-snapshot-history',
        metadata: {},
      },
    });

    const [modelV2] = await sql<{ id: string }[]>`
      SELECT id FROM model_catalog_entries
      WHERE runtime_kind = 'fake'
        AND provider_key = 'fake'
        AND model_key = 'deterministic-v2'
    `;
    if (!modelV2) throw new Error('deterministic-v2 fixture is missing');
    const serverToolPolicy = {
      allowedToolKeys: ['search', 'read'],
      deniedToolKeys: ['shell'],
      approvalRequiredToolKeys: ['write'],
    };
    await sql`
      INSERT INTO session_config_revisions (
        id, session_id, version, model_entry_id, tool_policy,
        context_policy, created_by_account_id
      ) VALUES (
        '22222222-1010-4010-8010-101010101010', ${session.sessionId}, 2,
        ${modelV2.id}, ${sql.json(serverToolPolicy)}, '{}'::jsonb,
        ${fixture.accountId}
      )
    `;
    const otherAccountId = '23232323-1010-4010-8010-101010101010';
    await sql`
      INSERT INTO accounts (id, auth_subject, display_name)
      VALUES (${otherAccountId}, 'local:other-context-owner', 'Other context owner')
    `;
    await sql`
      INSERT INTO context_refs (
        id, account_id, agent_id, workflow_id, session_id,
        scope, visibility, source_kind, source_ref, snapshot, provenance, expires_at
      ) VALUES
        (
          '24242424-1010-4010-8010-101010101010', ${fixture.accountId}, NULL,
          NULL, NULL, 'account', 'private', 'repository-test',
          'context:account-private', ${sql.json({ label: 'account-private' })},
          ${sql.json({ fixture: 'account-private', sourceKind: 'forged', sourceRef: 'forged' })},
          NULL
        ),
        (
          '26262626-1010-4010-8010-101010101010', ${fixture.accountId},
          ${fixture.agentId}, NULL, NULL, 'agent', 'private', 'repository-test',
          'context:agent-private', ${sql.json({ label: 'agent-private' })},
          ${sql.json({ fixture: 'agent-private', sourceKind: 'forged', sourceRef: 'forged' })},
          NULL
        ),
        (
          '28282828-1010-4010-8010-101010101010', ${fixture.accountId}, NULL,
          ${fixture.workflowId}, NULL, 'workflow', 'private', 'repository-test',
          'context:workflow-private', ${sql.json({ label: 'workflow-private' })},
          ${sql.json({ fixture: 'workflow-private', sourceKind: 'forged', sourceRef: 'forged' })},
          NULL
        ),
        (
          '29292929-1010-4010-8010-101010101010', ${fixture.accountId}, NULL,
          ${fixture.workflowId}, NULL, 'workflow', 'workspace', 'repository-test',
          'context:workflow-workspace', ${sql.json({ label: 'workflow-workspace' })},
          ${sql.json({ fixture: 'workflow-workspace', sourceKind: 'forged', sourceRef: 'forged' })},
          NULL
        ),
        (
          '30303030-1010-4010-8010-101010101010', ${fixture.accountId}, NULL,
          ${fixture.workflowId}, ${session.sessionId}, 'session', 'private',
          'repository-test', 'context:session-private',
          ${sql.json({ label: 'session-private' })},
          ${sql.json({ fixture: 'session-private', sourceKind: 'forged', sourceRef: 'forged' })},
          NULL
        ),
        (
          '31313131-1010-4010-8010-101010101010', ${fixture.accountId}, NULL,
          ${fixture.workflowId}, ${session.sessionId}, 'session', 'workspace',
          'repository-test', 'context:session-workspace',
          ${sql.json({ label: 'session-workspace' })},
          ${sql.json({ fixture: 'session-workspace', sourceKind: 'forged', sourceRef: 'forged' })},
          NULL
        ),
        (
          '32323232-1010-4010-8010-101010101010', ${fixture.accountId}, NULL,
          ${fixture.workflowId}, ${session.sessionId}, 'session', 'private',
          'repository-test', 'context:expired', ${sql.json({ label: 'expired' })},
          ${sql.json({ fixture: 'expired' })}, now() - interval '1 minute'
        ),
        (
          '33333333-1010-4010-8010-101010101010', ${otherAccountId}, NULL,
          ${fixture.workflowId}, NULL, 'workflow', 'private', 'repository-test',
          'context:other-private', ${sql.json({ label: 'other-private' })},
          ${sql.json({ fixture: 'other-private' })}, NULL
        )
    `;

    const expectedContext = [
      ['24242424-1010-4010-8010-101010101010', 'account', 'private', 'account-private'],
      ['26262626-1010-4010-8010-101010101010', 'agent', 'private', 'agent-private'],
      ['28282828-1010-4010-8010-101010101010', 'workflow', 'private', 'workflow-private'],
      ['29292929-1010-4010-8010-101010101010', 'workflow', 'workspace', 'workflow-workspace'],
      ['30303030-1010-4010-8010-101010101010', 'session', 'private', 'session-private'],
      ['31313131-1010-4010-8010-101010101010', 'session', 'workspace', 'session-workspace'],
    ].map(([canvasContextRefId, scope, visibility, label]) => ({
      canvasContextRefId,
      scope,
      visibility,
      content: { label },
      provenance: {
        fixture: label,
        sourceKind: 'repository-test',
        sourceRef: `context:${label}`,
      },
    }));
    const input = {
      actor: fixture.actor,
      commandId: '35353535-1010-4010-8010-101010101010',
      idempotencyKey: 'server-snapshot-run',
      sessionId: session.sessionId,
      content: 'Use only server-selected snapshots',
    } as const;
    const forgedInput = {
      ...input,
      model: { providerKey: 'caller', modelKey: 'forged' },
      toolPolicy: { allowedToolKeys: ['dangerous-caller-tool'] },
      context: [{ content: 'caller-forged-context' }],
    };
    const prepared = await repository.prepareRun(forgedInput);

    expect(prepared.runtime.model).toEqual({
      providerKey: 'fake',
      modelKey: 'deterministic-v2',
    });
    expect(prepared.runtime.toolPolicy).toEqual(serverToolPolicy);
    expect(prepared.runtime.context).toEqual(expectedContext);
    const [snapshots] = await sql<{
      model_snapshot: unknown;
      tool_policy_snapshot: unknown;
      context_snapshot: unknown;
    }[]>`
      SELECT model_snapshot, tool_policy_snapshot,
        context_policy_snapshot AS context_snapshot
      FROM runs
      WHERE id = ${prepared.runId}
    `;
    expect(snapshots).toEqual({
      model_snapshot: prepared.runtime.model,
      tool_policy_snapshot: serverToolPolicy,
      context_snapshot: expectedContext,
    });

    await sql`
      INSERT INTO session_config_revisions (
        id, session_id, version, model_entry_id, tool_policy,
        context_policy, created_by_account_id
      ) VALUES (
        '36363636-1010-4010-8010-101010101010', ${session.sessionId}, 3,
        ${fixture.defaultModelEntryId}, ${sql.json({
          allowedToolKeys: [],
          deniedToolKeys: [],
          approvalRequiredToolKeys: [],
        })}, '{}'::jsonb, ${fixture.accountId}
      )
    `;
    await sql`DELETE FROM context_refs`;
    await expect(repository.prepareRun({ ...input })).resolves.toEqual(prepared);
  });

  it('attaches a Runtime Run and atomically projects message and terminal events', async () => {
    const fixture = await bootstrapFixture();
    const session = await repository.createRootSession({
      actor: fixture.actor,
      commandId: '60606060-1010-4010-8010-101010101010',
      workflowId: fixture.workflowId,
      agentBindingId: fixture.agentBindingId,
      title: 'Runtime event projection Session',
    });
    await repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
    });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      externalResourceKind: 'session',
      externalResourceRef: 'fake-session-runtime-events',
    });
    await repository.attachRuntimeSession({
      actor: fixture.actor,
      commandReceiptId: session.commandReceiptId,
      runtimeSession: {
        externalSessionRef: 'fake-session-runtime-events',
        runtimeVersion: 'deterministic-v1',
        replayStatus: 'complete',
        historyDigest: 'runtime-events-history',
        metadata: {},
      },
    });
    const prepared = await repository.prepareRun({
      actor: fixture.actor,
      commandId: '61616161-1010-4010-8010-101010101010',
      idempotencyKey: 'runtime-event-projection',
      sessionId: session.sessionId,
      content: 'Project this Runtime response',
    });
    await expect(repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
    })).resolves.toEqual({ phase: 'runtime_dispatched', dispatchAllowed: true });
    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
      externalResourceKind: 'run',
      externalResourceRef: 'fake-run-runtime-events',
    });
    await repository.attachRuntimeRun({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
      runtimeRun: {
        externalRunRef: 'fake-run-runtime-events',
        acceptedAt: '2026-07-18T03:00:00.000Z',
      },
    });

    const message = await repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        runtimeEventKey: 'event-message-1',
        eventType: 'assistant.message',
        payload: { delta: 'Runtime response' },
        externalEventRef: 'runtime-event-ref-1',
        occurredAt: '2026-07-18T03:00:01.000Z',
        message: {
          role: 'assistant',
          content: { text: 'Runtime response' },
          externalMessageRef: 'runtime-message-ref-1',
        },
      },
    });
    const terminal = await repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        runtimeEventKey: 'event-terminal-1',
        eventType: 'run.completed',
        payload: { status: 'succeeded' },
        occurredAt: '2026-07-18T03:00:02.000Z',
        terminal: { status: 'succeeded' },
      },
    });

    expect(message).toMatchObject({
      runId: prepared.runId,
      sequence: 1,
      runtimeEventKey: 'event-message-1',
      occurredAt: '2026-07-18T03:00:01.000Z',
    });
    expect(terminal).toMatchObject({
      runId: prepared.runId,
      sequence: 2,
      runtimeEventKey: 'event-terminal-1',
      occurredAt: '2026-07-18T03:00:02.000Z',
    });
    await expect(repository.loadSessionTranscript({
      actor: fixture.actor,
      sessionId: session.sessionId,
    })).resolves.toMatchObject([
      { role: 'user', content: 'Project this Runtime response' },
      {
        role: 'assistant',
        content: { text: 'Runtime response' },
        runId: prepared.runId,
        sourceRuntimeEventKey: 'event-message-1',
      },
    ]);
    const [state] = await sql<{
      run_status: string;
      runtime_run_ref: string | null;
      receipt_phase: string;
      receipt_payload: unknown;
    }[]>`
      SELECT run.status::text AS run_status, run.runtime_run_ref,
        receipt.orchestration_phase::text AS receipt_phase,
        receipt.result_payload AS receipt_payload
      FROM runs run
      JOIN command_receipts receipt ON receipt.result_id = run.id
      WHERE run.id = ${prepared.runId}
    `;
    expect(state).toMatchObject({
      run_status: 'succeeded',
      runtime_run_ref: 'fake-run-runtime-events',
      receipt_phase: 'attached',
      receipt_payload: prepared,
    });
  });

  it('bounds Runtime event pagination to an explicit maximum page size', async () => {
    const { fixture, prepared } = await prepareRuntimeRun({ suffix: 'event-pagination' });
    for (const index of [1, 2, 3]) {
      await repository.ingestRuntimeEvent({
        actor: fixture.actor,
        runId: prepared.runId,
        event: {
          runtimeEventKey: `page-key-${index}`,
          eventType: 'assistant.delta',
          payload: { index },
          occurredAt: `2026-07-18T03:30:0${index}.000Z`,
        },
      });
    }

    await expect(repository.listRunEvents({
      actor: fixture.actor,
      runId: prepared.runId,
      after: 0,
      limit: 2,
    })).resolves.toHaveLength(2);
    await expect(repository.listRunEvents({
      actor: fixture.actor,
      runId: prepared.runId,
      after: 0,
      limit: 0,
    })).rejects.toThrow('Run event limit must be an integer between 1 and 100');
    await expect(repository.listRunEvents({
      actor: fixture.actor,
      runId: prepared.runId,
      after: 0,
      limit: 101,
    })).rejects.toThrow('Run event limit must be an integer between 1 and 100');
  });

  it('snapshots a caller-owned Runtime event before waiting for the Run lock', async () => {
    const { fixture, prepared, session } = await prepareRuntimeRun({
      suffix: 'event-input-snapshot',
    });
    const originalEvent: PersistableRunEvent = {
      runtimeEventKey: 'snapshot-key',
      eventType: 'run.completed',
      payload: { phase: 'original' },
      occurredAt: '2026-07-18T03:45:01.000Z',
      message: {
        role: 'assistant',
        content: { text: 'original message' },
      },
      terminal: { status: 'succeeded' },
    };
    const callerEvent = structuredClone(originalEvent);
    const lockSql = postgres(databaseUrl, { max: 1 });
    let markLockAcquired!: () => void;
    let releaseRunLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      markLockAcquired = resolve;
    });
    const runLockReleased = new Promise<void>((resolve) => {
      releaseRunLock = resolve;
    });
    const lockTransaction = lockSql.begin(async (tx) => {
      await tx`SELECT id FROM runs WHERE id = ${prepared.runId} FOR UPDATE`;
      markLockAcquired();
      await runLockReleased;
    });
    await lockAcquired;

    const ingestion = repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: prepared.runId,
      event: callerEvent,
    });
    try {
      let waitingForRunLock = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [waiting] = await sql<{ found: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE locktype IN ('tuple', 'transactionid') AND granted = false
          ) AS found
        `;
        waitingForRunLock = waiting?.found ?? false;
        if (waitingForRunLock) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waitingForRunLock).toBe(true);

      callerEvent.payload = { phase: 'mutated' };
      if (!callerEvent.message || !callerEvent.terminal) {
        throw new Error('Mutable Runtime event fixture is incomplete');
      }
      callerEvent.message.content = { text: 'mutated message' };
      callerEvent.terminal.status = 'failed';
      callerEvent.terminal.errorCode = 'mutated_after_call';
      callerEvent.terminal.errorMessage = 'Caller mutated the event while ingestion waited';

      releaseRunLock();
      await lockTransaction;
      const stored = await ingestion;
      expect(stored.payload).toEqual({ phase: 'original' });
      await expect(repository.loadSessionTranscript({
        actor: fixture.actor,
        sessionId: session.sessionId,
      })).resolves.toMatchObject([
        { role: 'user' },
        { role: 'assistant', content: { text: 'original message' } },
      ]);
      const [runState] = await sql<{
        status: string;
        error_code: string | null;
        error_message: string | null;
      }[]>`
        SELECT status::text AS status, error_code, error_message
        FROM runs
        WHERE id = ${prepared.runId}
      `;
      expect(runState).toEqual({
        status: 'succeeded',
        error_code: null,
        error_message: null,
      });
      await expect(repository.ingestRuntimeEvent({
        actor: fixture.actor,
        runId: prepared.runId,
        event: originalEvent,
      })).resolves.toEqual(stored);
    } finally {
      releaseRunLock();
      await Promise.allSettled([lockTransaction, ingestion]);
      await lockSql.end();
    }
  });

  it('deduplicates Runtime event keys, preserves distinct deltas, paginates, and freezes terminal Runs', async () => {
    const { fixture, prepared } = await prepareRuntimeRun({ suffix: 'event-idempotency' });
    const firstInput = {
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        runtimeEventKey: 'message-key',
        eventType: 'assistant.message',
        payload: { value: 'same-content' },
        occurredAt: '2026-07-18T04:00:01.000Z',
        message: { role: 'assistant' as const, content: { text: 'one message' } },
      },
    };
    const first = await repository.ingestRuntimeEvent(firstInput);
    await expect(repository.ingestRuntimeEvent({
      ...firstInput,
      event: {
        ...firstInput.event,
        payload: { value: 'conflicting-replay-payload' },
      },
    })).rejects.toMatchObject({ code: 'runtime_event_conflict' });
    await expect(repository.ingestRuntimeEvent({
      ...firstInput,
      event: {
        ...firstInput.event,
        message: { role: 'assistant', content: { text: 'conflicting message' } },
      },
    })).rejects.toMatchObject({ code: 'runtime_event_conflict' });
    await expect(repository.ingestRuntimeEvent({
      ...firstInput,
      event: {
        ...firstInput.event,
        terminal: {
          status: 'failed',
          errorCode: 'runtime_conflict',
          errorMessage: 'conflicting terminal envelope',
        },
      },
    })).rejects.toMatchObject({ code: 'runtime_event_conflict' });
    const [unchangedReplayRows] = await sql<{ events: number; messages: number }[]>`
      SELECT
        (SELECT count(*)::integer FROM run_events
          WHERE run_id = ${prepared.runId}) AS events,
        (SELECT count(*)::integer FROM messages
          WHERE run_id = ${prepared.runId}) AS messages
    `;
    expect(unchangedReplayRows).toEqual({ events: 1, messages: 1 });

    const second = await repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        runtimeEventKey: 'delta-key-1',
        eventType: 'assistant.delta',
        payload: { value: 'same-content' },
        occurredAt: '2026-07-18T04:00:02.000Z',
      },
    });
    const third = await repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        runtimeEventKey: 'delta-key-2',
        eventType: 'assistant.delta',
        payload: { value: 'same-content' },
        occurredAt: '2026-07-18T04:00:03.000Z',
      },
    });
    const terminalInput = {
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        runtimeEventKey: 'terminal-key',
        eventType: 'run.completed',
        payload: { status: 'succeeded' },
        occurredAt: '2026-07-18T04:00:04.000Z',
        terminal: { status: 'succeeded' as const },
      },
    };
    const terminal = await repository.ingestRuntimeEvent(terminalInput);

    expect([first.sequence, second.sequence, third.sequence, terminal.sequence]).toEqual([
      1, 2, 3, 4,
    ]);
    await expect(repository.ingestRuntimeEvent(terminalInput)).resolves.toEqual(terminal);
    await expect(repository.ingestRuntimeEvent(firstInput)).resolves.toEqual(first);
    await expect(repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        runtimeEventKey: 'late-key',
        eventType: 'assistant.delta',
        payload: { late: true },
        occurredAt: '2026-07-18T04:00:05.000Z',
      },
    })).rejects.toThrow('Run is terminal and cannot accept a new Runtime event');
    await expect(repository.listRunEvents({
      actor: fixture.actor,
      runId: prepared.runId,
      after: 1,
    })).resolves.toMatchObject([
      { sequence: 2, runtimeEventKey: 'delta-key-1' },
      { sequence: 3, runtimeEventKey: 'delta-key-2' },
      { sequence: 4, runtimeEventKey: 'terminal-key' },
    ]);
    await expect(repository.listRunEvents({
      actor: fixture.actor,
      runId: prepared.runId,
      after: -1,
    })).rejects.toThrow(/non-negative safe integer/i);
    const [counts] = await sql<{ events: number; messages: number }[]>`
      SELECT
        (SELECT count(*)::integer FROM run_events
          WHERE run_id = ${prepared.runId}) AS events,
        (SELECT count(*)::integer FROM messages
          WHERE run_id = ${prepared.runId}) AS messages
    `;
    expect(counts).toEqual({ events: 4, messages: 1 });
  });

  it('rolls back both event and Message when Runtime message JSON serialization fails', async () => {
    const { fixture, prepared } = await prepareRuntimeRun({ suffix: 'event-rollback' });
    const eventBase = {
      runtimeEventKey: 'rollback-key',
      eventType: 'assistant.message',
      payload: { stage: 'inserted-before-message' },
      occurredAt: '2026-07-18T04:10:01.000Z',
    };
    await expect(repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        ...eventBase,
        message: { role: 'assistant', content: 1n as never },
      },
    })).rejects.toThrow();
    const [rolledBack] = await sql<{ events: number; messages: number }[]>`
      SELECT
        (SELECT count(*)::integer FROM run_events
          WHERE run_id = ${prepared.runId}) AS events,
        (SELECT count(*)::integer FROM messages
          WHERE run_id = ${prepared.runId}) AS messages
    `;
    expect(rolledBack).toEqual({ events: 0, messages: 0 });

    await expect(repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        ...eventBase,
        message: { role: 'assistant', content: { text: 'valid retry' } },
      },
    })).resolves.toMatchObject({ sequence: 1, runtimeEventKey: 'rollback-key' });
  });

  it('serializes concurrent Runtime events to unique contiguous Run sequences', async () => {
    const { fixture, prepared } = await prepareRuntimeRun({ suffix: 'event-concurrency' });
    const stored = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      repository.ingestRuntimeEvent({
        actor: fixture.actor,
        runId: prepared.runId,
        event: {
          runtimeEventKey: `concurrent-${index}`,
          eventType: 'assistant.delta',
          payload: { index },
          occurredAt: `2026-07-18T04:20:0${index}.000Z`,
        },
      })
    )));
    expect(stored.map((event) => event.sequence).sort((left, right) => left - right)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    await expect(repository.listRunEvents({
      actor: fixture.actor,
      runId: prepared.runId,
      after: 0,
    })).resolves.toSatisfy((events: Array<{ sequence: number }>) => (
      events.map((event) => event.sequence).join(',') === '1,2,3,4,5,6,7,8'
    ));
  });

  it('requires complete Runtime refs, keeps Run attach idempotent, and authorizes viewer reads', async () => {
    const { fixture, prepared, externalRunRef, externalSessionRef } = await prepareRuntimeRun({
      suffix: 'runtime-context',
      attachRun: false,
    });
    await expect(repository.getRunRuntimeContext({
      actor: fixture.actor,
      runId: prepared.runId,
    })).rejects.toThrow('Run Runtime context is incomplete');

    await repository.recordRuntimeResourceKnown({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
      externalResourceKind: 'run',
      externalResourceRef: externalRunRef,
    });
    const attachment = {
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
      runtimeRun: {
        externalRunRef,
        acceptedAt: '2026-07-18T04:30:00.000Z',
      },
    };
    await repository.attachRuntimeRun(attachment);
    await expect(repository.attachRuntimeRun({ ...attachment })).resolves.toBeUndefined();
    await expect(repository.attachRuntimeRun({
      ...attachment,
      runtimeRun: { ...attachment.runtimeRun, externalRunRef: 'conflicting-run-ref' },
    })).rejects.toThrow(/conflicts/i);

    const viewerAccountId = '72727272-1010-4010-8010-101010101010';
    const viewer = { accountId: viewerAccountId, authSubject: 'local:runtime-context-viewer' };
    await sql`
      INSERT INTO accounts (id, auth_subject, display_name)
      VALUES (${viewerAccountId}, ${viewer.authSubject}, 'Runtime context viewer')
    `;
    await sql`
      INSERT INTO workspace_members (workspace_id, account_id, role)
      VALUES (${fixture.workspaceId}, ${viewerAccountId}, 'viewer')
    `;
    await sql`
      INSERT INTO agent_access_grants (
        id, agent_id, account_id, role, granted_by_account_id
      ) VALUES (
        '73737373-1010-4010-8010-101010101010', ${fixture.agentId},
        ${viewerAccountId}, 'use', ${fixture.accountId}
      )
    `;
    await expect(repository.getRunRuntimeContext({
      actor: viewer,
      runId: prepared.runId,
    })).resolves.toEqual({
      actor: viewer,
      workflowId: fixture.workflowId,
      sessionId: prepared.sessionId,
      runId: prepared.runId,
      status: 'running',
      binding: prepared.runtime.binding,
      externalSessionRef,
      externalRunRef,
    });
    await expect(repository.getRunRuntimeContext({
      actor: { accountId: fixture.accountId, authSubject: 'local:wrong-subject' },
      runId: prepared.runId,
    })).rejects.toThrow('Unauthorized control-plane operation');
  });

  it('terminalizes proven dispatch failures but keeps unknown Runtime effects active', async () => {
    const { fixture, prepared } = await prepareRuntimeRun({
      suffix: 'command-run-state',
      attachRun: false,
    });
    await repository.markRuntimeCommandFailure({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
      retryable: true,
      error: 'dispatch-timeout',
    });
    let [state] = await sql<{
      phase: string;
      receipt_error: string | null;
      run_status: string;
      run_error: string | null;
      run_completed: Date | null;
    }[]>`
      SELECT receipt.orchestration_phase::text AS phase,
        receipt.last_error AS receipt_error, run.status::text AS run_status,
        run.error_message AS run_error, run.completed_at AS run_completed
      FROM command_receipts receipt
      JOIN runs run ON run.id = receipt.result_id
      WHERE receipt.id = ${prepared.commandReceiptId}
    `;
    expect(state).toMatchObject({
      phase: 'retryable_failure',
      receipt_error: 'dispatch-timeout',
      run_status: 'failed',
      run_error: 'dispatch-timeout',
    });
    expect(state?.run_completed).toBeInstanceOf(Date);

    await expect(repository.beginRuntimeDispatch({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
    })).resolves.toEqual({ phase: 'runtime_dispatched', dispatchAllowed: true });
    [state] = await sql`
      SELECT receipt.orchestration_phase::text AS phase,
        receipt.last_error AS receipt_error, run.status::text AS run_status,
        run.error_message AS run_error, run.completed_at AS run_completed
      FROM command_receipts receipt
      JOIN runs run ON run.id = receipt.result_id
      WHERE receipt.id = ${prepared.commandReceiptId}
    `;
    expect(state).toMatchObject({
      phase: 'runtime_dispatched',
      receipt_error: null,
      run_status: 'queued',
      run_error: null,
      run_completed: null,
    });

    await repository.markRuntimeCommandReconciling({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
      externalResourceKind: 'run',
      error: 'dispatch-response-lost',
    });
    [state] = await sql`
      SELECT receipt.orchestration_phase::text AS phase,
        receipt.last_error AS receipt_error, run.status::text AS run_status,
        run.error_message AS run_error, run.completed_at AS run_completed
      FROM command_receipts receipt
      JOIN runs run ON run.id = receipt.result_id
      WHERE receipt.id = ${prepared.commandReceiptId}
    `;
    expect(state).toMatchObject({
      phase: 'reconciling',
      receipt_error: 'dispatch-response-lost',
      run_status: 'reconciling',
      run_error: 'dispatch-response-lost',
      run_completed: null,
    });

    await repository.markRuntimeCommandFailure({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
      retryable: true,
      error: 'reconciliation-failed',
    });
    [state] = await sql`
      SELECT receipt.orchestration_phase::text AS phase,
        receipt.last_error AS receipt_error, run.status::text AS run_status,
        run.error_message AS run_error, run.completed_at AS run_completed
      FROM command_receipts receipt
      JOIN runs run ON run.id = receipt.result_id
      WHERE receipt.id = ${prepared.commandReceiptId}
    `;
    expect(state).toMatchObject({
      phase: 'reconciling',
      receipt_error: 'reconciliation-failed',
      run_status: 'reconciling',
      run_error: 'reconciliation-failed',
      run_completed: null,
    });
    await expect(repository.prepareRun({
      actor: fixture.actor,
      commandId: '77777777-1010-4010-8010-101010101010',
      idempotencyKey: 'replacement-after-command-failure',
      sessionId: prepared.sessionId,
      content: 'Replacement after failed dispatch',
    })).rejects.toMatchObject({ code: 'active_run_conflict' });
  });

  it('treats a Runtime command failure after Run attachment as a strict no-op', async () => {
    const { fixture, prepared, externalRunRef } = await prepareRuntimeRun({
      suffix: 'late-attached-failure',
    });
    await repository.markRuntimeCommandFailure({
      actor: fixture.actor,
      commandReceiptId: prepared.commandReceiptId,
      retryable: false,
      error: 'late failure after attach',
    });

    const [state] = await sql<{
      phase: string;
      receipt_error: string | null;
      run_status: string;
      run_error: string | null;
      run_completed: Date | null;
      runtime_run_ref: string | null;
    }[]>`
      SELECT receipt.orchestration_phase::text AS phase,
        receipt.last_error AS receipt_error, run.status::text AS run_status,
        run.error_message AS run_error, run.completed_at AS run_completed,
        run.runtime_run_ref
      FROM command_receipts receipt
      JOIN runs run ON run.id = receipt.result_id
      WHERE receipt.id = ${prepared.commandReceiptId}
    `;
    expect(state).toEqual({
      phase: 'attached',
      receipt_error: null,
      run_status: 'running',
      run_error: null,
      run_completed: null,
      runtime_run_ref: externalRunRef,
    });
    await expect(repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        runtimeEventKey: 'late-attached-failure-completed',
        eventType: 'run.completed',
        payload: { status: 'succeeded' },
        occurredAt: '2026-07-18T06:00:00.000Z',
        terminal: { status: 'succeeded' },
      },
    })).resolves.toMatchObject({
      runtimeEventKey: 'late-attached-failure-completed',
    });
  });

  it('loads a consistent Session snapshot and persists Runtime history and unavailable state', async () => {
    const { fixture, session, prepared, externalSessionRef } = await prepareRuntimeRun({
      suffix: 'session-snapshot',
    });
    await repository.syncRuntimeSessionHistory({
      actor: fixture.actor,
      sessionId: session.sessionId,
      historyDigest: 'history-snapshot-updated',
    });
    await expect(repository.loadSessionSnapshot({
      actor: fixture.actor,
      sessionId: session.sessionId,
    })).resolves.toMatchObject({
      sessionId: session.sessionId,
      status: 'active',
      messages: [{ role: 'user', content: 'Prompt session-snapshot' }],
      activeRun: { runId: prepared.runId, status: 'running' },
      runtimeRef: { externalSessionRef, status: 'active' },
    });
    const [synced] = await sql<{ history_digest: string }[]>`
      SELECT metadata->>'historyDigest' AS history_digest
      FROM session_runtime_refs
      WHERE session_id = ${session.sessionId} AND is_primary = true
    `;
    expect(synced?.history_digest).toBe('history-snapshot-updated');

    await repository.markRunReconciling({
      actor: fixture.actor,
      runId: prepared.runId,
      error: 'event-pump-gap',
    });
    await repository.markRuntimeSessionUnavailable({
      actor: fixture.actor,
      sessionId: session.sessionId,
      error: 'runtime-offline',
    });
    await expect(repository.loadSessionSnapshot({
      actor: fixture.actor,
      sessionId: session.sessionId,
    })).resolves.toMatchObject({
      activeRun: { runId: prepared.runId, status: 'reconciling' },
      runtimeRef: { externalSessionRef, status: 'error' },
    });
    const [state] = await sql<{
      run_error: string | null;
      runtime_error: string | null;
    }[]>`
      SELECT run.error_message AS run_error,
        runtime_ref.metadata->>'lastError' AS runtime_error
      FROM runs run
      JOIN session_runtime_refs runtime_ref ON runtime_ref.session_id = run.session_id
      WHERE run.id = ${prepared.runId} AND runtime_ref.is_primary = true
    `;
    expect(state).toEqual({ run_error: 'event-pump-gap', runtime_error: 'runtime-offline' });
    await expect(repository.syncRuntimeSessionHistory({
      actor: fixture.actor,
      sessionId: session.sessionId,
      historyDigest: 'must-not-sync-error-ref',
    })).rejects.toThrow(/active primary Runtime reference/i);

    const viewerAccountId = '74747474-1010-4010-8010-101010101010';
    const viewer = { accountId: viewerAccountId, authSubject: 'local:snapshot-viewer' };
    await sql`
      INSERT INTO accounts (id, auth_subject, display_name)
      VALUES (${viewerAccountId}, ${viewer.authSubject}, 'Snapshot viewer')
    `;
    await sql`
      INSERT INTO workspace_members (workspace_id, account_id, role)
      VALUES (${fixture.workspaceId}, ${viewerAccountId}, 'viewer')
    `;
    await sql`
      INSERT INTO agent_access_grants (
        id, agent_id, account_id, role, granted_by_account_id
      ) VALUES (
        '75757575-1010-4010-8010-101010101010', ${fixture.agentId},
        ${viewerAccountId}, 'use', ${fixture.accountId}
      )
    `;
    await expect(repository.loadSessionSnapshot({
      actor: viewer,
      sessionId: session.sessionId,
    })).resolves.toMatchObject({ sessionId: session.sessionId });
    await expect(repository.markRuntimeSessionUnavailable({
      actor: viewer,
      sessionId: session.sessionId,
      error: 'viewer-cannot-write',
    })).rejects.toThrow('Unauthorized control-plane operation');
  });

  it('reconciles only orphaned active Runs and reports the actual update count', async () => {
    const { prepared } = await prepareRuntimeRun({ suffix: 'orphan-reconciliation' });
    const terminalRunId = '76767676-1010-4010-8010-101010101010';
    await sql`
      INSERT INTO runs (
        id, session_id, agent_binding_id, config_revision_id, trigger_message_id,
        idempotency_key, status, runtime_run_ref, model_snapshot,
        tool_policy_snapshot, context_policy_snapshot, completed_at,
        runtime_session_ref_id, runtime_session_external_ref,
        expected_history_digest, runtime_binding_snapshot
      )
      SELECT ${terminalRunId}, session_id, agent_binding_id, config_revision_id,
        trigger_message_id, 'terminal-control', 'succeeded', 'terminal-runtime-ref',
        model_snapshot, tool_policy_snapshot, context_policy_snapshot, now(),
        runtime_session_ref_id, runtime_session_external_ref,
        expected_history_digest, runtime_binding_snapshot
      FROM runs WHERE id = ${prepared.runId}
    `;

    await expect(repository.reconcileOrphanedRuns()).resolves.toBe(1);
    await expect(repository.reconcileOrphanedRuns()).resolves.toBe(0);
    const states = await sql<{
      id: string;
      status: string;
      error_message: string | null;
    }[]>`
      SELECT id, status::text AS status, error_message
      FROM runs
      WHERE id IN (${prepared.runId}, ${terminalRunId})
      ORDER BY id
    `;
    expect(states).toEqual([
      {
        id: prepared.runId,
        status: 'reconciling',
        error_message: 'event_pump_missing_after_restart',
      },
      { id: terminalRunId, status: 'succeeded', error_message: null },
    ].sort((left, right) => left.id.localeCompare(right.id)));
  });

  it('allows viewer reads while rejecting viewer and outsider Runtime state writes', async () => {
    const { fixture, session, prepared } = await prepareRuntimeRun({
      suffix: 'runtime-authorization',
    });
    await repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        runtimeEventKey: 'authorization-event',
        eventType: 'assistant.delta',
        payload: { visible: true },
        occurredAt: '2026-07-18T05:00:00.000Z',
      },
    });
    const viewerAccountId = '78787878-1010-4010-8010-101010101010';
    const viewer = { accountId: viewerAccountId, authSubject: 'local:runtime-viewer' };
    await sql`
      INSERT INTO accounts (id, auth_subject, display_name)
      VALUES (${viewerAccountId}, ${viewer.authSubject}, 'Runtime viewer')
    `;
    await sql`
      INSERT INTO workspace_members (workspace_id, account_id, role)
      VALUES (${fixture.workspaceId}, ${viewerAccountId}, 'viewer')
    `;
    await sql`
      INSERT INTO agent_access_grants (
        id, agent_id, account_id, role, granted_by_account_id
      ) VALUES (
        '79797979-1010-4010-8010-101010101010', ${fixture.agentId},
        ${viewerAccountId}, 'use', ${fixture.accountId}
      )
    `;

    await expect(repository.listRunEvents({
      actor: viewer,
      runId: prepared.runId,
      after: 0,
    })).resolves.toMatchObject([{ runtimeEventKey: 'authorization-event' }]);
    await expect(repository.loadSessionSnapshot({
      actor: viewer,
      sessionId: session.sessionId,
    })).resolves.toMatchObject({ sessionId: session.sessionId });
    await expect(repository.ingestRuntimeEvent({
      actor: viewer,
      runId: prepared.runId,
      event: {
        runtimeEventKey: 'viewer-write',
        eventType: 'assistant.delta',
        payload: {},
        occurredAt: '2026-07-18T05:00:01.000Z',
      },
    })).rejects.toThrow('Unauthorized control-plane operation');
    await expect(repository.syncRuntimeSessionHistory({
      actor: viewer,
      sessionId: session.sessionId,
      historyDigest: 'viewer-write',
    })).rejects.toThrow('Unauthorized control-plane operation');
    await expect(repository.markRuntimeSessionUnavailable({
      actor: viewer,
      sessionId: session.sessionId,
      error: 'viewer-write',
    })).rejects.toThrow('Unauthorized control-plane operation');
    await expect(repository.markRunReconciling({
      actor: viewer,
      runId: prepared.runId,
      error: 'viewer-write',
    })).rejects.toThrow('Unauthorized control-plane operation');

    const outsider = {
      accountId: '80808080-1010-4010-8010-101010101010',
      authSubject: 'local:runtime-outsider',
    };
    await sql`
      INSERT INTO accounts (id, auth_subject, display_name)
      VALUES (${outsider.accountId}, ${outsider.authSubject}, 'Runtime outsider')
    `;
    await expect(repository.listRunEvents({
      actor: outsider,
      runId: prepared.runId,
      after: 0,
    })).rejects.toThrow('Unauthorized control-plane operation');
    await expect(repository.loadSessionSnapshot({
      actor: outsider,
      sessionId: session.sessionId,
    })).rejects.toThrow('Unauthorized control-plane operation');
  });

  it('never regresses a terminal Run back to reconciliation', async () => {
    const { fixture, prepared } = await prepareRuntimeRun({
      suffix: 'terminal-reconciliation',
    });
    await repository.ingestRuntimeEvent({
      actor: fixture.actor,
      runId: prepared.runId,
      event: {
        runtimeEventKey: 'terminal-failure',
        eventType: 'run.failed',
        payload: { error: 'runtime-failure' },
        occurredAt: '2026-07-18T05:10:00.000Z',
        terminal: {
          status: 'failed',
          errorCode: 'runtime_failure',
          errorMessage: 'runtime-failure',
        },
      },
    });
    await expect(repository.markRunReconciling({
      actor: fixture.actor,
      runId: prepared.runId,
      error: 'must-not-regress',
    })).rejects.toMatchObject({
      name: 'RunStateConflictError',
      code: 'run_state_conflict',
    });
    const [run] = await sql<{ status: string; error_message: string | null }[]>`
      SELECT status::text AS status, error_message
      FROM runs WHERE id = ${prepared.runId}
    `;
    expect(run).toEqual({ status: 'failed', error_message: 'runtime-failure' });
  });
});
