import { checkDatabaseReadiness } from '@/server/control-plane';

import { makeReadyHandler } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = makeReadyHandler({
  checkDatabase: checkDatabaseReadiness,
});
