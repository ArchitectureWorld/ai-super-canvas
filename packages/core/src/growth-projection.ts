import type { Branch, ConclusionCard, WorkspaceState } from './workspace';

export type GrowthNodeKind = 'trunk' | 'branch' | 'outcome' | 'humus';
export type GrowthEdgeKind = 'derives' | 'outcome' | 'feedback' | 'metabolizes';

export interface GrowthNode {
  id: string;
  kind: GrowthNodeKind;
  title: string;
  x: number;
  y: number;
  status?: string;
  branchId?: string;
  cardId?: string;
}

export interface GrowthEdge {
  id: string;
  kind: GrowthEdgeKind;
  sourceId: string;
  targetId: string;
}

export interface GrowthProjection {
  nodes: GrowthNode[];
  edges: GrowthEdge[];
}

const trunkNode: GrowthNode = {
  id: 'trunk',
  kind: 'trunk',
  title: '主干活文档',
  x: 260,
  y: 260,
};

function branchPosition(index: number): Pick<GrowthNode, 'x' | 'y'> {
  const lane = Math.floor(index / 2) + 1;
  return {
    x: 650 + (lane - 1) * 250,
    y: index % 2 === 0 ? 120 + (lane - 1) * 90 : 470 + (lane - 1) * 90,
  };
}

function outcomePosition(branchIndex: number, cardIndex: number): Pick<GrowthNode, 'x' | 'y'> {
  const branch = branchPosition(branchIndex);
  return { x: branch.x + 310, y: branch.y + cardIndex * 175 };
}

function activeBranchNode(branch: Branch, index: number): GrowthNode {
  return {
    id: branch.id,
    kind: 'branch',
    title: branch.title,
    ...branchPosition(index),
    status: branch.lifecycle,
    branchId: branch.id,
  };
}

function outcomeNode(card: ConclusionCard, branchIndex: number, cardIndex: number): GrowthNode {
  return {
    id: card.id,
    kind: 'outcome',
    title: card.title,
    ...outcomePosition(branchIndex, cardIndex),
    status: card.status,
    branchId: card.branchId,
    cardId: card.id,
  };
}

export function projectGrowth(workspace: WorkspaceState): GrowthProjection {
  const nodes: GrowthNode[] = [trunkNode];
  const edges: GrowthEdge[] = [];
  const visibleBranches = workspace.branches.filter((branch) => branch.lifecycle !== 'metabolized');

  visibleBranches.forEach((branch, index) => {
    nodes.push(activeBranchNode(branch, index));
    edges.push({
      id: `derives-${branch.id}`,
      kind: 'derives',
      sourceId: 'trunk',
      targetId: branch.id,
    });
  });

  workspace.branches
    .filter((branch) => branch.lifecycle === 'metabolized')
    .forEach((branch, index) => {
      const humusId = `humus-${branch.id}`;
      nodes.push({
        id: humusId,
        kind: 'humus',
        title: `${branch.title} · 经验沉淀`,
        x: 1080,
        y: 500 + index * 155,
        status: 'metabolized',
        branchId: branch.id,
      });
      edges.push({
        id: `metabolizes-${branch.id}`,
        kind: 'metabolizes',
        sourceId: branch.id,
        targetId: humusId,
      });
    });

  visibleBranches.forEach((branch, branchIndex) => {
    const cards = workspace.cards.filter((card) => card.branchId === branch.id);
    cards.forEach((card, cardIndex) => {
      nodes.push(outcomeNode(card, branchIndex, cardIndex));
      edges.push({
        id: `outcome-${card.id}`,
        kind: 'outcome',
        sourceId: branch.id,
        targetId: card.id,
      });
      if (card.status === 'integrated') {
        edges.push({
          id: `feedback-${card.id}`,
          kind: 'feedback',
          sourceId: card.id,
          targetId: 'trunk',
        });
      }
    });
  });

  return { nodes, edges };
}
