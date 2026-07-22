import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const composePath = fileURLToPath(
  new URL('../../../../compose.control-plane-test.yaml', import.meta.url),
);
const packagePath = fileURLToPath(new URL('../../../../package.json', import.meta.url));
const integrationScriptPath = fileURLToPath(
  new URL('../../../../scripts/test-integration.sh', import.meta.url),
);

describe('control-plane test Compose isolation', () => {
  it('separates the migration owner from the non-owner application connection', async () => {
    const compose = await readFile(composePath, 'utf8');

    expect(compose).toContain('POSTGRES_USER: canvas_s1_migrator');
    expect(compose).toContain(
      'DATABASE_URL: postgres://canvas_s1_migrator:canvas-migrator-password@postgres-test:5432/canvas_s1_test',
    );
    expect(compose).toContain(
      'APP_DATABASE_URL: postgres://canvas_s1_app:canvas-app-password@postgres-test:5432/canvas_s1_test',
    );
    expect(compose).toContain(
      './packages/db/docker/init-test-app-role.sql:/docker-entrypoint-initdb.d/001-app-role.sql:ro',
    );
  });

  it('does not publish the PostgreSQL test port to the host', async () => {
    const compose = await readFile(composePath, 'utf8');

    expect(compose).not.toMatch(/^\s+ports:/m);
  });

  it('provides a disposable Docker integration command with lifecycle cleanup', async () => {
    const rootPackage = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(rootPackage.scripts['test:integration:docker']).toBe(
      'bash ./scripts/test-integration.sh',
    );

    const integrationScript = await readFile(integrationScriptPath, 'utf8');

    expect(integrationScript).toContain('run_id="${CI_RUN_ID:-local}"');
    expect(integrationScript).toContain(
      'run_id="${run_id//[^a-zA-Z0-9_-]/-}"',
    );
    expect(integrationScript).toContain('run_attempt="${CI_RUN_ATTEMPT:-0}"');
    expect(integrationScript).toContain(
      'run_attempt="${run_attempt//[^a-zA-Z0-9_-]/-}"',
    );
    expect(integrationScript).toContain('run_pid="$BASHPID"');
    expect(integrationScript).toContain(
      'project="${COMPOSE_PROJECT_NAME:-ai-super-canvas-s1-test-${run_id}-${run_attempt}-${run_pid}}"',
    );

    expect(integrationScript).toContain(
      'cleanup() { "${compose[@]}" down --volumes --remove-orphans; }',
    );
    expect(integrationScript).toContain('trap cleanup EXIT');
    expect(integrationScript).toContain('cleanup');
    expect(integrationScript).toContain('"${compose[@]}" up -d postgres-test');
    expect(integrationScript).toContain(
      '"${compose[@]}" run --rm --build test --filter @ai-super-canvas/db db:migrate',
    );
    expect(integrationScript).toContain(
      '"${compose[@]}" run --rm test test:integration',
    );
  });
});
