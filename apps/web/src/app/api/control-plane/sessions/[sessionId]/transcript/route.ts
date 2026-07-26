import {
  getControlPlane,
  getLocalActorContext,
} from '@/server/control-plane';

import { makeTranscriptHandler } from '../../../handlers';
import { errorResponse, parseUuid } from '../../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  try {
    const { sessionId } = await params;
    const validatedSessionId = parseUuid(sessionId);
    const [controlPlane, actor] = await Promise.all([
      getControlPlane(),
      getLocalActorContext(),
    ]);
    return makeTranscriptHandler({
      service: controlPlane.service,
      actor,
    })({ sessionId: validatedSessionId });
  } catch (reason) {
    return errorResponse(reason);
  }
}
