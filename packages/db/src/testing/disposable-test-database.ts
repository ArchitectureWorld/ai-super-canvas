export type DisposableDatabaseEnvironment = {
  allowTestDatabaseReset: string | undefined;
  nodeEnv: string | undefined;
};

const refusalMessage =
  'Refusing destructive reset outside isolated canvas_s1_test database';

export function assertDisposableTestDatabase(
  databaseUrl: string,
  environment: DisposableDatabaseEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    allowTestDatabaseReset: process.env.ALLOW_TEST_DATABASE_RESET,
  },
): void {
  let parsed: URL;

  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(refusalMessage);
  }

  if (
    environment.nodeEnv !== 'test' ||
    environment.allowTestDatabaseReset !== '1' ||
    parsed.hostname !== 'postgres-test' ||
    parsed.pathname !== '/canvas_s1_test'
  ) {
    throw new Error(refusalMessage);
  }
}
