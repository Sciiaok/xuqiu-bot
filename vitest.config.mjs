import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { transformSync } from 'rolldown/experimental';

export default defineConfig({
  plugins: [
    // Transform .js files containing JSX before vite:oxc sees them.
    // Needed because this Next.js project uses .js extension for JSX files.
    {
      name: 'js-jsx-transform',
      enforce: 'pre',
      transform(code, id) {
        if (/\.js$/.test(id) && !id.includes('node_modules')) {
          const result = transformSync(id, code, {
            lang: 'jsx',
            jsx: { runtime: 'automatic' },
            sourcemap: true,
          });
          return {
            code: result.code,
            map: result.map,
          };
        }
      },
    },
    react(),
  ],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['**/__tests__/**/*.test.{js,jsx}', 'app/**/*.test.{js,jsx}'],
    exclude: ['**/node_modules/**', 'tests/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '.'),
    },
  },
});
