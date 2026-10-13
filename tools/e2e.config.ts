// Live browser sessions for agents (the e2e MCP server's open_session with
// config: <this file>). Model-free: no `agents` key, so nothing here spends.
//   staging  - https://staging.contentcoach.org/app
//   preview  - opens the factory gateway; navigate to any
//              https://<feature>-pr<N>.contentcoach.org/app from there. The
//              preview password answers every basic-auth challenge.
// Sign in by navigating to the URL `factory login <target>` prints.
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

function previewPassword(): string {
  try {
    return readFileSync(`${homedir()}/.config/factory/preview-password`, 'utf8').trim();
  } catch {
    return 'run-factory-api-on-a-preview-once-to-fetch-it';
  }
}

export default {
  tests: 'none/**/*.e2e.ts',
  output: '.e2e',
  targets: [
    {
      name: 'staging',
      engine: web(),
      app: { url: 'https://staging.contentcoach.org/app', environment: 'staging' },
    },
    {
      name: 'preview',
      engine: web({ basicAuth: { username: 'factory', password: previewPassword() } }),
      app: { url: process.env.FACTORY_PREVIEW_URL ?? 'https://hello-pr0.contentcoach.org/', environment: 'staging' },
    },
  ],
} satisfies E2EConfig;
