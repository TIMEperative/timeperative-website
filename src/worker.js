// The Worker in front of www.timeperative.com's static assets (wrangler.jsonc).
// It runs first on every request (assets.run_worker_first) and
//   - sends every other host of the site (timeperative.com) to the same path
//     on the origin in site.json with a 301, so the address bar always shows
//     www.timeperative.com;
//   - answers /download/windows and /download/android with the newest
//     installer the stores' update manifests name, so the website never needs
//     a new build for a new release, and the move of the store (site.json
//     "stores") needs no new code;
//   - takes the macOS and iOS waitlist sign-ups (POST /waitlist) into the
//     CRM, as a lead created through the external JSON-2 API;
//   - serves everything else from the static assets.

import site from "./site.json" with { type: "json" };

const ORIGIN = new URL(site.origin);

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

// ------------------------------------------------------------ the waitlist

export const WAITLIST_PLATFORMS = { macos: "macOS", ios: "iOS" };
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** The sign-up a form sent, or the reason it cannot be taken. */
export function readSignup(form) {
  const email = String(form.get("email") ?? "").trim();
  const platform = String(form.get("platform") ?? "");
  const lang = String(form.get("lang") ?? "");
  // The hidden field people never see: a filled one is a robot.
  if (String(form.get("website") ?? "") !== "") return { robot: true };
  if (!WAITLIST_PLATFORMS[platform]) return { error: "invalid" };
  if (email.length > 254 || !EMAIL.test(email)) return { error: "invalid" };
  return { email, platform, lang: site.languages.some((l) => l.code === lang) ? lang : "en" };
}

/**
 * Creates the lead in the CRM through the external JSON-2 API (Odoo 19 and
 * later: POST /json/2/<model>/<method>, a bearer API key, X-Odoo-Database).
 * A second sign-up with the same address for the same platform adds nothing.
 */
export async function addToWaitlist(signup, env, fetcher = fetch) {
  const base = String(env.ODOO_URL ?? "").replace(/\/+$/, "");
  if (!base || !env.ODOO_API_KEY) return { error: "unavailable" };
  const call = async (model, method, body) => {
    const res = await fetcher(`${base}/json/2/${model}/${method}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${env.ODOO_API_KEY}`,
        "content-type": "application/json; charset=utf-8",
        "user-agent": "timeperative-website waitlist",
        ...(env.ODOO_DB ? { "x-odoo-database": env.ODOO_DB } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${model}.${method}: HTTP ${res.status}`);
    return res.json();
  };
  const name = `TIMEperative for ${WAITLIST_PLATFORMS[signup.platform]}: waitlist`;
  try {
    const seen = await call("crm.lead", "search_count", { domain: [["email_from", "=ilike", signup.email], ["name", "=", name]] });
    if (seen > 0) return { ok: true, known: true };
    const lead = {
      name,
      email_from: signup.email,
      description: `Signed up on ${ORIGIN.host} to hear when TIMEperative for ${WAITLIST_PLATFORMS[signup.platform]} is out. Language of the page: ${signup.lang}.`,
    };
    if (env.ODOO_TEAM_ID) lead.team_id = Number(env.ODOO_TEAM_ID);
    if (env.ODOO_COMPANY_ID) lead.company_id = Number(env.ODOO_COMPANY_ID);
    if (env.ODOO_TAG_IDS) lead.tag_ids = String(env.ODOO_TAG_IDS).split(",").map((id) => [4, Number(id.trim())]);
    await call("crm.lead", "create", { vals_list: [lead] });
    return { ok: true };
  } catch (error) {
    console.error(`waitlist: ${error.message}`);
    return { error: "unavailable" };
  }
}

/** Where a form without script goes back to: the page it came from, at its own message. */
function backTo(form, platform, outcome) {
  const page = String(form.get("page") ?? "/");
  const path = page.startsWith("/") && !page.startsWith("//") ? page : "/";
  return `${ORIGIN.origin}${path}#waitlist-${platform in WAITLIST_PLATFORMS ? platform : "macos"}-${outcome}`;
}

export async function waitlist(request, env, fetcher = fetch) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  // Only the site's own pages may sign someone up.
  const from = request.headers.get("origin");
  if (from && new URL(from).host !== ORIGIN.host) return new Response(null, { status: 403 });
  let form;
  try {
    form = await request.formData();
  } catch {
    return new Response(null, { status: 400 });
  }
  const signup = readSignup(form);
  const result = signup.robot ? { ok: true } : signup.error ? signup : await addToWaitlist(signup, env, fetcher);
  const outcome = result.ok ? "ok" : result.error === "invalid" ? "invalid" : "error";
  if ((request.headers.get("accept") ?? "").includes("application/json")) {
    return Response.json({ ok: !!result.ok, error: result.error }, { status: result.ok ? 200 : result.error === "invalid" ? 400 : 503, headers: { "cache-control": "no-store" } });
  }
  return new Response(null, { status: 303, headers: { location: backTo(form, String(form.get("platform") ?? ""), outcome), "cache-control": "no-store" } });
}

// ------------------------------------------------------------ routing

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (site.redirectHosts.includes(url.hostname)) {
      return Response.redirect(`${ORIGIN.origin}${url.pathname}${url.search}`, 301);
    }
    if (url.pathname === "/waitlist") return waitlist(request, env);
    const match = /^\/download\/(windows|android)\/?$/.exec(url.pathname);
    if (!match) return env.ASSETS.fetch(request);
    const location = (await latestInstaller(match[1])) ?? site.releasePage;
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
  },
};
