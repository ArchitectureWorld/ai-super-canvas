export const CORE_PACKAGE_NAME = '@ai-super-canvas/core' as const;

export type RuntimeTarget = 'browser' | 'server';

export { codePointOffset } from './text-position';
export { projectGrowth } from './growth-projection';
export type {
  GrowthEdge,
  GrowthEdgeKind,
  GrowthNode,
  GrowthNodeKind,
  GrowthProjection,
} from './growth-projection';
export {
  addBranchMessage,
  createBranchFromSelection,
  createConclusionCard,
  createDemoWorkspace,
  createTextAnchor,
  currentTrunkContent,
  integrateConclusionCard,
  reviseTrunk,
  setBranchLifecycle,
  transitionBranch,
} from './workspace';
export type {
  Branch,
  BranchLifecycle,
  BranchMessage,
  CardStatus,
  ConclusionCard,
  MessageAuthor,
  TextAnchor,
  TrunkRevision,
  WorkspaceEvent,
  WorkspaceState,
} from './workspace';
