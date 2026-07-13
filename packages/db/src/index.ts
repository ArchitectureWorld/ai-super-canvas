export const DB_PACKAGE_NAME = '@ai-super-canvas/db' as const;

export function requireDatabaseUrl(
  value: string | undefined = process.env.DATABASE_URL,
): string {
  if (!value) {
    throw new Error('DATABASE_URL is required');
  }

  return value;
}
