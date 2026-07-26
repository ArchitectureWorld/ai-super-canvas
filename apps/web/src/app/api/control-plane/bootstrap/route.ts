import {
  getControlPlane,
  localAuthSubject,
} from '@/server/control-plane';

import { errorResponse } from '../http';
import { makeBootstrapHandler } from '../handlers';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const authSubject = localAuthSubject();
    const controlPlane = await getControlPlane();
    return makeBootstrapHandler({
      service: controlPlane.service,
      authSubject,
    })(request);
  } catch (reason) {
    return errorResponse(reason);
  }
}
