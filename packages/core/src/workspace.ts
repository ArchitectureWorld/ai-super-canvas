import { codePointOffset } from './text-position';

export type BranchLifecycle = 'active' | 'dormant' | 'metabolized';
export type CardStatus = 'ready' | 'integrated';
export type MessageAuthor = 'user' | 'demo-ai' | 'system';

export interface TrunkRevision {
  id: string;
  content: string;
  createdAt: string;
  reason: 'initial' | 'edit' | 'conclusion-integration';
}

export interface TextAnchor {
  id: string;
  sourceRevisionId: string;
  selector: {
    exact: string;
    start: number;
    end: number;
    positionUnit: 'unicode-code-point';
  };
  createdAt: string;
}

export interface BranchMessage {
  id: string;
  branchId: string;
  content: string;
  author: MessageAuthor;
  createdAt: string;
}

export interface Branch {
  id: string;
  anchorId: string;
  title: string;
  lifecycle: BranchLifecycle;
  createdAt: string;
}

export interface ConclusionCard {
  id: string;
  branchId: string;
  title: string;
  content: string;
  status: CardStatus;
  integratedRevisionId?: string;
  createdAt: string;
}

export interface WorkspaceEvent {
  id: string;
  type:
    | 'anchor.created'
    | 'branch.created'
    | 'message.added'
    | 'card.created'
    | 'card.integrated'
    | 'branch.lifecycle-changed'
    | 'trunk.revised';
  summary: string;
  createdAt: string;
}

export interface WorkspaceState {
  version: 1;
  trunk: {
    currentRevisionId: string;
    revisions: TrunkRevision[];
  };
  anchors: TextAnchor[];
  branches: Branch[];
  messages: BranchMessage[];
  cards: ConclusionCard[];
  events: WorkspaceEvent[];
  commandReceipts: string[];
}

let idSequence = 0;

