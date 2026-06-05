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
  // Allow server-side imports of Node.js built-ins.
  // ffmpeg-static 用 __dirname 定位二进制;被 Next 打包后 __dirname 会指到
  // .next/ 里,路径失效导致 spawn ENOENT(语音/视频转码静默失败)。声明 external
  // 让它保持从 node_modules 直接 require,二进制路径才正确。
  serverExternalPackages: ['openai', '@anthropic-ai/sdk', 'xlsx', 'ffmpeg-static'],
  experimental: {
    proxyClientMaxBodySize: '50mb',
  },
  env: {
    NEXT_PUBLIC_COMMIT_SHA: resolveCommitSha(),
  },
};

export default withNextIntl(nextConfig);
