export async function resolve(specifier, context, defaultResolve) {
  if (specifier === 'next/server') {
    return defaultResolve('next/server.js', context, defaultResolve);
  }

  return defaultResolve(specifier, context, defaultResolve);
}
