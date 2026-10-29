// The QA tester's browser (factory-agents, `qa` jobs): one target, the PR's
// preview. Model-free: no `agents` key, so nothing here spends; the tester
// (Claude) drives the browser itself through `e2e mcp`. qa-mcp copies this
// file into /workspace/qa so session videos land in the task's workspace,
// where the factory collects them.
//   QA_PREVIEW_URL        https://pr<N>.<domain>/app/ (set by factory-agents)
//   /run/factory/preview-password  the previews' basic-auth password (mounted read-only)
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { readFileSync } from 'node:fs';

function previewPassword(): string {
  try {
    return readFileSync('/run/factory/preview-password', 'utf8').trim();
  } catch {
    return '';
  }
}

export default {
  tests: 'none/**/*.e2e.ts',
  output: '.e2e',
  targets: [
    {
      name: 'preview',
      engine: web({ basicAuth: { username: 'factory', password: previewPassword() } }),
      app: { url: process.env.QA_PREVIEW_URL ?? 'about:blank', environment: 'staging' },
    },
  ],
} satisfies E2EConfig;
