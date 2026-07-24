import { describe, expect, it } from 'vitest';

import {
  commandPersistenceUnconfirmed,
  commandRequiresReconciliation,
  ControlPlaneApplicationError,
  runtimeOperationFailed,
  runtimeSessionUnavailable,
} from './errors';

describe('ControlPlaneApplicationError', () => {
  it('exposes only a stable code, safe message, retryability and receipt id', () => {
    const cause = new Error('postgres://secret@internal/runtime_ref=fake-1');
    const error = new ControlPlaneApplicationError(
      'command_requires_reconciliation',
      'Runtime command requires reconciliation',
      true,
      '33333333-3333-4333-8333-333333333333',
      { cause },
    );

    expect(error).toMatchObject({
      name: 'ControlPlaneApplicationError',
      code: 'command_requires_reconciliation',
      message: 'Runtime command requires reconciliation',
      retryable: true,
      commandReceiptId: '33333333-3333-4333-8333-333333333333',
      cause,
    });
    expect(error.message).not.toContain('secret');
    expect(error.message).not.toContain('fake-1');
  });
});

describe('application error factories', () => {
  it('creates a safe retryable reconciliation error', () => {
    const cause = new Error('runtime_ref=fake-1');

    expect(
      commandRequiresReconciliation(
        '33333333-3333-4333-8333-333333333333',
        cause,
      ),
    ).toMatchObject({
      code: 'command_requires_reconciliation',
      message: 'Runtime command requires reconciliation',
      retryable: true,
      commandReceiptId: '33333333-3333-4333-8333-333333333333',
      cause,
    });
  });

  it('creates a safe persistence-unconfirmed error', () => {
    expect(
      commandPersistenceUnconfirmed(
        '33333333-3333-4333-8333-333333333333',
      ),
    ).toMatchObject({
      code: 'command_persistence_unconfirmed',
      message: 'Runtime command persistence could not be confirmed',
      retryable: true,
      commandReceiptId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('creates a runtime-operation error with the supplied retryability', () => {
    expect(
      runtimeOperationFailed('33333333-3333-4333-8333-333333333333', false),
    ).toMatchObject({
      code: 'runtime_operation_failed',
      message: 'Runtime operation failed',
      retryable: false,
      commandReceiptId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('creates a non-retryable unavailable-session error without a receipt', () => {
    expect(runtimeSessionUnavailable()).toMatchObject({
      code: 'runtime_session_unavailable',
      message: 'Runtime Session is unavailable; create a new test Session',
      retryable: false,
      commandReceiptId: undefined,
    });
  });
});
