import { describe, expect, it } from 'vitest';
import {
  createConclusionCard,
  createDemoWorkspace,
  integrateConclusionCard,
  setBranchLifecycle,
} from './index';
import { projectGrowth } from './growth-projection';

describe('growth projection', () => {
  it('projects the trunk and active branch into a stable left-to-right growth layout', () => {
    const workspace = createDemoWorkspace();
    const projection = projectGrowth(workspace);

    expect(projection.nodes).toContainEqual(
      expect.objectContaining({ id: 'trunk', kind: 'trunk', x: 260, y: 260 }),
    );
    expect(projection.nodes).toContainEqual(
      expect.objectContaining({ id: workspace.branches[0].id, kind: 'branch', x: 650 }),
    );
    expect(projection.edges).toContainEqual(
      expect.objectContaining({
        kind: 'derives',
        sourceId: 'trunk',
        targetId: workspace.branches[0].id,
      }),
    );
  });

  it('turns an integrated outcome into a feedback arc instead of rewriting the branch node', () => {
    const workspace = createDemoWorkspace();
    const withCard = createConclusionCard(workspace, {
      branchId: workspace.branches[0].id,
      title: '保留不可变讨论历史',
      content: '回流只创建新的主干修订。',
    });
    const integrated = integrateConclusionCard(withCard, {
      cardId: withCard.cards[0].id,
      commandId: 'projection-card-command',
    });
    const projection = projectGrowth(integrated);

    expect(projection.nodes).toContainEqual(
      expect.objectContaining({ id: withCard.cards[0].id, kind: 'outcome', status: 'integrated' }),
    );
    expect(projection.edges).toContainEqual(
      expect.objectContaining({
        kind: 'feedback',
        sourceId: withCard.cards[0].id,
        targetId: 'trunk',
      }),
    );
  });

  it('replaces metabolized branches with a traceable humus projection', () => {
    const workspace = createDemoWorkspace();
    const metabolized = setBranchLifecycle(workspace, {
      branchId: workspace.branches[0].id,
      lifecycle: 'metabolized',
    });
    const projection = projectGrowth(metabolized);

    expect(projection.nodes).not.toContainEqual(
      expect.objectContaining({ id: workspace.branches[0].id, kind: 'branch' }),
    );
    expect(projection.nodes).toContainEqual(
      expect.objectContaining({ id: `humus-${workspace.branches[0].id}`, kind: 'humus' }),
    );
    expect(projection.edges).toContainEqual(
      expect.objectContaining({
        kind: 'metabolizes',
        sourceId: workspace.branches[0].id,
        targetId: `humus-${workspace.branches[0].id}`,
      }),
    );
  });
});
