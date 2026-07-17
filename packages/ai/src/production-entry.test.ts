import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(packageRoot, 'src');

async function resolveRelativeModule(importer: string, specifier: string): Promise<string> {
  const target = resolve(dirname(importer), specifier);
  for (const candidate of [`${target}.ts`, resolve(target, 'index.ts')]) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // Try the next TypeScript module shape.
    }
  }
  throw new Error(`Unable to resolve ${specifier} from ${importer}`);
}

async function productionDependencyGraph(entry: string): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const pending = [entry];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (sources.has(current)) continue;
    const source = await readFile(current, 'utf8');
    sources.set(current, source);

    const relativeImports = source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g);
    for (const match of relativeImports) {
      pending.push(await resolveRelativeModule(current, match[1]!));
    }
  }

  return sources;
}

describe('production package entry', () => {
  it('keeps Vitest contract helpers behind the explicit testing subpath', async () => {
    const graph = await productionDependencyGraph(resolve(sourceRoot, 'index.ts'));
    const modules = [...graph.keys()].map((file) => relative(sourceRoot, file));
    const packageManifest = JSON.parse(
      await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as { exports: Record<string, string> };

    expect(modules).not.toContain('runtime/contract-suite.ts');
    expect([...graph.values()].some((source) => /from\s+['"]vitest['"]/.test(source))).toBe(false);
    expect(packageManifest.exports['./testing/runtime-contract'])
      .toBe('./src/runtime/contract-suite.ts');
  });
});
