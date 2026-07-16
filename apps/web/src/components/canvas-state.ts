export interface CanvasPosition {
  x: number;
  y: number;
  pinned: boolean;
}

export interface CanvasLayoutState {
  positions: Record<string, CanvasPosition>;
  modelByNodeId: Record<string, string>;
  selectedNodeId: string | null;
  viewport: { x: number; y: number; zoom: number };
}

export interface CanvasPanGesture {
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
}

export interface ComposerTarget {
  kind: 'trunk' | 'branch' | 'anchor' | 'outcome';
  title: string;
}

export function initialCanvasLayout(): CanvasLayoutState {
  return {
    positions: {},
    modelByNodeId: {},
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

export function zoomCanvas(
  state: CanvasLayoutState,
  delta: number,
  focalPoint?: Pick<CanvasPosition, 'x' | 'y'>,
): CanvasLayoutState {
  const zoom = Math.max(0.55, Math.min(1.45, state.viewport.zoom + delta * 0.1));
  if (!focalPoint || zoom === state.viewport.zoom) {
    return { ...state, viewport: { ...state.viewport, zoom } };
  }

  return {
    ...state,
    viewport: {
      x: focalPoint.x - ((focalPoint.x - state.viewport.x) / state.viewport.zoom) * zoom,
      y: focalPoint.y - ((focalPoint.y - state.viewport.y) / state.viewport.zoom) * zoom,
      zoom,
    },
  };
}

export function panCanvas(
  state: CanvasLayoutState,
  gesture: CanvasPanGesture,
  pointer: Pick<CanvasPosition, 'x' | 'y'>,
): CanvasLayoutState {
  return {
    ...state,
    viewport: {
      ...state.viewport,
      x: gesture.baseX + pointer.x - gesture.startX,
      y: gesture.baseY + pointer.y - gesture.startY,
    },
  };
}

export function setCanvasNodeModel(
  state: CanvasLayoutState,
  nodeId: string,
  model: string,
): CanvasLayoutState {
  return {
    ...state,
    modelByNodeId: {
      ...state.modelByNodeId,
      [nodeId]: model,
    },
  };
}
