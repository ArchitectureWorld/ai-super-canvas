import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';

import {
  accounts,
  agentAccessGrants,
  agentBindings,
  agents,
  bindingStatus,
  bootstrapReceipts,
  branchAnchors,
  commandReceipts,
  contextRefs,
  contextScope,
  contextVisibility,
  domainEvents,
  growthState,
  messageRole,
  messages,
  modelCatalogEntries,
  runEvents,
  runStatus,
  runs,
  runtimeCompensations,
  runtimeKind,
  sessionConfigRevisions,
  sessionEdgeKind,
  sessionEdges,
  sessionNodes,
  sessionRuntimeRefs,
  sessionStatus,
  sessions,
  toolApprovalDecisions,
  toolGrantEffect,
  toolGrantScope,
  toolGrants,
  trunkRevisions,
  workflowStatus,
  workflows,
  workspaceMembers,
  workspaces,
} from './index';

describe('control-plane schema exports', () => {
  it('exports every S1 aggregate table', () => {
    expect([
      accounts,
      agents,
      agentAccessGrants,
      agentBindings,
      workspaces,
      workflows,
      trunkRevisions,
      branchAnchors,
      bootstrapReceipts,
      sessions,
      sessionNodes,
      sessionEdges,
      sessionRuntimeRefs,
      modelCatalogEntries,
      sessionConfigRevisions,
      messages,
      runs,
      commandReceipts,
      runEvents,
      toolGrants,
      toolApprovalDecisions,
      contextRefs,
      domainEvents,
      runtimeCompensations,
      workspaceMembers,
    ]).toHaveLength(25);
  });

  it('exports the complete S1 enum catalog', () => {
    expect([
      runtimeKind,
      bindingStatus,
      workflowStatus,
      sessionStatus,
      growthState,
      sessionEdgeKind,
      runStatus,
      messageRole,
      toolGrantEffect,
      toolGrantScope,
      contextScope,
      contextVisibility,
    ]).toHaveLength(12);
  });

  it('persists byte-comparable command payloads and Runtime attach metadata', () => {
    const commandColumns = getTableColumns(commandReceipts);
    const bootstrapColumns = getTableColumns(bootstrapReceipts);
    const runtimeRefColumns = getTableColumns(sessionRuntimeRefs);
    const compensationColumns = getTableColumns(runtimeCompensations);

    expect(commandColumns).toHaveProperty('payloadCanonical');
    expect(commandColumns).toHaveProperty('externalLookupMetadata');
    expect(bootstrapColumns).toHaveProperty('payloadCanonical');
    expect(runtimeRefColumns).toHaveProperty('runtimeVersion');
    expect(compensationColumns).toHaveProperty('resolutionEvidence');
    expect(compensationColumns).toHaveProperty('resolvedAt');
  });

  it('uses explicit PostgreSQL-safe names for SessionConfigRevision foreign keys', () => {
    const foreignKeyNames = getTableConfig(sessionConfigRevisions)
      .foreignKeys
      .map((foreignKey) => foreignKey.getName());

    expect(foreignKeyNames).toContain('session_config_model_entry_fk');
    expect(foreignKeyNames.every((name) => name.length <= 63)).toBe(true);
  });
});
