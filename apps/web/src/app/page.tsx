import { getModelCatalog } from '@ai-super-canvas/ai';
import { connection } from 'next/server';
import { WorkspacePrototype } from '../components/workspace-prototype';

export default async function HomePage() {
  await connection();
  return <WorkspacePrototype modelCatalog={getModelCatalog()} />;
}
