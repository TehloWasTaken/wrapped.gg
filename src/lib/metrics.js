export function track(env, name, labels = [], values = []) {
  if (!env.ANALYTICS) return;
  try {
    env.ANALYTICS.writeDataPoint({
      indexes: [name],
      blobs: [name, ...labels.map(l => String(l == null ? '' : l).slice(0, 64))],
      doubles: values.map(Number),
    });
  } catch {}
}

export const trackPageView   = (env, slug, kind, surface) =>
  track(env, 'page_view', [slug, kind, surface || 'site']);
export const trackPlayerRead = (env, slug, hit)  => track(env, 'player_read', [slug, hit ? 'hit' : 'miss']);
export const trackOgRender   = (env, slug, cached, ms) =>
  track(env, 'og_image', [slug, cached ? 'cached' : 'rendered'], [ms || 0]);
export const trackHead       = (env, cached) => track(env, 'head_image', [cached ? 'cached' : 'fetched']);
export const trackUpload     = (env, slug, bytes, source) =>
  track(env, 'snapshot_upload', [slug, source], [bytes]);
export const trackBuild      = (env, slug, players, ms, ok) =>
  track(env, 'build', [slug, ok ? 'ok' : 'failed'], [players, ms]);
export const trackNameLookup = (env, tier, n) => {
  if (n > 0) track(env, 'name_lookup', [tier], [n]);
};
