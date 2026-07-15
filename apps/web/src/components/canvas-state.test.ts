import { describe, expect, it } from 'vitest';
import { composerTargetLabel, initialCanvasLayout, moveCanvasNode, zoomCanvas } from './canvas-state';

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
});
