'use client';

import {
  addBranchMessage,
  createBranchFromSelection,
  createConclusionCard,
  createDemoWorkspace,
  currentTrunkContent,
  integrateConclusionCard,
  reviseTrunk,
  setBranchLifecycle,
  type WorkspaceState,
} from '@ai-super-canvas/core';
import { useRef, useState, useSyncExternalStore } from 'react';

const storageKey = 'ai-super-canvas.gate-0.workspace.v1';
const workspaceChangedEvent = 'ai-super-canvas:workspace-changed';
let workspaceSnapshot: WorkspaceState | undefined;

function loadWorkspace(): WorkspaceState {
  if (typeof window === 'undefined') {
    return createDemoWorkspace();
  }
  const saved = window.localStorage.getItem(storageKey);
  if (!saved) {
    return createDemoWorkspace();
  }
  try {
    const parsed = JSON.parse(saved) as WorkspaceState;
    return parsed.version === 1 ? parsed : createDemoWorkspace();
  } catch {
    return createDemoWorkspace();
  }
}

function lifecycleLabel(lifecycle: string): string {
  return ({ active: '探索中', dormant: '休眠', metabolized: '已腐殖化' } as Record<string, string>)[
    lifecycle
  ];
}

function formatEventTime(isoTimestamp: string): string {
  return `${isoTimestamp.slice(0, 16).replace('T', ' ')} UTC`;
}

function getWorkspaceSnapshot(): WorkspaceState {
  if (typeof window === 'undefined') return createDemoWorkspace();
  workspaceSnapshot ??= loadWorkspace();
  return workspaceSnapshot;
}

function subscribeToWorkspace(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const refresh = () => {
    workspaceSnapshot = undefined;
    onStoreChange();
  };
  window.addEventListener('storage', refresh);
  window.addEventListener(workspaceChangedEvent, refresh);
  return () => {
    window.removeEventListener('storage', refresh);
    window.removeEventListener(workspaceChangedEvent, refresh);
  };
}

function persistWorkspace(workspace: WorkspaceState): void {
  workspaceSnapshot = workspace;
  window.localStorage.setItem(storageKey, JSON.stringify(workspace));
  window.dispatchEvent(new Event(workspaceChangedEvent));
}

