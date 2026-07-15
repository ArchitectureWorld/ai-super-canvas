import { describe, expect, it } from 'vitest';
import {
  addBranchMessage,
  createConclusionCard,
  createDemoWorkspace,
  createTextAnchor,
  integrateConclusionCard,
  transitionBranch,
} from './index';

describe('workspace vertical slice', () => {
  it('creates a deterministic initial workspace for server/client hydration', () => {
    expect(createDemoWorkspace()).toEqual(createDemoWorkspace());
  });

  it('stores browser UTF-16 selections as Unicode code point anchors', () => {
    const anchor = createTextAnchor({
      sourceRevisionId: 'revision-1',
      sourceContent: 'A🙂B',
      selectionStart: 1,
      selectionEnd: 3,
    });

    expect(anchor.selector).toMatchObject({
      exact: '🙂',
      start: 1,
      end: 2,
      positionUnit: 'unicode-code-point',
    });
  });

  it('rejects an empty selection instead of creating a drifting anchor', () => {
    expect(() =>
      createTextAnchor({
        sourceRevisionId: 'revision-1',
        sourceContent: '主干文本',
        selectionStart: 2,
        selectionEnd: 2,
      }),
    ).toThrow('Anchor selection must not be empty');
  });

  it('writes a conclusion through an idempotent command and creates a new revision', () => {
    const workspace = createDemoWorkspace();
    const withMessage = addBranchMessage(workspace, {
      branchId: workspace.branches[0].id,
      content: '把核心约束整理成一个可检验的决策。',
      author: 'user',
    });
    const withCard = createConclusionCard(withMessage, {
      branchId: withMessage.branches[0].id,
      title: '先验证可回写闭环',
      content: '先用可操作纵切验证锚点、分支和回写，再扩展基础设施。',
    });
    const first = integrateConclusionCard(withCard, {
      cardId: withCard.cards[0].id,
      commandId: 'command-integrate-1',
    });
    const duplicate = integrateConclusionCard(first, {
      cardId: withCard.cards[0].id,
      commandId: 'command-integrate-1',
    });

    expect(first.trunk.revisions).toHaveLength(2);
    expect(first.trunk.currentRevisionId).not.toBe(workspace.trunk.currentRevisionId);
    expect(first.cards[0].status).toBe('integrated');
    expect(duplicate).toBe(first);
  });

  it('allows a dormant branch to resume but keeps metabolized branches terminal', () => {
    expect(transitionBranch('dormant', 'active')).toBe('active');
    expect(() => transitionBranch('metabolized', 'active')).toThrow(
      'Invalid branch transition',
    );
  });
});
