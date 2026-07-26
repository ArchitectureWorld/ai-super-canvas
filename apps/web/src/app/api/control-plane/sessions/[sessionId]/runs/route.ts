import {
  getControlPlane,
  getLocalActorContext,
} from '@/server/control-plane';

import { makeStartRunHandler } from '../../../handlers';
import { errorResponse } from '../../../http';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  try {
    const [{ sessionId }, controlPlane, actor] = await Promise.all([
      params,
      getControlPlane(),
      getLocalActorContext(),
    ]);
    return makeStartRunHandler({
      service: controlPlane.service,
      actor,
    })(request, { sessionId });
  } catch (reason) {
    return errorResponse(reason);
  }
}
