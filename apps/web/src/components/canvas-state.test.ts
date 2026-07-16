import { describe, expect, it } from 'vitest';
import {
  composerTargetLabel,
  initialCanvasLayout,
  isBranchComposerSubmitDisabled,
  moveCanvasNode,
  normalizeWheelZoomDelta,
  panCanvas,
  setCanvasNodeModel,
  zoomCanvas,
} from './canvas-state';

describe('canvas interaction state', () => {
  it('selects the trunk by default instead of exposing a branch Composer', () => {
    expect(initialCanvasLayout().selectedNodeId).toBe('trunk');
  });

  it('disables Composer submission for a dormant branch with a residual draft', () => {
    expect(isBranchComposerSubmitDisabled('dormant', '尚未发送的内容')).toBe(true);
  });

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

  it('returns zero when a wheel event has no vertical movement', () => {
    expect(normalizeWheelZoomDelta(0, 0)).toBe(0);
  });

  it('keeps small pixel wheel deltas proportional', () => {
    expect(normalizeWheelZoomDelta(-8, 0)).toBeCloseTo(0.08);
    expect(normalizeWheelZoomDelta(8, 0)).toBeCloseTo(-0.08);
  });

  it('normalizes line wheel deltas to pixel-sized zoom steps', () => {
    expect(normalizeWheelZoomDelta(-3, 1)).toBeCloseTo(0.48);
  });

  it('clamps page wheel deltas to one zoom step per event', () => {
    expect(normalizeWheelZoomDelta(-1, 2)).toBe(1);
    expect(normalizeWheelZoomDelta(1, 2)).toBe(-1);
  });

  it('keeps the focal world point fixed while zooming a translated canvas', () => {
    const initial = {
      ...initialCanvasLayout(),
      viewport: { x: 120, y: -80, zoom: 0.8 },
    };
    const focalPoint = { x: 420, y: 260 };
    const worldBefore = {
      x: (focalPoint.x - initial.viewport.x) / initial.viewport.zoom,
      y: (focalPoint.y - initial.viewport.y) / initial.viewport.zoom,
    };

    const zoomed = zoomCanvas(initial, 1, focalPoint);
    const worldAfter = {
      x: (focalPoint.x - zoomed.viewport.x) / zoomed.viewport.zoom,
      y: (focalPoint.y - zoomed.viewport.y) / zoomed.viewport.zoom,
    };

    expect(zoomed.viewport.zoom).toBeCloseTo(0.9);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y);
  });

  it.each([
    { zoom: 1.45, delta: 1 },
    { zoom: 0.55, delta: -1 },
  ])('does not move the viewport when zoom stays clamped at $zoom', ({ zoom, delta }) => {
    const initial = {
      ...initialCanvasLayout(),
      viewport: { x: 73, y: -41, zoom },
    };

    const zoomed = zoomCanvas(initial, delta, { x: 360, y: 240 });

    expect(zoomed.viewport).toEqual(initial.viewport);
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
