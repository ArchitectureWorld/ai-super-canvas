import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { createPostgresControlPlaneRepository } from '../repositories/postgres-control-plane-repository';
import { assertDisposableTestDatabase } from '../testing/disposable-test-database';

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for transcript migration integration tests');
}

assertDisposableTestDatabase(databaseUrl);

const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));

async function createLegacyMigrationsFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'canvas-transcript-migrations-'));
  try {
    const metaFolder = join(folder, 'meta');
    await mkdir(metaFolder);

    const journal = JSON.parse(
      await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as MigrationJournal;
    const legacyEntries = journal.entries.filter(({ idx }) => idx <= 7);
    if (
      legacyEntries.length !== 8
      || legacyEntries.at(-1)?.tag !== '0007_motionless_black_queen'
    ) {
      throw new Error('Expected the legacy migration chain to end at 0007');
    }

    await Promise.all(
      legacyEntries.map(({ tag }) =>
        copyFile(join(migrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`)),
      ),
    );
    await writeFile(
      join(metaFolder, '_journal.json'),
      `${JSON.stringify({ ...journal, entries: legacyEntries }, null, 2)}\n`,
    );

    return folder;
  } catch (error) {
    try {
      await rm(folder, { force: true, recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Failed to prepare and clean the legacy migrations folder',
      );
    }
    throw error;
  }
}

async function runCleanupOperations(
  operations: readonly (() => Promise<unknown>)[],
): Promise<void> {
  const errors: unknown[] = [];

  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      'Failed to clean transcript migration test resources',
    );
  }
}

describe('transcript_version migration', () => {
  it('upgrades legacy message frontiers without lowering empty or advanced Sessions', async () => {
    const databaseName =
      `canvas_s1_upgrade_${randomUUID().replaceAll('-', '')}`;
    const temporaryDatabaseUrl = new URL(databaseUrl);
    temporaryDatabaseUrl.pathname = `/${databaseName}`;
    const adminSql = postgres(databaseUrl, { max: 1 });
    let legacyMigrationsFolder: string | undefined;
    let databaseCreated = false;
    let upgradeSql: ReturnType<typeof postgres> | undefined;
    let repository:
      | ReturnType<typeof createPostgresControlPlaneRepository>
      | undefined;

    try {
      if (!/^canvas_s1_upgrade_[0-9a-f]{32}$/.test(databaseName)) {
        throw new Error('Unsafe temporary database name');
      }
      legacyMigrationsFolder = await createLegacyMigrationsFolder();
      await adminSql.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      upgradeSql = postgres(temporaryDatabaseUrl.toString(), { max: 2 });
      await migrate(drizzle(upgradeSql), {
        migrationsFolder: legacyMigrationsFolder,
      });

      repository = createPostgresControlPlaneRepository(
        temporaryDatabaseUrl.toString(),
      );
      const fixture = await repository.bootstrapLocalAlpha({
        commandId: randomUUID(),
        authSubject: `local:transcript-upgrade:${databaseName}`,
        displayName: 'Transcript migration owner',
        availableModels: [
          {
            providerKey: 'fake',
            modelKey: 'deterministic-v1',
            displayName: 'Deterministic v1',
            capabilities: { streaming: true },
          },
        ],
        defaultModelKey: 'deterministic-v1',
      });
      const actor = {
        accountId: fixture.accountId,
        authSubject: fixture.authSubject,
      };

      const createSession = (title: string) =>
        repository!.createRootSession({
          actor,
          commandId: randomUUID(),
          workflowId: fixture.workflowId,
          agentBindingId: fixture.agentBindingId,
          title,
        });
      const legacySession = await createSession('Legacy transcript');
      const emptySession = await createSession('Empty transcript');
      const advancedSession = await createSession('Advanced transcript counter');

      await repository.beginRuntimeDispatch({
        actor,
        commandReceiptId: legacySession.commandReceiptId,
      });
      const externalSessionRef = `fake-session:${legacySession.sessionId}`;
      await repository.recordRuntimeResourceKnown({
        actor,
        commandReceiptId: legacySession.commandReceiptId,
        externalResourceKind: 'session',
        externalResourceRef: externalSessionRef,
      });
      await repository.attachRuntimeSession({
        actor,
        commandReceiptId: legacySession.commandReceiptId,
        runtimeSession: {
          externalSessionRef,
          runtimeVersion: 'deterministic-v1',
          replayStatus: 'complete',
          historyDigest: 'sha256:legacy-transcript',
          metadata: { fixture: 'transcript-version-upgrade' },
        },
      });

      const appendLegacyMessage = async (
        sessionId: string,
        content: string,
      ): Promise<void> => {
        await upgradeSql!`
          INSERT INTO messages (
            id, workflow_id, session_id, ordinal, role,
            actor_account_id, content, status
          )
          SELECT
            ${randomUUID()}, ${fixture.workflowId}, ${sessionId},
            (COALESCE(MAX(ordinal), -1) + 1)::integer, 'user',
            ${fixture.accountId}, jsonb_build_object('text', ${content}::text), 'completed'
          FROM messages
          WHERE session_id = ${sessionId}
        `;
      };

      await appendLegacyMessage(legacySession.sessionId, 'legacy zero');
      await appendLegacyMessage(legacySession.sessionId, 'legacy one');
      await appendLegacyMessage(advancedSession.sessionId, 'advanced zero');
      await upgradeSql`
        UPDATE sessions
        SET transcript_version = 7
        WHERE id = ${advancedSession.sessionId}
      `;

      const loadCounters = async () => {
        const rows = await upgradeSql!<{
          id: string;
          transcript_version: number;
        }[]>`
          SELECT id, transcript_version
          FROM sessions
          WHERE id IN (
            ${legacySession.sessionId},
            ${emptySession.sessionId},
            ${advancedSession.sessionId}
          )
        `;
        return Object.fromEntries(
          rows.map(({ id, transcript_version }) => [id, transcript_version]),
        );
      };

      expect(await loadCounters()).toEqual({
        [legacySession.sessionId]: 0,
        [emptySession.sessionId]: 0,
        [advancedSession.sessionId]: 7,
      });

      await migrate(drizzle(upgradeSql), { migrationsFolder });

      expect(await loadCounters()).toEqual({
        [legacySession.sessionId]: 2,
        [emptySession.sessionId]: 0,
        [advancedSession.sessionId]: 7,
      });

      const prepared = await repository.prepareRun({
        actor,
        commandId: randomUUID(),
        idempotencyKey: `run:${randomUUID()}`,
        sessionId: legacySession.sessionId,
        content: 'first message after upgrade',
      });
      const [writeState] = await upgradeSql<{
        ordinal: number;
        transcript_version: number;
      }[]>`
        SELECT message.ordinal::integer AS ordinal, session.transcript_version
        FROM messages AS message
        JOIN sessions AS session ON session.id = message.session_id
        WHERE message.id = ${prepared.prompt.canvasMessageId}
      `;
      expect(writeState).toEqual({
        ordinal: 2,
        transcript_version: 3,
      });

      await migrate(drizzle(upgradeSql), { migrationsFolder });
      expect(await loadCounters()).toEqual({
        [legacySession.sessionId]: 3,
        [emptySession.sessionId]: 0,
        [advancedSession.sessionId]: 7,
      });
    } finally {
      await runCleanupOperations([
        async () => {
          if (repository) await repository.close();
        },
        async () => {
          if (upgradeSql) await upgradeSql.end();
        },
        async () => {
          if (databaseCreated) {
            await adminSql.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
          }
        },
        async () => {
          await adminSql.end();
        },
        async () => {
          if (legacyMigrationsFolder) {
            await rm(legacyMigrationsFolder, { force: true, recursive: true });
          }
        },
      ]);
    }
  }, 120_000);
});
