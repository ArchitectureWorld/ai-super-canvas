import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);
const readRepositoryFile = (relativePath: string) =>
  readFile(new URL(relativePath, repositoryRoot), 'utf8');

const publicRepositoryFiles = [
  '.editorconfig',
  '.gitattributes',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
  '.github/workflows/codeql.yml',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/reviews/2026-07-22-deep-repository-review.md',
] as const;

describe('public repository standards', () => {
  it.each(publicRepositoryFiles)('tracks %s', async (relativePath) => {
    await expect(readRepositoryFile(relativePath)).resolves.not.toHaveLength(0);
  });

  it('documents the authoritative integration command and UI prototype limitation', async () => {
    const readme = await readRepositoryFile('README.md');

    expect(readme).toContain('pnpm test:integration:docker');
    expect(readme).toContain('localStorage prototype');
  });
});
