'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import styles from './control-plane-test.module.css';

const bootstrapCommandKey =
  'ai-super-canvas.control-plane-test.bootstrap-command';
const lastSessionKey =
  'ai-super-canvas.control-plane-test.last-session';
const pendingSessionCommandKey =
  'ai-super-canvas.control-plane-test.pending-session-command';
const pendingRunCommandKey =
  'ai-super-canvas.control-plane-test.pending-run-command';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface BootstrapResult {
  accountId: string;
  agentId: string;
  agentBindingId: string;
  workspaceId: string;
  workflowId: string;
  trunkRevisionId: string;
}

interface SessionMessage {
  messageId: string;
  runId: string | null;
  ordinal: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  status: string;
}

interface SessionTranscript {
  sessionId: string;
  status: string;
  messages: SessionMessage[];
  activeRun: null | { runId: string; status: string };
  reconciliationState: null | {
    kind: 'run-reconciling' | 'runtime-unavailable';
    message: string;
  };
  runtimeAvailability: 'available' | 'unavailable';
}

interface RunEvent {
  sequence: number;
  eventType: string;
  payload: unknown;
  occurredAt: string;
}

interface RunEventsPage {
  events: RunEvent[];
  nextAfter: number;
  terminal: null | { status: 'succeeded' | 'failed' | 'cancelled' };
}

interface ApiErrorPayload {
  error: { code: string; message: string; retryable: boolean };
  commandReceiptId?: string;
}

interface JsonResponse {
  payload: unknown;
  status: number;
}

interface CreatedSessionResult {
  sessionId: string;
  nodeId: string;
  status: 'active';
}

type StoredRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'reconciling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

interface StartedRunResult {
  runId: string;
  status: StoredRunStatus;
}

interface PendingRun {
  commandId: string;
  idempotencyKey: string;
  sessionId: string;
  content: string;
}

const recoveryByCode: Record<string, string> = {
  command_requires_reconciliation:
    '服务器正在确认上次操作。请稍后点“重试上次操作”，不要重复新建。',
  command_persistence_unconfirmed:
    '服务器暂时无法确认是否已保存。请稍后重试，页面会复用同一个命令编号。',
  runtime_session_unavailable:
    '历史记录还在，但旧运行环境已断开。请新建测试 Session。',
  active_run_conflict:
    '这个 Session 仍有任务在处理中，请等待当前任务结束。',
  command_payload_conflict:
    '上次操作的内容与本次不同。请新建测试 Session 后再试。',
  run_idempotency_conflict:
    '检测到不一致的重复发送。请新建测试 Session 后再试。',
  not_found:
    '找不到这条历史记录，可能已被清理。请新建测试 Session。',
  internal_error:
    '后端暂时出错。请先点“重新连接”，如果仍失败再查看服务日志。',
  invalid_response:
    '后端返回了无法识别的数据。请重新连接后再试。',
  http_503:
    'PostgreSQL 暂时不可用。请确认数据库和迁移已就绪，再重新连接。',
};

class ClientRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly status?: number,
    readonly commandReceiptId?: string,
  ) {
    super(message);
    this.name = 'ClientRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  if (!isRecord(value) || !isRecord(value.error)) return false;
  return (
    typeof value.error.code === 'string'
    && typeof value.error.message === 'string'
    && typeof value.error.retryable === 'boolean'
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isReadyResult(value: unknown): value is {
  status: 'ready';
  database: 'ready';
} {
  return (
    isRecord(value)
    && value.status === 'ready'
    && value.database === 'ready'
  );
}

function isBootstrapResult(value: unknown): value is BootstrapResult {
  return (
    isRecord(value)
    && isUuid(value.accountId)
    && isUuid(value.agentId)
    && isUuid(value.agentBindingId)
    && isUuid(value.workspaceId)
    && isUuid(value.workflowId)
    && isUuid(value.trunkRevisionId)
  );
}

function isCreatedSessionResult(
  value: unknown,
): value is CreatedSessionResult {
  return (
    isRecord(value)
    && isUuid(value.sessionId)
    && isUuid(value.nodeId)
    && value.status === 'active'
  );
}

function isStoredRunStatus(value: unknown): value is StoredRunStatus {
  return (
    value === 'queued'
    || value === 'running'
    || value === 'waiting_approval'
    || value === 'reconciling'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'cancelled'
  );
}

function isStartedRunResult(value: unknown): value is StartedRunResult {
  return (
    isRecord(value)
    && isUuid(value.runId)
    && isStoredRunStatus(value.status)
  );
}

function isSessionMessage(value: unknown): value is SessionMessage {
  return (
    isRecord(value)
    && isUuid(value.messageId)
    && (value.runId === null || isUuid(value.runId))
    && Number.isInteger(value.ordinal)
    && typeof value.ordinal === 'number'
    && value.ordinal >= 0
    && (
      value.role === 'user'
      || value.role === 'assistant'
      || value.role === 'system'
      || value.role === 'tool'
    )
    && Object.hasOwn(value, 'content')
    && isNonEmptyString(value.status)
  );
}

function isActiveRun(value: unknown): value is NonNullable<
  SessionTranscript['activeRun']
> {
  return (
    isRecord(value)
    && isUuid(value.runId)
    && isStoredRunStatus(value.status)
  );
}

function isReconciliationState(value: unknown): value is NonNullable<
  SessionTranscript['reconciliationState']
> {
  return (
    isRecord(value)
    && (
      value.kind === 'run-reconciling'
      || value.kind === 'runtime-unavailable'
    )
    && isNonEmptyString(value.message)
  );
}

function isSessionTranscript(value: unknown): value is SessionTranscript {
  return (
    isRecord(value)
    && isUuid(value.sessionId)
    && isNonEmptyString(value.status)
    && Array.isArray(value.messages)
    && value.messages.every(isSessionMessage)
    && (value.activeRun === null || isActiveRun(value.activeRun))
    && (
      value.reconciliationState === null
      || isReconciliationState(value.reconciliationState)
    )
    && (
      value.runtimeAvailability === 'available'
      || value.runtimeAvailability === 'unavailable'
    )
  );
}

function isRunEvent(value: unknown): value is RunEvent {
  return (
    isRecord(value)
    && Number.isInteger(value.sequence)
    && typeof value.sequence === 'number'
    && value.sequence > 0
    && isNonEmptyString(value.eventType)
    && Object.hasOwn(value, 'payload')
    && isNonEmptyString(value.occurredAt)
  );
}

function isRunEventsPage(value: unknown): value is RunEventsPage {
  return (
    isRecord(value)
    && Array.isArray(value.events)
    && value.events.every(isRunEvent)
    && Number.isInteger(value.nextAfter)
    && typeof value.nextAfter === 'number'
    && value.nextAfter >= 0
    && (
      value.terminal === null
      || (
        isRecord(value.terminal)
        && (
          value.terminal.status === 'succeeded'
          || value.terminal.status === 'failed'
          || value.terminal.status === 'cancelled'
        )
      )
    )
  );
}

function recoveryMessage(code: string): string {
  return recoveryByCode[code]
    ?? '操作没有完成。请重新连接后再试；页面不会自动重复写入。';
}

function invalidResponse(status?: number): ClientRequestError {
  return new ClientRequestError(
    'invalid_response',
    recoveryMessage('invalid_response'),
    false,
    status,
  );
}

async function jsonRequest(
  url: string,
  init: RequestInit = {},
): Promise<JsonResponse> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');

  const response = await fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
  });
  const text = await response.text();
  let payload: unknown;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new ClientRequestError(
      'invalid_response',
      recoveryMessage('invalid_response'),
      false,
      response.status,
    );
  }

  if (isRecord(payload) && Object.hasOwn(payload, 'error')) {
    if (isApiErrorPayload(payload)) {
      throw new ClientRequestError(
        payload.error.code,
        recoveryMessage(payload.error.code),
        payload.error.retryable,
        response.status,
        payload.commandReceiptId,
      );
    }
    throw invalidResponse(response.status);
  }

  if (!response.ok) {
    const code = `http_${response.status}`;
    throw new ClientRequestError(
      code,
      recoveryMessage(code),
      response.status >= 500,
      response.status,
    );
  }

  return { payload, status: response.status };
}

