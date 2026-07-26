export interface ReadyHandlerDependencies {
  checkDatabase(): Promise<void>;
}

function readyResponse(
  body:
    | { status: 'ready'; database: 'ready' }
    | { status: 'not-ready'; database: 'unavailable' },
  status: 200 | 503,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function makeReadyHandler({
  checkDatabase,
}: ReadyHandlerDependencies): () => Promise<Response> {
  return async () => {
    try {
      await checkDatabase();
      return readyResponse(
        { status: 'ready', database: 'ready' },
        200,
      );
    } catch {
      return readyResponse(
        { status: 'not-ready', database: 'unavailable' },
        503,
      );
    }
  };
}
