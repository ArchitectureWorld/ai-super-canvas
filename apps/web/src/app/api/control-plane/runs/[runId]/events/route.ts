import {
  getControlPlane,
  getLocalActorContext,
} from '@/server/control-plane';

import { makeRunEventsHandler } from '../../../handlers';
import { errorResponse } from '../../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const [{ runId }, controlPlane, actor] = await Promise.all([
      params,
      getControlPlane(),
      getLocalActorContext(),
    ]);
    return makeRunEventsHandler({
      service: controlPlane.service,
      actor,
    })(request, { runId });
  } catch (reason) {
    return errorResponse(reason);
  }
}
