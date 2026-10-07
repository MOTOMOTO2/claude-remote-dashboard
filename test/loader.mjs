const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(CDN)) {
    return next(new URL('./fake-supabase.mjs', import.meta.url).href, context);
  }
  return next(specifier, context);
}
