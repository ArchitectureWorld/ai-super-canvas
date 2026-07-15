'use client';

import {
  addBranchMessage,
  createBranchFromSelection,
  createConclusionCard,
  createDemoWorkspace,
  currentTrunkContent,
  integrateConclusionCard,
  projectGrowth,
  reviseTrunk,
  setBranchLifecycle,
  type GrowthEdge,
  type GrowthNode,
  type WorkspaceState,
} from '@ai-super-canvas/core';
import {
  composerTargetLabel,
  initialCanvasLayout,
  moveCanvasNode,
  zoomCanvas,
  type CanvasLayoutState,
} from './canvas-state';
import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

const storageKey = 'ai-super-canvas.gate-0.workspace.v1';
const layoutStorageKey = 'ai-super-canvas.gate-0.canvas-layout.v1';
const workspaceChangedEvent = 'ai-super-canvas:workspace-changed';
let workspaceSnapshot: WorkspaceState | undefined;

function loadWorkspace(): WorkspaceState {
  if (typeof window === 'undefined') return createDemoWorkspace();
  const saved = window.localStorage.getItem(storageKey);
  if (!saved) return createDemoWorkspace();
  try {
    const parsed = JSON.parse(saved) as WorkspaceState;
    return parsed.version === 1 ? parsed : createDemoWorkspace();
  } catch {
    return createDemoWorkspace();
  }
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

function lifecycleLabel(lifecycle: string): string {
  return ({ active: '探索中', dormant: '休眠', metabolized: '已代谢' } as Record<string, string>)[lifecycle] ?? lifecycle;
}

function nodeIcon(kind: GrowthNode['kind']): string {
  return ({ trunk: '干', branch: '枝', outcome: '果', humus: '壤' } as Record<GrowthNode['kind'], string>)[kind];
}

function edgePath(edge: GrowthEdge, nodeById: Map<string, GrowthNode>): string | null {
  const source = nodeById.get(edge.sourceId);
  const target = nodeById.get(edge.targetId);
  if (!source || !target) return null;
  const sx = source.x + 185;
  const sy = source.y + 96;
  const tx = target.x;
  const ty = target.y + 88;
  const bend = edge.kind === 'feedback' ? -220 : Math.max(90, (tx - sx) * 0.46);
  return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`;
}

function readableCardStatus(status: string): string {
  return status === 'integrated' ? '已回写成果' : '待确认成果';
}

function initialStoredCanvasLayout(): CanvasLayoutState {
  if (typeof window === 'undefined') return initialCanvasLayout();
  const saved = window.localStorage.getItem(layoutStorageKey);
  if (!saved) return initialCanvasLayout();
  try {
    const parsed = JSON.parse(saved) as CanvasLayoutState;
    return parsed.viewport && parsed.positions ? parsed : initialCanvasLayout();
  } catch {
    window.localStorage.removeItem(layoutStorageKey);
    return initialCanvasLayout();
  }
}

export function WorkspacePrototype() {
  const workspace = useSyncExternalStore(subscribeToWorkspace, getWorkspaceSnapshot, createDemoWorkspace);
  const [layout, setLayout] = useState<CanvasLayoutState>(initialStoredCanvasLayout);
  const [draftOverride, setDraftOverride] = useState<string | null>(null);
  const [branchMessage, setBranchMessage] = useState('');
  const [error, setError] = useState('');
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [previewCardId, setPreviewCardId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ nodeId: string; startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const [pan, setPan] = useState<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const trunkRef = useRef<HTMLTextAreaElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const draft = draftOverride ?? currentTrunkContent(workspace);
  const projection = useMemo(() => projectGrowth(workspace), [workspace]);

  useEffect(() => {
    window.localStorage.setItem(layoutStorageKey, JSON.stringify(layout));
  }, [layout]);

  const nodes = projection.nodes.map((node) => {
    const override = layout.positions[node.id];
    return override ? { ...node, x: override.x, y: override.y } : node;
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const selectedNode = layout.selectedNodeId ? nodeById.get(layout.selectedNodeId) : undefined;
  const selectedBranch = selectedNode?.branchId
    ? workspace.branches.find((branch) => branch.id === selectedNode.branchId)
    : undefined;
  const selectedCard = selectedNode?.cardId
    ? workspace.cards.find((card) => card.id === selectedNode.cardId)
    : undefined;
  const selectedMessages = selectedBranch
    ? workspace.messages.filter((message) => message.branchId === selectedBranch.id)
    : [];
  const hasSelection = selection.end > selection.start;
  const composerTarget = selectedBranch
    ? { kind: 'branch' as const, title: selectedBranch.title }
    : { kind: 'trunk' as const, title: '主干活文档' };

  function updateWorkspace(next: WorkspaceState): void {
    persistWorkspace(next);
    setError('');
  }

  function saveTrunk(): WorkspaceState {
    try {
      const next = reviseTrunk(workspace, draft);
      if (next !== workspace) updateWorkspace(next);
      setDraftOverride(null);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存主干失败');
      return workspace;
    }
  }

  function captureSelection(): void {
    const textarea = trunkRef.current;
    if (textarea) setSelection({ start: textarea.selectionStart, end: textarea.selectionEnd });
  }

  function createBranch(): void {
    if (!hasSelection) return;
    try {
      const source = draft === currentTrunkContent(workspace) ? workspace : reviseTrunk(workspace, draft);
      const next = createBranchFromSelection(source, {
        selectionStart: selection.start,
        selectionEnd: selection.end,
        title: '',
      });
      updateWorkspace(next);
      setDraftOverride(null);
      setSelection({ start: 0, end: 0 });
      setLayout((current) => ({ ...current, selectedNodeId: next.branches.at(-1)?.id ?? 'trunk' }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建分支失败');
    }
  }

  function submitMessage(): void {
    if (!selectedBranch || selectedBranch.lifecycle !== 'active' || !branchMessage.trim()) return;
    try {
      updateWorkspace(addBranchMessage(workspace, {
        branchId: selectedBranch.id,
        content: branchMessage,
        author: 'user',
      }));
      setBranchMessage('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '写入分支失败');
    }
  }

  function createOutcome(): void {
    if (!selectedBranch) return;
    try {
      const next = createConclusionCard(workspace, {
        branchId: selectedBranch.id,
        title: `关于「${selectedBranch.title}」的结论`,
        content: '将独立讨论保留为证据链；确认后的成果只通过新的主干修订回流。',
      });
      updateWorkspace(next);
      setLayout((current) => ({ ...current, selectedNodeId: next.cards.at(-1)?.id ?? selectedBranch.id }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '提炼成果失败');
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
      setPreviewCardId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '回写主干失败');
    }
  }

  function changeLifecycle(lifecycle: 'active' | 'dormant' | 'metabolized'): void {
    if (!selectedBranch) return;
    try {
      const next = setBranchLifecycle(workspace, { branchId: selectedBranch.id, lifecycle });
      updateWorkspace(next);
      setLayout((current) => ({
        ...current,
        selectedNodeId: lifecycle === 'metabolized' ? `humus-${selectedBranch.id}` : selectedBranch.id,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '改变分支状态失败');
    }
  }

  function resetDemo(): void {
    window.localStorage.removeItem(storageKey);
    window.localStorage.removeItem(layoutStorageKey);
    const next = createDemoWorkspace();
    updateWorkspace(next);
    setLayout(initialCanvasLayout());
    setDraftOverride(null);
    setBranchMessage('');
    setError('');
    setPreviewCardId(null);
  }

  function beginNodeDrag(event: ReactPointerEvent<HTMLDivElement>, node: GrowthNode): void {
    event.stopPropagation();
    const current = nodeById.get(node.id) ?? node;
    setLayout((state) => ({ ...state, selectedNodeId: node.id }));
    setDrag({ nodeId: node.id, startX: event.clientX, startY: event.clientY, baseX: current.x, baseY: current.y });
  }

  function handleCanvasMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (drag) {
      const x = drag.baseX + (event.clientX - drag.startX) / layout.viewport.zoom;
      const y = drag.baseY + (event.clientY - drag.startY) / layout.viewport.zoom;
      setLayout((state) => moveCanvasNode(state, drag.nodeId, { x, y }));
    }
    if (pan) {
      setLayout((state) => ({
        ...state,
        viewport: {
          ...state.viewport,
          x: pan.baseX + event.clientX - pan.startX,
          y: pan.baseY + event.clientY - pan.startY,
        },
      }));
    }
  }

  function handleCanvasWheel(event: WheelEvent<HTMLDivElement>): void {
    event.preventDefault();
    setLayout((state) => zoomCanvas(state, event.deltaY < 0 ? 1 : -1));
  }

  return (
    <main className="growth-workspace">
      <header className="canvas-topbar">
        <div className="brand-mark">S</div>
        <div className="breadcrumbs"><span>Garden</span><span>/</span><strong>AI 原生创作工作流</strong><span>⌄</span></div>
        <div className="topbar-divider" />
        <div className="view-tabs"><span className="active">生长图</span><span>时间线</span></div>
        <div className="topbar-spacer" />
        <span className="saved-state">全部变更已保存在本机</span>
        <button className="topbar-button" type="button" onClick={() => setLayout(initialCanvasLayout())}>适配视图</button>
        <button className="topbar-button" type="button" onClick={resetDemo}>重置示例</button>
        <button className="topbar-button primary" type="button">分享</button>
      </header>

      {error ? <p className="canvas-error" role="alert">{error}</p> : null}

      <section
        className="canvas-stage"
        ref={canvasRef}
        aria-label="结构化生长画布"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            setPan({ startX: event.clientX, startY: event.clientY, baseX: layout.viewport.x, baseY: layout.viewport.y });
          }
        }}
        onPointerMove={handleCanvasMove}
        onPointerUp={() => { setDrag(null); setPan(null); }}
        onPointerLeave={() => { setDrag(null); setPan(null); }}
        onWheel={handleCanvasWheel}
      >
        <aside className="canvas-rail" aria-label="画布工具">
          <button className="active" type="button" aria-label="选择工具">↖</button>
          <button type="button" aria-label="添加">＋</button>
          <button type="button" aria-label="搜索">⌕</button>
          <button type="button" aria-label="历史">◷</button>
        </aside>
        <div className="growth-mode"><i /> <strong>生长视图</strong><span>聚焦当前主问题</span><span>⌄</span></div>

        <div
          className="canvas-plane"
          style={{ transform: `translate(${layout.viewport.x}px, ${layout.viewport.y}px) scale(${layout.viewport.zoom})` }}
        >
          <svg className="growth-edges" viewBox="0 0 1500 900" aria-hidden="true">
            {projection.edges.map((edge) => {
              const path = edgePath(edge, nodeById);
              return path ? <path className={`growth-edge ${edge.kind}`} d={path} key={edge.id} /> : null;
            })}
          </svg>

          {nodes.map((node) => {
            const isSelected = node.id === layout.selectedNodeId;
            const branch = node.branchId ? workspace.branches.find((item) => item.id === node.branchId) : undefined;
            const card = node.cardId ? workspace.cards.find((item) => item.id === node.cardId) : undefined;
            return (
              <article
                className={`growth-node ${node.kind} ${isSelected ? 'selected' : ''} ${node.status ?? ''}`}
                key={node.id}
                style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
                onClick={() => setLayout((state) => ({ ...state, selectedNodeId: node.id }))}
              >
                <div className="node-drag-handle" onPointerDown={(event) => beginNodeDrag(event, node)}>
                  <span className="node-icon">{nodeIcon(node.kind)}</span>
                  <strong>{node.kind === 'trunk' ? '主干 · 活文档' : node.kind === 'outcome' ? readableCardStatus(node.status ?? 'ready') : node.kind === 'humus' ? '经验 · 已沉淀' : '分支 · 独立探索'}</strong>
                  <span className="node-menu">•••</span>
                </div>
                <div className="node-content">
                  {node.kind === 'trunk' ? (
                    <>
                      <p className="node-kicker">CURRENT UNDERSTANDING · V{workspace.trunk.revisions.length}</p>
                      <textarea
                        ref={trunkRef}
                        aria-label="主干活文档"
                        className="trunk-editor"
                        value={draft}
                        onChange={(event) => setDraftOverride(event.target.value)}
                        onSelect={captureSelection}
                        onKeyUp={captureSelection}
                        onMouseUp={captureSelection}
                      />
                      <div className="trunk-node-actions">
                        <button type="button" onClick={saveTrunk}>保存修订</button>
                        {hasSelection ? <button className="sprout-button" type="button" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); createBranch(); }}>＋ 长出分支</button> : <span>选中一段文字，长出独立探索</span>}
                      </div>
                    </>
                  ) : node.kind === 'branch' && branch ? (
                    <>
                      <p className="node-kicker">源自锚点 · {workspace.anchors.find((item) => item.id === branch.anchorId)?.selector.exact ?? '已失效'}</p>
                      <h2>{branch.title}</h2>
                      <p>{workspace.messages.filter((item) => item.branchId === branch.id).at(-1)?.content ?? '等待一条探索。'}</p>
                      <div className="node-meta"><span className={`lifecycle-dot ${branch.lifecycle}`} />{lifecycleLabel(branch.lifecycle)}<span>{workspace.messages.filter((item) => item.branchId === branch.id).length} 条消息</span></div>
                    </>
                  ) : node.kind === 'outcome' && card ? (
                    <>
                      <p className="node-kicker">CONCLUSION CARD</p>
                      <h2>{card.title}</h2>
                      <p>{card.content}</p>
                      <button className="outcome-action" type="button" onClick={() => setPreviewCardId(card.id)}>{card.status === 'ready' ? '预览 Diff · 滋养主干 →' : '已回写为主干修订'}</button>
                    </>
                  ) : (
                    <>
                      <p className="node-kicker">METABOLIZED</p>
                      <h2>{node.title}</h2>
                      <p>保留来源与经验摘要，退出当前生长视图。</p>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {selectedNode ? (
          <aside className="context-inspector" aria-label="上下文检查器">
            <div className="inspector-header"><div><p>CONTEXT INSPECTOR</p><h2>{selectedNode.title}</h2></div><button type="button" onClick={() => setLayout((state) => ({ ...state, selectedNodeId: null }))}>×</button></div>
            {selectedBranch ? (
              <>
                <p className="inspector-source">来源锚点：{workspace.anchors.find((item) => item.id === selectedBranch.anchorId)?.selector.exact ?? '不可用'}</p>
                <div className="inspector-messages">{selectedMessages.map((message) => <p key={message.id}><b>{message.author === 'user' ? '你' : message.author === 'demo-ai' ? 'AI' : '系统'}</b>{message.content}</p>)}</div>
                <div className="inspector-actions"><button type="button" onClick={createOutcome} disabled={selectedBranch.lifecycle !== 'active'}>提炼成果</button>{selectedBranch.lifecycle === 'active' ? <button type="button" onClick={() => changeLifecycle('dormant')}>设为休眠</button> : null}{selectedBranch.lifecycle === 'dormant' ? <button type="button" onClick={() => changeLifecycle('active')}>恢复生长</button> : null}{selectedBranch.lifecycle !== 'metabolized' ? <button type="button" onClick={() => changeLifecycle('metabolized')}>代谢为经验</button> : null}</div>
              </>
            ) : null}
            {selectedCard ? <p className="inspector-source">成果状态：{readableCardStatus(selectedCard.status)}</p> : null}
            {previewCardId && selectedCard?.id === previewCardId && selectedCard.status === 'ready' ? <div className="diff-preview"><p>将把以下内容追加为新的主干修订：</p><pre>## {selectedCard.title}{'\n'}{selectedCard.content}</pre><button type="button" onClick={() => integrateCard(selectedCard.id)}>确认回写主干</button></div> : null}
          </aside>
        ) : null}

        <form className="canvas-composer" onSubmit={(event) => { event.preventDefault(); submitMessage(); }}>
          <div className="composer-chips"><span>{composerTargetLabel(composerTarget)}</span><span>{selectedBranch ? `${selectedMessages.length} 条消息` : '选择主干文字以创建分支'}</span></div>
          <div className="composer-row"><button type="button" className="composer-add" aria-label="添加上下文">＋</button><input aria-label="AI Composer" value={branchMessage} disabled={!selectedBranch || selectedBranch.lifecycle !== 'active'} placeholder={selectedBranch?.lifecycle === 'dormant' ? '先恢复分支再继续探索' : selectedBranch ? '让这个分支继续生长…' : '请选择一个活跃分支'} onChange={(event) => setBranchMessage(event.target.value)} /><button className="composer-send" type="submit" disabled={!selectedBranch || !branchMessage.trim()}>↑</button></div>
        </form>

        <div className="zoom-controls"><button type="button" onClick={() => setLayout((state) => zoomCanvas(state, -1))}>−</button><span>{Math.round(layout.viewport.zoom * 100)}%</span><button type="button" onClick={() => setLayout((state) => zoomCanvas(state, 1))}>＋</button><button type="button" onClick={() => setLayout(initialCanvasLayout())}>⌗</button></div>
      </section>

      <section className="growth-timeline" aria-label="生长时间线"><strong>生长时间线</strong>{[...workspace.events].reverse().slice(0, 4).map((event) => <span key={event.id}>{event.summary}</span>)}</section>
    </main>
  );
}
