// The Worker in front of www.timeperative.com's static assets (wrangler.jsonc).
// It runs first on every request (assets.run_worker_first) and
//   - sends every other host of the site (timeperative.com) to the same path
//     on the origin in site.json with a 301, so the address bar always shows
//     www.timeperative.com;
//   - answers /download/windows and /download/android with the newest
//     installer the stores' update manifests name, so the website never needs
//     a new build for a new release, and the move of the store (site.json
//     "stores") needs no new code;
//   - takes the macOS and iOS waitlist sign-ups (POST /waitlist) and the
//     requests for TIMEperative.sync (POST /sync-access) into the CRM, as
//     leads created through the external JSON-2 API;
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
 * Creates a lead in the CRM through the external JSON-2 API (Odoo 19 and
 * later: POST /json/2/<model>/<method>, a bearer API key, X-Odoo-Database),
 * unless a lead of the same name for the same address exists already.
 */
export async function createLead(lead, env, fetcher = fetch, what = "lead") {
  const base = String(env.ODOO_URL ?? "").replace(/\/+$/, "");
  if (!base || !env.ODOO_API_KEY) return { error: "unavailable" };
  const call = async (model, method, body) => {
    const res = await fetcher(`${base}/json/2/${model}/${method}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${env.ODOO_API_KEY}`,
        "content-type": "application/json; charset=utf-8",
        "user-agent": `timeperative-website ${what}`,
        ...(env.ODOO_DB ? { "x-odoo-database": env.ODOO_DB } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${model}.${method}: HTTP ${res.status}`);
    return res.json();
  };
  try {
    const seen = await call("crm.lead", "search_count", { domain: [["email_from", "=ilike", lead.email_from], ["name", "=", lead.name]] });
    if (seen > 0) return { ok: true, known: true };
    const vals = { ...lead };
    if (env.ODOO_TEAM_ID) vals.team_id = Number(env.ODOO_TEAM_ID);
    if (env.ODOO_COMPANY_ID) vals.company_id = Number(env.ODOO_COMPANY_ID);
    if (env.ODOO_TAG_IDS) vals.tag_ids = String(env.ODOO_TAG_IDS).split(",").map((id) => [4, Number(id.trim())]);
    await call("crm.lead", "create", { vals_list: [vals] });
    return { ok: true };
  } catch (error) {
    console.error(`${what}: ${error.message}`);
    return { error: "unavailable" };
  }
}

/** A waitlist sign-up becomes a lead; a second one for the same platform adds nothing. */
export function addToWaitlist(signup, env, fetcher = fetch) {
  return createLead({
    name: `TIMEperative for ${WAITLIST_PLATFORMS[signup.platform]}: waitlist`,
    email_from: signup.email,
    description: `Signed up on ${ORIGIN.host} to hear when TIMEperative for ${WAITLIST_PLATFORMS[signup.platform]} is out. Language of the page: ${signup.lang}.`,
  }, env, fetcher, "waitlist");
}

// ------------------------------------------------------------ TIMEperative.sync

const field = (form, name, max) => String(form.get(name) ?? "").trim().slice(0, max);
const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** A request for TIMEperative.sync, or the reason it cannot be taken. */
export function readAccessRequest(form) {
  if (String(form.get("website") ?? "") !== "") return { robot: true };
  const email = String(form.get("email") ?? "").trim();
  const name = field(form, "name", 120);
  const organisation = field(form, "organisation", 160);
  const github = field(form, "github", 39).replace(/^@/, "");
  const server = field(form, "server", 200);
  const message = field(form, "message", 2000);
  const lang = String(form.get("lang") ?? "");
  if (email.length > 254 || !EMAIL.test(email) || !name || !organisation) return { error: "invalid" };
  if (github && !GITHUB_USER.test(github)) return { error: "invalid" };
  return { email, name, organisation, github, server, message, lang: site.languages.some((l) => l.code === lang) ? lang : "en" };
}

/** A request becomes a lead; a second one from the same address for the same organisation adds nothing. */
export function requestSyncAccess(request, env, fetcher = fetch) {
  const lines = [
    `Asked on ${ORIGIN.host} for access to TIMEperative.sync.`,
    `Name: ${request.name}`,
    `Organisation: ${request.organisation}`,
    `GitHub user: ${request.github || "(not given)"}`,
    `Cloud Hub address: ${request.server || "(not given)"}`,
    `Language of the page: ${request.lang}`,
    ...(request.message ? ["", request.message] : []),
  ];
  // The notes are an HTML field: every line its own escaped paragraph.
  const html = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return createLead({
    name: `TIMEperative.sync: access for ${request.organisation}`,
    contact_name: request.name,
    partner_name: request.organisation,
    email_from: request.email,
    description: lines.flatMap((line) => line.split(/\r?\n/)).map((line) => `<p>${html(line)}</p>`).join(""),
  }, env, fetcher, "sync-access");
}

/** Where a form without script goes back to: the page it came from, at its own message. */
function backTo(form, platform, outcome) {
  const page = String(form.get("page") ?? "/");
  const path = page.startsWith("/") && !page.startsWith("//") ? page : "/";
  return `${ORIGIN.origin}${path}#waitlist-${platform in WAITLIST_PLATFORMS ? platform : "macos"}-${outcome}`;
}

/**
 * Takes a form posted by one of the site's own pages: read turns it into the
 * data or a reason, act sends the data on, back names the anchor a form
 * without script returns to.
 */
async function takeForm(request, read, act, back) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const from = request.headers.get("origin");
  if (from && new URL(from).host !== ORIGIN.host) return new Response(null, { status: 403 });
  let form;
  try {
    form = await request.formData();
  } catch {
    return new Response(null, { status: 400 });
  }
  const data = read(form);
  const result = data.robot ? { ok: true } : data.error ? data : await act(data);
  const outcome = result.ok ? "ok" : result.error === "invalid" ? "invalid" : "error";
  if ((request.headers.get("accept") ?? "").includes("application/json")) {
    return Response.json({ ok: !!result.ok, error: result.error }, { status: result.ok ? 200 : result.error === "invalid" ? 400 : 503, headers: { "cache-control": "no-store" } });
  }
  return new Response(null, { status: 303, headers: { location: back(form, outcome), "cache-control": "no-store" } });
}

export function waitlist(request, env, fetcher = fetch) {
  return takeForm(request, readSignup, (signup) => addToWaitlist(signup, env, fetcher), (form, outcome) => backTo(form, String(form.get("platform") ?? ""), outcome));
}

export function syncAccess(request, env, fetcher = fetch) {
  return takeForm(request, readAccessRequest, (data) => requestSyncAccess(data, env, fetcher), (form, outcome) => {
    const page = String(form.get("page") ?? "/download/sync/");
    const path = page.startsWith("/") && !page.startsWith("//") ? page : "/download/sync/";
    return `${ORIGIN.origin}${path}#sync-access-${outcome}`;
  });
}

// ------------------------------------------------------------ routing

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (site.redirectHosts.includes(url.hostname)) {
      return Response.redirect(`${ORIGIN.origin}${url.pathname}${url.search}`, 301);
    }
    if (url.pathname === "/waitlist") return waitlist(request, env);
    if (url.pathname === "/sync-access") return syncAccess(request, env);
    const match = /^\/download\/(windows|android)\/?$/.exec(url.pathname);
    if (!match) return env.ASSETS.fetch(request);
    const location = (await latestInstaller(match[1])) ?? site.releasePage;
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
  },
};
