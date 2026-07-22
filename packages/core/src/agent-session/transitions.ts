import type { GrowthState, RunStatus } from './schemas';

const runTransitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'reconciling', 'failed', 'cancelled'],
  running: [
    'waiting_approval',
    'reconciling',
    'succeeded',
    'failed',
    'cancelled',
  ],
  waiting_approval: ['running', 'reconciling', 'failed', 'cancelled'],
  reconciling: [
    'running',
    'waiting_approval',
    'succeeded',
    'failed',
    'cancelled',
  ],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const growthTransitions: Record<GrowthState, readonly GrowthState[]> = {
  active: ['dormant', 'metabolized'],
  dormant: ['active', 'metabolized'],
  metabolized: [],
};

export function assertRunTransition(
  current: RunStatus,
  next: RunStatus,
): void {
  if (!runTransitions[current].includes(next)) {
    throw new Error(`Invalid run transition: ${current} -> ${next}`);
  }
}

export function assertGrowthTransition(
  current: GrowthState,
  next: GrowthState,
): void {
  if (!growthTransitions[current].includes(next)) {
    throw new Error(`Invalid growth transition: ${current} -> ${next}`);
  }
}
