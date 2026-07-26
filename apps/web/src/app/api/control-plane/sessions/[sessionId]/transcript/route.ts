import {
  getControlPlane,
  getLocalActorContext,
} from '@/server/control-plane';

import { makeTranscriptHandler } from '../../../handlers';
import { errorResponse } from '../../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  try {
    const [{ sessionId }, controlPlane, actor] = await Promise.all([
      params,
      getControlPlane(),
      getLocalActorContext(),
    ]);
    return makeTranscriptHandler({
      service: controlPlane.service,
      actor,
    })({ sessionId });
  } catch (reason) {
    return errorResponse(reason);
  }
}
