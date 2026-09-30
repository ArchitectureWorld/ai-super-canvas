import {
  getControlPlane,
  getLocalActorContext,
} from '@/server/control-plane';

import { makeRunEventsHandler } from '../../../handlers';
import { errorResponse, parseUuid } from '../../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId } = await params;
    const validatedRunId = parseUuid(runId);
    const [controlPlane, actor] = await Promise.all([
      getControlPlane(),
      getLocalActorContext(),
    ]);
    return makeRunEventsHandler({
      service: controlPlane.service,
      actor,
    })(request, { runId: validatedRunId });
  } catch (reason) {
    return errorResponse(reason);
  }
}
