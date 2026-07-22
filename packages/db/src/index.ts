export const DB_PACKAGE_NAME = '@ai-super-canvas/db' as const;

export function requireDatabaseUrl(
  value: string | undefined = process.env.DATABASE_URL,
): string {
  if (!value) {
    throw new Error('DATABASE_URL is required');
  }

  return value;
}

export * from './repositories/control-plane-repository';
export * from './repositories/control-plane-run-types';
export * from './repositories/postgres-control-plane-repository';
