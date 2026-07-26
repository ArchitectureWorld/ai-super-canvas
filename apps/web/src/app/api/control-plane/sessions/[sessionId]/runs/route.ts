import {
  getControlPlane,
  getLocalActorContext,
} from '@/server/control-plane';

import { makeStartRunHandler } from '../../../handlers';
import { errorResponse, parseUuid } from '../../../http';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  try {
    const { sessionId } = await params;
    const validatedSessionId = parseUuid(sessionId);
    const [controlPlane, actor] = await Promise.all([
      getControlPlane(),
      getLocalActorContext(),
    ]);
    return makeStartRunHandler({
      service: controlPlane.service,
      actor,
    })(request, { sessionId: validatedSessionId });
  } catch (reason) {
    return errorResponse(reason);
  }
}