function createId(prefix: string): string {
  idSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSequence.toString(36)}`;
}

function now(): string {
  return new Date().toISOString();
}

function event(type: WorkspaceEvent['type'], summary: string): WorkspaceEvent {
  return { id: createId('event'), type, summary, createdAt: now() };
}

export function currentTrunkContent(workspace: WorkspaceState): string {
  const current = workspace.trunk.revisions.find(
    (revision) => revision.id === workspace.trunk.currentRevisionId,
  );
  if (!current) {
    throw new Error('Workspace has no current trunk revision');
  }
  return current.content;
}

export function createTextAnchor(input: {
  sourceRevisionId: string;
  sourceContent: string;
  selectionStart: number;
  selectionEnd: number;
}): TextAnchor {
  const { sourceContent, selectionStart, selectionEnd } = input;
  if (selectionStart === selectionEnd) {
    throw new Error('Anchor selection must not be empty');
  }
  if (selectionStart > selectionEnd) {
    throw new Error('Anchor selection start must precede its end');
  }

  const exact = sourceContent.slice(selectionStart, selectionEnd);
  if (!exact) {
    throw new Error('Anchor selection must not be empty');
  }

  return {
    id: createId('anchor'),
    sourceRevisionId: input.sourceRevisionId,
    selector: {
      exact,
      start: codePointOffset(sourceContent, selectionStart),
      end: codePointOffset(sourceContent, selectionEnd),
      positionUnit: 'unicode-code-point',
    },
    createdAt: now(),
  };
}

export function createDemoWorkspace(): WorkspaceState {
  const createdAt = '2026-07-15T00:00:00.000Z';
  const content =
    '从一个清晰的问题开始：如何让探索性对话既能自由分叉，也能把经过确认的结论稳定回写到主干？';
  const revision: TrunkRevision = {
    id: 'revision-initial',
    content,
    createdAt,
    reason: 'initial',
  };
  const anchorStart = content.indexOf('探索性对话');
  const anchor: TextAnchor = {
    id: 'anchor-initial',
    sourceRevisionId: revision.id,
    selector: {
      exact: '探索性对话',
      start: codePointOffset(content, anchorStart),
      end: codePointOffset(content, anchorStart + '探索性对话'.length),
      positionUnit: 'unicode-code-point',
    },
    createdAt,
  };
  const branch: Branch = {
    id: 'branch-initial',
    anchorId: anchor.id,
    title: '探索可回写的分支',
    lifecycle: 'active',
    createdAt,
  };

  return {
    version: 1,
    trunk: { currentRevisionId: revision.id, revisions: [revision] },
    anchors: [anchor],
    branches: [branch],
    messages: [
      {
        id: 'message-initial',
        branchId: branch.id,
        author: 'system',
        content: '这个分支保留独立讨论；只有结论卡被明确确认后才会回写主干。',
        createdAt,
      },
    ],
    cards: [],
    events: [
      { id: 'event-initial-anchor', type: 'anchor.created', summary: '创建示例锚点“探索性对话”', createdAt },
      { id: 'event-initial-branch', type: 'branch.created', summary: '长出示例分支“探索可回写的分支”', createdAt },
    ],
    commandReceipts: [],
  };
}

export function reviseTrunk(
  workspace: WorkspaceState,
  content: string,
): WorkspaceState {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('Trunk content must not be empty');
  }
  if (trimmed === currentTrunkContent(workspace)) {
    return workspace;
  }
  const revision: TrunkRevision = {
    id: createId('revision'),
    content: trimmed,
    createdAt: now(),
    reason: 'edit',
  };
  return {
    ...workspace,
    trunk: {
      currentRevisionId: revision.id,
      revisions: [...workspace.trunk.revisions, revision],
    },
    events: [...workspace.events, event('trunk.revised', '保存主干文本的新修订')],
  };
}

export function createBranchFromSelection(
  workspace: WorkspaceState,
  input: { selectionStart: number; selectionEnd: number; title: string },
): WorkspaceState {
  const sourceRevisionId = workspace.trunk.currentRevisionId;
  const anchor = createTextAnchor({
    sourceRevisionId,
    sourceContent: currentTrunkContent(workspace),
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
  });
  const branch: Branch = {
    id: createId('branch'),
    anchorId: anchor.id,
    title: input.title.trim() || `围绕“${anchor.selector.exact}”的探索`,
    lifecycle: 'active',
    createdAt: now(),
  };
  return {
    ...workspace,
    anchors: [...workspace.anchors, anchor],
    branches: [...workspace.branches, branch],
    messages: [
      ...workspace.messages,
      {
        id: createId('message'),
        branchId: branch.id,
        author: 'system',
        content: `分支来自锚点“${anchor.selector.exact}”。先保留探索，再决定是否提炼结论。`,
        createdAt: now(),
      },
    ],
    events: [
      ...workspace.events,
      event('anchor.created', `创建锚点“${anchor.selector.exact}”`),
      event('branch.created', `长出分支“${branch.title}”`),
    ],
  };
}

export function addBranchMessage(
  workspace: WorkspaceState,
  input: { branchId: string; content: string; author: MessageAuthor },
): WorkspaceState {
  if (!workspace.branches.some((branch) => branch.id === input.branchId)) {
    throw new Error('Branch does not exist');
  }
  const content = input.content.trim();
  if (!content) {
    throw new Error('Branch message must not be empty');
  }
  return {
    ...workspace,
    messages: [
      ...workspace.messages,
      {
        id: createId('message'),
        branchId: input.branchId,
        content,
        author: input.author,
        createdAt: now(),
      },
    ],
    events: [...workspace.events, event('message.added', '分支增加一条探索消息')],
  };
}

export function createConclusionCard(
  workspace: WorkspaceState,
  input: { branchId: string; title: string; content: string },
): WorkspaceState {
  if (!workspace.branches.some((branch) => branch.id === input.branchId)) {
    throw new Error('Branch does not exist');
  }
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || !content) {
    throw new Error('Conclusion card needs a title and content');
  }
  const card: ConclusionCard = {
    id: createId('card'),
    branchId: input.branchId,
    title,
    content,
    status: 'ready',
    createdAt: now(),
  };
  return {
    ...workspace,
    cards: [...workspace.cards, card],
    events: [...workspace.events, event('card.created', `提炼结论卡“${title}”`)],
  };
}

export function integrateConclusionCard(
  workspace: WorkspaceState,
  input: { cardId: string; commandId: string },
): WorkspaceState {
  if (workspace.commandReceipts.includes(input.commandId)) {
    return workspace;
  }
  const card = workspace.cards.find((candidate) => candidate.id === input.cardId);
  if (!card) {
    throw new Error('Conclusion card does not exist');
  }
  if (card.status === 'integrated') {
    throw new Error('Conclusion card has already been integrated');
  }
  const revision: TrunkRevision = {
    id: createId('revision'),
    content: `${currentTrunkContent(workspace)}\n\n## ${card.title}\n${card.content}`,
    createdAt: now(),
    reason: 'conclusion-integration',
  };
  return {
    ...workspace,
    trunk: {
      currentRevisionId: revision.id,
      revisions: [...workspace.trunk.revisions, revision],
    },
    cards: workspace.cards.map((candidate) =>
      candidate.id === card.id
        ? { ...candidate, status: 'integrated', integratedRevisionId: revision.id }
        : candidate,
    ),
    commandReceipts: [...workspace.commandReceipts, input.commandId],
    events: [
      ...workspace.events,
      event('card.integrated', `将结论卡“${card.title}”回写为主干新修订`),
    ],
  };
}

export function transitionBranch(
  current: BranchLifecycle,
  next: BranchLifecycle,
): BranchLifecycle {
  if (current === next) {
    return current;
  }
  const allowed: Record<BranchLifecycle, BranchLifecycle[]> = {
    active: ['dormant', 'metabolized'],
    dormant: ['active', 'metabolized'],
    metabolized: [],
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid branch transition: ${current} -> ${next}`);
  }
  return next;
}

export function setBranchLifecycle(
  workspace: WorkspaceState,
  input: { branchId: string; lifecycle: BranchLifecycle },
): WorkspaceState {
  const branch = workspace.branches.find((candidate) => candidate.id === input.branchId);
  if (!branch) {
    throw new Error('Branch does not exist');
  }
  const lifecycle = transitionBranch(branch.lifecycle, input.lifecycle);
  return {
    ...workspace,
    branches: workspace.branches.map((candidate) =>
      candidate.id === branch.id ? { ...candidate, lifecycle } : candidate,
    ),
    events: [
      ...workspace.events,
      event('branch.lifecycle-changed', `分支“${branch.title}”变为${lifecycle}`),
    ],
  };
}