export function WorkspacePrototype() {
  const workspace = useSyncExternalStore(
    subscribeToWorkspace,
    getWorkspaceSnapshot,
    createDemoWorkspace,
  );
  const [selectedBranchId, setSelectedBranchId] = useState('branch-initial');
  const [draftOverride, setDraftOverride] = useState<string | null>(null);
  const [branchMessage, setBranchMessage] = useState('');
  const [error, setError] = useState('');
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const trunkRef = useRef<HTMLTextAreaElement>(null);
  const draft = draftOverride ?? currentTrunkContent(workspace);

  const selectedBranch = workspace.branches.find((branch) => branch.id === selectedBranchId);
  const selectedMessages = workspace.messages.filter(
    (message) => message.branchId === selectedBranchId,
  );
  const selectedCards = workspace.cards.filter((card) => card.branchId === selectedBranchId);

  function updateWorkspace(next: WorkspaceState): void {
    persistWorkspace(next);
    setError('');
  }

  function saveTrunk(): WorkspaceState {
    const next = reviseTrunk(workspace, draft);
    if (next !== workspace) {
      updateWorkspace(next);
    }
    return next;
  }

  function createBranch(): void {
    const textarea = trunkRef.current;
    if (!textarea) return;
    try {
      const source = draft === currentTrunkContent(workspace) ? workspace : reviseTrunk(workspace, draft);
      const next = createBranchFromSelection(source, {
        selectionStart: selection.start,
        selectionEnd: selection.end,
        title: '',
      });
      updateWorkspace(next);
      setSelectedBranchId(next.branches.at(-1)?.id ?? selectedBranchId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建分支失败');
    }
  }

  function captureSelection(): void {
    const textarea = trunkRef.current;
    if (textarea) {
      setSelection({ start: textarea.selectionStart, end: textarea.selectionEnd });
    }
  }

  function submitMessage(): void {
    if (!selectedBranch) return;
    try {
      const next = addBranchMessage(workspace, {
        branchId: selectedBranch.id,
        content: branchMessage,
        author: 'user',
      });
      updateWorkspace(next);
      setBranchMessage('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '写入分支失败');
    }
  }

  function createDemoCard(): void {
    if (!selectedBranch) return;
    try {
      const next = createConclusionCard(workspace, {
        branchId: selectedBranch.id,
        title: '建议：先完成可回写纵切',
        content:
          '先验证锚点、独立分支和显式回写是否可理解；再引入数据库事务、真实模型与跨设备同步。',
      });
      updateWorkspace(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '生成结论卡失败');
    }
  }

  function integrateCard(cardId: string): void {
    try {
      const next = integrateConclusionCard(workspace, {
        cardId,
        commandId: `browser-integrate-${cardId}`,
      });
      updateWorkspace(next);
      setDraftOverride(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '回写主干失败');
    }
  }

  function changeLifecycle(lifecycle: 'active' | 'dormant' | 'metabolized'): void {
    if (!selectedBranch) return;
    try {
      updateWorkspace(setBranchLifecycle(workspace, { branchId: selectedBranch.id, lifecycle }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '改变分支状态失败');
    }
  }

  function resetDemo(): void {
    const next = createDemoWorkspace();
    window.localStorage.removeItem(storageKey);
    updateWorkspace(next);
    setSelectedBranchId(next.branches[0]?.id ?? '');
    setDraftOverride(null);
    setBranchMessage('');
    setError('');
  }

  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Gate 0 · 风险优先纵切</p>
          <h1>AI Super Canvas</h1>
        </div>
        <div className="header-actions">
          <span className="local-only">本地保存 · 不发送文本</span>
          <button className="quiet-button" type="button" onClick={resetDemo}>
            重置演示
          </button>
        </div>
      </header>

      <section className="guidance" aria-label="当前版本说明">
        <strong>可测试的核心闭环：</strong>选中主干文本创建锚点，进入独立分支探索，把结论卡明确回写为新的主干修订。
        演示 AI 不调用外部服务；数据库、真实模型和多用户同步尚未接入。
      </section>

      {error ? <p className="error-message" role="alert">{error}</p> : null}

      <section className="workspace-grid" aria-label="统一工作台">
        <article className="panel trunk-panel">
          <div className="panel-title-row">
            <div>
              <p className="panel-kicker">主干文档</p>
              <h2>主干修订 {workspace.trunk.revisions.length}</h2>
            </div>
            <span className="revision-id">{workspace.trunk.currentRevisionId}</span>
          </div>
          <label className="sr-only" htmlFor="trunk-text">主干文本</label>
          <textarea
            ref={trunkRef}
            id="trunk-text"
            aria-label="主干文本"
            value={draft}
            onChange={(event) => setDraftOverride(event.target.value)}
            onSelect={captureSelection}
            onKeyUp={captureSelection}
            onMouseUp={captureSelection}
          />
          <div className="toolbar">
            <button className="secondary-button" type="button" onClick={() => saveTrunk()}>
              保存主干修订
            </button>
            <button className="primary-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={createBranch}>
              从选区创建分支
            </button>
          </div>
          <p className="hint">选择词、句或段落后创建分支。锚点绑定当前修订，并以 Unicode code point 记录位置。</p>
        </article>

        <aside className="panel branch-list-panel" aria-label="分支列表">
          <div className="panel-title-row">
            <div>
              <p className="panel-kicker">分支</p>
              <h2>{workspace.branches.length} 条探索</h2>
            </div>
          </div>
          <div className="branch-list">
            {workspace.branches.map((branch) => {
              const anchor = workspace.anchors.find((candidate) => candidate.id === branch.anchorId);
              return (
                <button
                  className={branch.id === selectedBranchId ? 'branch-item selected' : 'branch-item'}
                  key={branch.id}
                  type="button"
                  onClick={() => setSelectedBranchId(branch.id)}
                >
                  <span>{branch.title}</span>
                  <small>锚点：{anchor?.selector.exact ?? '不可用'} · {lifecycleLabel(branch.lifecycle)}</small>
                </button>
              );
            })}
          </div>
        </aside>

        <article className="panel branch-panel">
          {selectedBranch ? (
            <>
              <div className="panel-title-row">
                <div>
                  <p className="panel-kicker">独立分支</p>
                  <h2>{selectedBranch.title}</h2>
                </div>
                <span className="status-pill">{lifecycleLabel(selectedBranch.lifecycle)}</span>
              </div>

              <div className="messages" aria-label="分支讨论">
                {selectedMessages.map((message) => (
                  <p className={`message ${message.author}`} key={message.id}>
                    <span>{message.author === 'demo-ai' ? '演示 AI' : message.author === 'user' ? '你' : '系统'}</span>
                    {message.content}
                  </p>
                ))}
              </div>

              <label className="sr-only" htmlFor="branch-message">分支消息</label>
              <textarea
                id="branch-message"
                aria-label="分支消息"
                placeholder="记录这一条探索…"
                value={branchMessage}
                onChange={(event) => setBranchMessage(event.target.value)}
              />
              <div className="toolbar compact">
                <button className="secondary-button" type="button" onClick={submitMessage}>
                  写入分支
                </button>
                <button className="primary-button" type="button" onClick={createDemoCard}>
                  生成演示结论卡
                </button>
              </div>

              <div className="lifecycle-actions" aria-label="分支生命周期">
                {selectedBranch.lifecycle === 'active' ? (
                  <button type="button" onClick={() => changeLifecycle('dormant')}>设为休眠</button>
                ) : null}
                {selectedBranch.lifecycle === 'dormant' ? (
                  <button type="button" onClick={() => changeLifecycle('active')}>恢复分支</button>
                ) : null}
                {selectedBranch.lifecycle !== 'metabolized' ? (
                  <button type="button" onClick={() => changeLifecycle('metabolized')}>腐殖化分支</button>
                ) : null}
              </div>
            </>
          ) : null}
        </article>

        <article className="panel cards-panel">
          <div className="panel-title-row">
            <div>
              <p className="panel-kicker">结论卡</p>
              <h2>显式确认后回写</h2>
            </div>
          </div>
          {selectedCards.length ? selectedCards.map((card) => (
            <section className="card" key={card.id}>
              <div>
                <h3>{card.title}</h3>
                <span>{card.status === 'integrated' ? '已回写' : '待确认'}</span>
              </div>
              <p>{card.content}</p>
              {card.status === 'ready' ? (
                <button className="primary-button" type="button" onClick={() => integrateCard(card.id)}>
                  回写主干
                </button>
              ) : null}
            </section>
          )) : <p className="empty-state">先在分支中记录探索，再生成一张结论卡。</p>}
        </article>

        <article className="panel timeline-panel">
          <div className="panel-title-row">
            <div>
              <p className="panel-kicker">生长时间线</p>
              <h2>可追溯操作</h2>
            </div>
          </div>
          <ol>
            {[...workspace.events].reverse().map((item) => (
              <li key={item.id}>
                <strong>{item.summary}</strong>
                <time dateTime={item.createdAt}>{formatEventTime(item.createdAt)}</time>
              </li>
            ))}
          </ol>
        </article>
      </section>
    </main>
  );
}
