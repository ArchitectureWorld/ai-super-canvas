import {
  getControlPlane,
  getLocalActorContext,
} from '@/server/control-plane';

import { errorResponse } from '../http';
import { makeCreateSessionHandler } from '../handlers';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const [controlPlane, actor] = await Promise.all([
      getControlPlane(),
      getLocalActorContext(),
    ]);
    return makeCreateSessionHandler({
      service: controlPlane.service,
      actor,
    })(request);
  } catch (reason) {
    return errorResponse(reason);
  }
}
