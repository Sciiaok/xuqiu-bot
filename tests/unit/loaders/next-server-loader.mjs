import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function resolve(specifier, context, defaultResolve) {
  if (specifier === 'next/server') {
    return defaultResolve('next/server.js', context, defaultResolve);
  }

  if (specifier.startsWith('@/')) {
    const basePath = resolvePath(process.cwd(), specifier.slice(2));
    const resolvedPath = existsSync(basePath) ? basePath : `${basePath}.js`;
    return defaultResolve(pathToFileURL(resolvedPath).href, context, defaultResolve);
  }

  return defaultResolve(specifier, context, defaultResolve);
}
