export type ControlPlaneApplicationErrorCode =
  | 'command_requires_reconciliation'
  | 'runtime_operation_failed'
  | 'runtime_session_unavailable';

export class ControlPlaneApplicationError extends Error {
  constructor(
    readonly code: ControlPlaneApplicationErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly commandReceiptId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ControlPlaneApplicationError';
  }
}

export function commandRequiresReconciliation(
  commandReceiptId: string,
  cause?: unknown,
): ControlPlaneApplicationError {
  return new ControlPlaneApplicationError(
    'command_requires_reconciliation',
    'Runtime command requires reconciliation',
    true,
    commandReceiptId,
    { cause },
  );
}

export function runtimeOperationFailed(
  commandReceiptId: string,
  retryable: boolean,
  cause?: unknown,
): ControlPlaneApplicationError {
  return new ControlPlaneApplicationError(
    'runtime_operation_failed',
    'Runtime operation failed',
    retryable,
    commandReceiptId,
    { cause },
  );
}

export function runtimeSessionUnavailable(
  commandReceiptId?: string,
  cause?: unknown,
): ControlPlaneApplicationError {
  return new ControlPlaneApplicationError(
    'runtime_session_unavailable',
    'Runtime Session is unavailable; create a new test Session',
    false,
    commandReceiptId,
    { cause },
  );
}