function validatedPayload<T>(
  response: JsonResponse,
  expectedStatus: number,
  validator: (value: unknown) => value is T,
): T {
  if (
    response.status !== expectedStatus
    || !validator(response.payload)
  ) {
    throw invalidResponse(response.status);
  }
  return response.payload;
}

function storedUuid(key: string): string | null {
  const value = localStorage.getItem(key);
  if (!value) return null;
  if (uuidPattern.test(value)) return value;
  localStorage.removeItem(key);
  return null;
}

function commandId(key: string): string {
  const stored = storedUuid(key);
  if (stored) return stored;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

function storedPendingRun(): PendingRun | null {
  const raw = localStorage.getItem(pendingRunCommandKey);
  if (!raw) return null;

  try {
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value)
      && typeof value.commandId === 'string'
      && uuidPattern.test(value.commandId)
      && typeof value.idempotencyKey === 'string'
      && value.idempotencyKey.length > 0
      && value.idempotencyKey.length <= 160
      && typeof value.sessionId === 'string'
      && uuidPattern.test(value.sessionId)
      && typeof value.content === 'string'
      && value.content.trim().length > 0
      && value.content.length <= 20_000
    ) {
      return {
        commandId: value.commandId,
        idempotencyKey: value.idempotencyKey,
        sessionId: value.sessionId,
        content: value.content,
      };
    }
  } catch {
    // Invalid browser pointers are discarded below.
  }

  localStorage.removeItem(pendingRunCommandKey);
  return null;
}

function displayContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (
    isRecord(content)
    && typeof content.text === 'string'
  ) {
    return content.text;
  }
  try {
    return JSON.stringify(content);
  } catch {
    return '[无法显示的结构化内容]';
  }
}

function roleLabel(role: SessionMessage['role']): string {
  if (role === 'user') return '你';
  if (role === 'assistant') return 'Fake Runtime';
  if (role === 'system') return '系统';
  return '工具';
}

function displayError(reason: unknown): string {
  return reason instanceof ClientRequestError
    ? reason.message
    : '页面操作失败。请重新连接后再试。';
}

