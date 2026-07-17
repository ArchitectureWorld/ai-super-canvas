import { describe, expect, it } from 'vitest';

import { assertDisposableTestDatabase } from './disposable-test-database';

const disposableUrl =
  'postgres://canvas_s1:canvas-test-password@postgres-test:5432/canvas_s1_test';

describe('assertDisposableTestDatabase', () => {
  it('accepts only the isolated control-plane test database', () => {
    expect(() =>
      assertDisposableTestDatabase(disposableUrl, {
        nodeEnv: 'test',
        allowTestDatabaseReset: '1',
      }),
    ).not.toThrow();
  });

  it.each([
    {
      name: 'non-test NODE_ENV',
      url: disposableUrl,
      nodeEnv: 'production',
      allowTestDatabaseReset: '1',
    },
    {
      name: 'missing reset opt-in',
      url: disposableUrl,
      nodeEnv: 'test',
      allowTestDatabaseReset: undefined,
    },
    {
      name: 'unexpected database host',
      url: 'postgres://canvas_s1:password@localhost:5432/canvas_s1_test',
      nodeEnv: 'test',
      allowTestDatabaseReset: '1',
    },
    {
      name: 'unexpected database name',
      url: 'postgres://canvas_s1:password@postgres-test:5432/production',
      nodeEnv: 'test',
      allowTestDatabaseReset: '1',
    },
  ])('rejects $name', ({ allowTestDatabaseReset, nodeEnv, url }) => {
    expect(() =>
      assertDisposableTestDatabase(url, {
        nodeEnv,
        allowTestDatabaseReset,
      }),
    ).toThrow('Refusing destructive reset outside isolated canvas_s1_test database');
  });
});
