// The Worker in front of timeperative.com's static assets (wrangler.jsonc).
// It answers only /download/windows and /download/android
// (assets.run_worker_first): each sends the visitor to the newest installer
// that the stores' update manifests name, so the website never needs a new
// build for a new release, and the move of the store (site.json "stores")
// needs no new code. Everything else is a static asset.

import site from "./site.json" with { type: "json" };

export const PLATFORMS = {
  windows: { file: "latest.json", url: (m) => m.platforms?.["windows-x86_64"]?.url, date: (m) => m.pub_date },
  android: { file: "latest-android.json", url: (m) => m.url, date: (m) => m.pubDate },
};

/** The newest installer URL for a platform, or null when no store answers. */
export async function latestInstaller(platform, stores = site.stores, fetcher = fetch) {
  const p = PLATFORMS[platform];
  let best = null;
  for (const store of stores) {
    try {
      const res = await fetcher(`https://github.com/${store}/releases/latest/download/${p.file}`, { cf: { cacheTtl: 300, cacheEverything: true } });
      if (!res.ok) continue;
      const manifest = await res.json();
      const url = p.url(manifest);
      const date = Date.parse(p.date(manifest) ?? "");
      // Only an installer published in that store's own releases is followed.
      if (typeof url !== "string" || !url.startsWith(`https://github.com/${store}/releases/download/`) || Number.isNaN(date)) continue;
      if (!best || date > best.date) best = { url, date };
    } catch {
      // A store that cannot be read is skipped; the next one may answer.
    }
  }
  return best?.url ?? null;
}

export default {
  async fetch(request, env) {
    const match = /^\/download\/(windows|android)\/?$/.exec(new URL(request.url).pathname);
    if (!match) return env.ASSETS.fetch(request);
    const location = (await latestInstaller(match[1])) ?? site.releasePage;
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
  },
};
