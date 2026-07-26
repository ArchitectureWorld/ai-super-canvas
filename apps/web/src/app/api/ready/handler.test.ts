import { describe, expect, it, vi } from 'vitest';

import { makeReadyHandler } from './handler';

describe('ready handler', () => {
  it('returns a no-store ready response after the database probe succeeds', async () => {
    const checkDatabase = vi.fn(async () => undefined);
    const handler = makeReadyHandler({ checkDatabase });

    const response = await handler();

    expect(checkDatabase).toHaveBeenCalledExactlyOnceWith();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      status: 'ready',
      database: 'ready',
    });
  });

  it('returns a sanitized no-store unavailable response when the probe fails', async () => {
    const secret = 'postgres://canvas:super-secret@database/canvas';
    const handler = makeReadyHandler({
      checkDatabase: vi.fn(async () => {
        throw new Error(secret);
      }),
    });

    const response = await handler();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(body)).toEqual({
      status: 'not-ready',
      database: 'unavailable',
    });
    expect(body).not.toContain(secret);
  });
});
