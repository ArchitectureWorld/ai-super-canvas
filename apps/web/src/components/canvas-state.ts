export interface CanvasPosition {
  x: number;
  y: number;
  pinned: boolean;
}

export interface CanvasLayoutState {
  positions: Record<string, CanvasPosition>;
  selectedNodeId: string | null;
  viewport: { x: number; y: number; zoom: number };
}

export interface ComposerTarget {
  kind: 'trunk' | 'branch' | 'anchor' | 'outcome';
  title: string;
}

export function initialCanvasLayout(): CanvasLayoutState {
  return {
    positions: {},
    selectedNodeId: 'branch-initial',
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export function composerTargetLabel(target: ComposerTarget): string {
  if (target.kind === 'trunk') return '主干';
  if (target.kind === 'anchor') return `锚点：“${target.title}”`;
  if (target.kind === 'outcome') return '完善成果';
  return `分支：${target.title}`;
}

export function moveCanvasNode(
  state: CanvasLayoutState,
  nodeId: string,
  position: Pick<CanvasPosition, 'x' | 'y'>,
): CanvasLayoutState {
  return {
    ...state,
    positions: {
      ...state.positions,
      [nodeId]: { ...position, pinned: true },
    },
  };
}

export function zoomCanvas(state: CanvasLayoutState, delta: number): CanvasLayoutState {
  const zoom = Math.max(0.55, Math.min(1.45, state.viewport.zoom + delta * 0.1));
  return { ...state, viewport: { ...state.viewport, zoom } };
}
