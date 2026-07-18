import { describe, expect, it } from 'vitest';

import * as databasePackage from './index';

describe('@ai-super-canvas/db public entrypoint', () => {
  it('exports the control-plane repository factory', () => {
    expect(databasePackage).toHaveProperty(
      'createPostgresControlPlaneRepository',
      expect.any(Function),
    );
  });
});
