import { describe, expect, it } from 'vitest';
import {
  composerTargetLabel,
  initialCanvasLayout,
  moveCanvasNode,
  panCanvas,
  setCanvasNodeModel,
  zoomCanvas,
} from './canvas-state';

describe('canvas interaction state', () => {
  it('keeps a branch selection explicit in the Composer target', () => {
    expect(composerTargetLabel({ kind: 'branch', title: '回流策略' })).toBe('分支：回流策略');
    expect(composerTargetLabel({ kind: 'trunk', title: '主干活文档' })).toBe('主干');
  });

  it('records manual node placement independently from the domain object', () => {
    const initial = initialCanvasLayout();
    const moved = moveCanvasNode(initial, 'branch-1', { x: 718, y: 212 });

    expect(initial.positions).toEqual({});
    expect(moved.positions['branch-1']).toEqual({ x: 718, y: 212, pinned: true });
  });

  it('clamps canvas zoom to a usable desktop range', () => {
    expect(zoomCanvas(initialCanvasLayout(), 10).viewport.zoom).toBe(1.45);
    expect(zoomCanvas(initialCanvasLayout(), -10).viewport.zoom).toBe(0.55);
  });

  it('derives consecutive pan positions from the fixed gesture origin', () => {
    const initial = {
      ...initialCanvasLayout(),
      viewport: { x: 40, y: -20, zoom: 1 },
    };
    const gesture = { startX: 100, startY: 80, baseX: 40, baseY: -20 };

    const afterFirstMove = panCanvas(initial, gesture, { x: 112, y: 88 });
    const afterSecondMove = panCanvas(afterFirstMove, gesture, { x: 130, y: 105 });

    expect(afterFirstMove.viewport).toEqual({ x: 52, y: -12, zoom: 1 });
    expect(afterSecondMove.viewport).toEqual({ x: 70, y: 5, zoom: 1 });
    expect(initial.viewport).toEqual({ x: 40, y: -20, zoom: 1 });
  });

  it('stores a model override on its own block', () => {
    const initial = initialCanvasLayout();

    expect(setCanvasNodeModel(initial, 'branch-1', 'gpt-5-mini').modelByNodeId).toEqual({
      'branch-1': 'gpt-5-mini',
    });
  });
});
