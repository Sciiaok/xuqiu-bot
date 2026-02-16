/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow server-side imports of Node.js built-ins
  serverExternalPackages: ['openai', '@anthropic-ai/sdk'],
};

export default nextConfig;
