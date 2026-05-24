import { execSync } from 'node:child_process';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.js');

function resolveCommitSha() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  if (process.env.COMMIT_SHA) return process.env.COMMIT_SHA;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow server-side imports of Node.js built-ins
  serverExternalPackages: ['openai', '@anthropic-ai/sdk', 'xlsx'],
  experimental: {
    proxyClientMaxBodySize: '50mb',
  },
  env: {
    NEXT_PUBLIC_COMMIT_SHA: resolveCommitSha(),
  },
};

export default withNextIntl(nextConfig);
