import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const composePath = fileURLToPath(
  new URL('../../../../compose.control-plane-test.yaml', import.meta.url),
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
});