function isConfirmedTerminalRunError(reason: unknown): boolean {
  return (
    reason instanceof ClientRequestError
    && (reason.code === 'run_failed' || reason.code === 'run_cancelled')
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function ControlPlaneTestClient() {
  const [bootstrap, setBootstrap] = useState<BootstrapResult | null>(null);
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  const [content, setContent] = useState('请返回确定性测试回复');
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState('正在连接真实后端');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasPendingSession, setHasPendingSession] = useState(false);
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);
  const [recoveryHydrated, setRecoveryHydrated] = useState(false);
  const [clientActiveRunId, setClientActiveRunId] = useState<string | null>(
    null,
  );
  const initialized = useRef(false);
  const pollingRunId = useRef<string | null>(null);

  const loadTranscript = useCallback(async (sessionId: string) => {
    const response = await jsonRequest(
      `/api/control-plane/sessions/${sessionId}/transcript`,
    );
    const next = validatedPayload(response, 200, isSessionTranscript);
    if (next.sessionId !== sessionId) throw invalidResponse(response.status);
    setTranscript(next);
    return next;
  }, []);

  const initialize = useCallback(async () => {
    setBusy(true);
    setError('');
    setReady(false);
    setRecoveryHydrated(false);
    setStatus('正在连接 PostgreSQL');

    try {
      const readyResponse = await jsonRequest('/api/ready');
      validatedPayload(readyResponse, 200, isReadyResult);
      setStatus('正在初始化本地账号和工作区');
      const bootstrapResponse = await jsonRequest(
        '/api/control-plane/bootstrap',
        {
          method: 'POST',
          body: JSON.stringify({
            commandId: commandId(bootstrapCommandKey),
            displayName: '本地测试用户',
          }),
        },
      );
      const result = validatedPayload(
        bootstrapResponse,
        200,
        isBootstrapResult,
      );
      localStorage.removeItem(bootstrapCommandKey);
      setBootstrap(result);
      setReady(true);

      const pendingSession = storedUuid(pendingSessionCommandKey);
      setHasPendingSession(Boolean(pendingSession));

      let lastSessionId = storedUuid(lastSessionKey);
      if (lastSessionId) {
        try {
          const restoredTranscript = await loadTranscript(lastSessionId);
          setClientActiveRunId(restoredTranscript.activeRun?.runId ?? null);
          setStatus('历史已从 PostgreSQL 恢复');
        } catch (reason) {
          if (
            reason instanceof ClientRequestError
            && reason.code === 'not_found'
          ) {
            localStorage.removeItem(lastSessionKey);
            setTranscript(null);
            setEvents([]);
            setClientActiveRunId(null);
            lastSessionId = null;
            setStatus('后端已就绪');
          } else {
            throw reason;
          }
        }
      } else {
        setTranscript(null);
        setEvents([]);
        setClientActiveRunId(null);
        setStatus('后端已就绪');
      }

      const restoredPendingRun = storedPendingRun();
      if (
        restoredPendingRun
        && restoredPendingRun.sessionId === lastSessionId
      ) {
        setPendingRun(restoredPendingRun);
        setContent(restoredPendingRun.content);
      } else {
        localStorage.removeItem(pendingRunCommandKey);
        setPendingRun(null);
      }
    } catch (reason) {
      setReady(false);
      setError(displayError(reason));
      setStatus('连接失败');
    } finally {
      setRecoveryHydrated(true);
      setBusy(false);
    }
  }, [loadTranscript]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void initialize();
  }, [initialize]);

  const createSession = useCallback(async () => {
    if (!bootstrap || !ready || busy) return;
    setBusy(true);
    setError('');
    setStatus('正在创建 Canvas Session 和 Runtime Session');
    const pendingCommandId = commandId(pendingSessionCommandKey);
    setHasPendingSession(true);
    let createdSessionId: string | null = null;

    try {
      const sessionResponse = await jsonRequest('/api/control-plane/sessions', {
        method: 'POST',
        body: JSON.stringify({
          commandId: pendingCommandId,
          workflowId: bootstrap.workflowId,
          agentBindingId: bootstrap.agentBindingId,
          title: '真实后端测试 Session',
        }),
      });
      const result = validatedPayload(
        sessionResponse,
        201,
        isCreatedSessionResult,
      );
      createdSessionId = result.sessionId;
      localStorage.removeItem(pendingSessionCommandKey);
      localStorage.setItem(lastSessionKey, result.sessionId);
      localStorage.removeItem(pendingRunCommandKey);
      setHasPendingSession(false);
      setPendingRun(null);
      setEvents([]);
      setClientActiveRunId(null);
      setTranscript(null);
      setContent('');
      await loadTranscript(result.sessionId);
      setStatus('Session 已连接 Fake Runtime');
    } catch (reason) {
      setError(displayError(reason));
      setStatus(
        createdSessionId
          ? 'Session 已创建，但记录加载失败，请重新连接'
          : '新建 Session 未完成',
      );
    } finally {
      setBusy(false);
    }
  }, [bootstrap, busy, loadTranscript, ready]);

  const pollRun = useCallback(async (sessionId: string, runId: string) => {
    let after = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const eventsResponse = await jsonRequest(
        `/api/control-plane/runs/${runId}/events?after=${after}`,
      );
      const page = validatedPayload(
        eventsResponse,
        200,
        isRunEventsPage,
      );
      const greatestPageSequence = page.events.reduce(
        (greatest, event) => Math.max(greatest, event.sequence),
        after,
      );
      if (
        page.nextAfter < after
        || page.nextAfter < greatestPageSequence
      ) {
        throw invalidResponse(eventsResponse.status);
      }
      setEvents((current) => {
        const lastSequence = current.at(-1)?.sequence ?? 0;
        return [
          ...current,
          ...page.events.filter(({ sequence }) => sequence > lastSequence),
        ].sort((left, right) => left.sequence - right.sequence);
      });
      after = page.nextAfter;
      await loadTranscript(sessionId);

      if (page.terminal?.status === 'succeeded') return;
      if (page.terminal?.status === 'failed') {
        throw new ClientRequestError(
          'run_failed',
          'Run 已结束但没有成功。已保存的消息仍可查看，请新建 Session 后再试。',
        );
      }
      if (page.terminal?.status === 'cancelled') {
        throw new ClientRequestError(
          'run_cancelled',
          'Run 已取消。已保存的消息仍可查看，可以重新发送。',
        );
      }
      await sleep(150);
    }

    throw new ClientRequestError(
      'run_poll_timeout',
      '等待回复超时。请重新连接查看 PostgreSQL 中的最新记录。',
      true,
    );
  }, [loadTranscript]);

  useEffect(() => {
    const activeRun = transcript?.activeRun;
    if (
      !transcript
      || !activeRun
      || !ready
      || !recoveryHydrated
      || transcript.runtimeAvailability !== 'available'
      || transcript.reconciliationState
      || pollingRunId.current === activeRun.runId
    ) {
      return;
    }

    pollingRunId.current = activeRun.runId;
    setClientActiveRunId(activeRun.runId);
    setEvents([]);
    setBusy(true);
    setError('');
    setStatus('正在恢复未完成 Run');

    const resumeRun = async () => {
      if (pendingRun?.sessionId === transcript.sessionId) {
        const runResponse = await jsonRequest(
          `/api/control-plane/sessions/${transcript.sessionId}/runs`,
          {
            method: 'POST',
            body: JSON.stringify({
              commandId: pendingRun.commandId,
              idempotencyKey: pendingRun.idempotencyKey,
              content: pendingRun.content,
            }),
          },
        );
        const result = validatedPayload(
          runResponse,
          202,
          isStartedRunResult,
        );
        if (result.runId !== activeRun.runId) {
          throw invalidResponse(runResponse.status);
        }
        localStorage.removeItem(pendingRunCommandKey);
        setPendingRun(null);
      }
      await pollRun(transcript.sessionId, activeRun.runId);
    };

    void resumeRun()
      .then(() => {
        setClientActiveRunId(null);
        setContent('');
        setStatus('回复已写入 PostgreSQL');
      })
      .catch((reason: unknown) => {
        if (isConfirmedTerminalRunError(reason)) {
          setClientActiveRunId(null);
        }
        setError(displayError(reason));
        setStatus('恢复 Run 未完成');
      })
      .finally(() => {
        if (pollingRunId.current === activeRun.runId) {
          pollingRunId.current = null;
        }
        setBusy(false);
      });
  }, [
    pendingRun,
    pollRun,
    ready,
    recoveryHydrated,
    transcript,
  ]);

  const sendMessage = useCallback(async () => {
    if (
      !transcript
      || !ready
      || transcript.runtimeAvailability !== 'available'
      || transcript.activeRun
      || transcript.reconciliationState
      || clientActiveRunId
      || busy
    ) {
      return;
    }

    const restored = storedPendingRun();
    if (restored && restored.sessionId !== transcript.sessionId) {
      localStorage.removeItem(pendingRunCommandKey);
      setPendingRun(null);
    }
    const trimmedContent = content.trim();
    const nextPending = restored?.sessionId === transcript.sessionId
      ? restored
      : {
          commandId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          sessionId: transcript.sessionId,
          content: trimmedContent,
        };
    if (!nextPending.content || nextPending.content.length > 20_000) return;

    localStorage.setItem(
      pendingRunCommandKey,
      JSON.stringify(nextPending),
    );
    setPendingRun(nextPending);
    setBusy(true);
    setError('');
    setStatus('Runtime 正在生成回复');

    try {
      const runResponse = await jsonRequest(
        `/api/control-plane/sessions/${transcript.sessionId}/runs`,
        {
          method: 'POST',
          body: JSON.stringify({
            commandId: nextPending.commandId,
            idempotencyKey: nextPending.idempotencyKey,
            content: nextPending.content,
          }),
        },
      );
      const result = validatedPayload(
        runResponse,
        202,
        isStartedRunResult,
      );
      setClientActiveRunId(result.runId);
      localStorage.removeItem(pendingRunCommandKey);
      setPendingRun(null);
      setEvents([]);
      pollingRunId.current = result.runId;
      try {
        await pollRun(transcript.sessionId, result.runId);
      } finally {
        if (pollingRunId.current === result.runId) {
          pollingRunId.current = null;
        }
      }
      setClientActiveRunId(null);
      setContent('');
      setStatus('回复已写入 PostgreSQL');
    } catch (reason) {
      if (isConfirmedTerminalRunError(reason)) {
        setClientActiveRunId(null);
      }
      setError(displayError(reason));
      setStatus('发送未完成');
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    clientActiveRunId,
    content,
    pollRun,
    ready,
    transcript,
  ]);

  const canSend = Boolean(
    transcript
    && ready
    && transcript.runtimeAvailability === 'available'
    && !transcript.activeRun
    && !transcript.reconciliationState
    && !clientActiveRunId
    && content.trim()
    && content.trim().length <= 20_000
    && !busy,
  );

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.hero}>
          <p className={styles.kicker}>CONTROL PLANE · LOCAL ALPHA</p>
          <div className={styles.heroRow}>
            <div className={styles.heroCopy}>
              <h1 className={styles.title}>真实后端闭环</h1>
              <p className={styles.lead}>
                这里的测试 Session、消息和运行记录都会写入 PostgreSQL，不会沿用旧画布的浏览器演示数据。
              </p>
            </div>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={!bootstrap || !ready || busy}
              onClick={() => void createSession()}
            >
              {hasPendingSession ? '重试新建 Session' : '新建测试 Session'}
            </button>
          </div>
        </header>

        {error ? (
          <section className={`${styles.notice} ${styles.error}`} role="alert">
            <p className={styles.noticeTitle}>{error}</p>
            <div className={styles.actionRow}>
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={busy}
                onClick={() => void initialize()}
              >
                重新连接
              </button>
            </div>
          </section>
        ) : null}

        {transcript?.runtimeAvailability === 'unavailable' ? (
          <section className={`${styles.notice} ${styles.warning}`} role="status">
            <p className={styles.noticeTitle}>
              历史已恢复，但旧 Fake Runtime 已不可用。请新建测试 Session。
            </p>
          </section>
        ) : null}

        {transcript?.reconciliationState ? (
          <section className={`${styles.notice} ${styles.warning}`} role="status">
            <p className={styles.noticeTitle}>服务器正在核对运行状态</p>
            <p className={styles.noticeCopy}>
              {transcript.reconciliationState.message}
            </p>
          </section>
        ) : null}

        {pendingRun ? (
          <section className={`${styles.notice} ${styles.warning}`} role="status">
            <p className={styles.noticeTitle}>有一条未确认的发送，可安全重试</p>
            <p className={styles.pendingContent}>{pendingRun.content}</p>
          </section>
        ) : null}

        <div className={styles.bodyGrid}>
          <section
            className={styles.conversationColumn}
            aria-labelledby="transcript-title"
          >
            <div className={styles.panel}>
              <div className={styles.panelHeading}>
                <div>
                  <p className={styles.eyebrow}>SESSION TRANSCRIPT</p>
                  <h2 className={styles.sectionTitle} id="transcript-title">
                    PostgreSQL 会话记录
                  </h2>
                </div>
                <span
                  className={`${styles.stateBadge} ${
                    transcript && !transcript.reconciliationState
                      ? styles.success
                      : styles.warning
                  }`}
                >
                  {transcript?.reconciliationState
                    ? '对账中'
                    : transcript
                      ? transcript.status
                      : '等待 Session'}
                </span>
              </div>
              {transcript?.messages.length ? (
                <div className={styles.transcriptList}>
                  {transcript.messages.map((message) => (
                    <article
                      className={`${styles.message} ${
                        message.role === 'assistant'
                          ? styles.assistantMessage
                          : ''
                      }`}
                      key={message.messageId}
                      data-role={message.role}
                    >
                      <div className={styles.messageHeader}>
                        <strong>{roleLabel(message.role)}</strong>
                        <span>#{message.ordinal}</span>
                      </div>
                      <p className={styles.messageBody}>
                        {displayContent(message.content)}
                      </p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className={styles.emptyState}>
                  <p className={styles.emptyTitle}>还没有持久化消息</p>
                  <p className={styles.emptyCopy}>
                    后端连接完成后，新建一个测试 Session，再发送第一条消息。
                  </p>
                </div>
              )}
            </div>

            <form
              className={styles.composer}
              onSubmit={(event) => {
                event.preventDefault();
                void sendMessage();
              }}
            >
              <label
                className={styles.label}
                htmlFor="control-plane-test-message"
              >
                测试消息
              </label>
              <textarea
                className={styles.textarea}
                id="control-plane-test-message"
                name="message"
                placeholder="先新建测试 Session，再输入要交给真实后端的内容"
                rows={4}
                maxLength={20_000}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                disabled={
                  !transcript
                  || !ready
                  || transcript.runtimeAvailability !== 'available'
                  || Boolean(transcript.activeRun)
                  || Boolean(transcript.reconciliationState)
                  || Boolean(clientActiveRunId)
                  || busy
                }
              />
              <div className={styles.composerFooter}>
                <p className={styles.composerHint}>
                  消息正文只在待确认重试期间临时保存，成功后立即清除。
                </p>
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={!canSend}
                >
                  {pendingRun ? '重试上次发送' : '发送到真实后端'}
                </button>
              </div>
            </form>
          </section>

          <aside className={styles.sideColumn}>
            <section
              className={styles.panel}
              aria-labelledby="backend-status-title"
            >
              <div className={styles.panelHeading}>
                <div>
                  <p className={styles.eyebrow}>BACKEND STATUS</p>
                  <h2
                    aria-live="polite"
                    className={styles.sectionTitle}
                    id="backend-status-title"
                  >
                    {status}
                  </h2>
                </div>
                <span
                  className={ready ? styles.readyDot : styles.pulse}
                  aria-hidden="true"
                />
              </div>
              <dl className={styles.statusList}>
                <div className={styles.statusRow}>
                  <dt className={styles.statusName}>PostgreSQL</dt>
                  <dd className={styles.statusValue}>
                    {ready ? '已连接' : '等待握手'}
                  </dd>
                </div>
                <div className={styles.statusRow}>
                  <dt className={styles.statusName}>
                    DeterministicFakeRuntime
                  </dt>
                  <dd className={styles.statusValue}>
                    {transcript?.runtimeAvailability === 'available'
                      ? 'Session 可用'
                      : transcript?.runtimeAvailability === 'unavailable'
                        ? '旧 Session 已断开'
                        : bootstrap
                          ? '等待 Session'
                          : '等待握手'}
                  </dd>
                </div>
              </dl>
            </section>

            <section
              className={styles.panel}
              aria-label="已持久化 Run 事件"
            >
              <div className={styles.panelHeading}>
                <div>
                  <p className={styles.eyebrow}>RUN EVENT LOG</p>
                  <h2 className={styles.sectionTitle}>
                    已持久化 Run 事件
                  </h2>
                </div>
              </div>
              {events.length ? (
                <div className={styles.eventList}>
                  {events.map((event) => (
                    <span className={styles.eventBadge} key={event.sequence}>
                      {event.sequence} · {event.eventType}
                    </span>
                  ))}
                </div>
              ) : (
                <p className={styles.eventPlaceholder}>
                  启动 Run 后，这里会显示从数据库读取的事件。
                </p>
              )}
            </section>

            <section
              className={`${styles.notice} ${styles.success}`}
              aria-label="数据边界"
            >
              <p className={styles.noticeTitle}>页面与旧画布完全隔离</p>
              <p className={styles.noticeCopy}>
                浏览器只保留恢复操作需要的标识，不缓存已完成的对话正文或运行输出。
              </p>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
