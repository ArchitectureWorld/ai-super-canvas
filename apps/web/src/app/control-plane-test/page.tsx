import type { Metadata } from 'next';

import { ControlPlaneTestClient } from './control-plane-test-client';

export const metadata: Metadata = {
  title: '真实后端闭环 · AI Super Canvas',
  description: 'PostgreSQL 与 DeterministicFakeRuntime 的本地 Alpha 验证入口。',
};

export default function ControlPlaneTestPage() {
  return <ControlPlaneTestClient />;
}
