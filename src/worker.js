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
//     requests for a converter for SAP (POST /converter-request) into the
//     CRM, as leads created through the external JSON-2 API; a request for a
//     converter needs a work address, which the email domain registry
//     (data/README.md) tells from a public mail provider's;
//   - serves everything else from the static assets.

import site from "./site.json" with { type: "json" };
import { classifyDomain, decide, emailDomain, OUTSIDE_THE_WORKER } from "./email-domains.js";
import { GROUPS, REGISTRY_VERSION } from "./email-domains.generated.js";

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

/** The sign-up a form sent, or the reason it cannot be taken. */
export function readSignup(form) {
  const email = String(form.get("email") ?? "").trim();
  const platform = String(form.get("platform") ?? "");
  const lang = String(form.get("lang") ?? "");
  // The hidden field people never see: a filled one is a robot.
  if (String(form.get("website") ?? "") !== "") return { robot: true };
  if (!WAITLIST_PLATFORMS[platform]) return { error: "invalid" };
  if (!emailDomain(email)) return { error: "invalid" };
  if (decide("waitlist", classifyEmail(email)) === "refuse") return { error: "personal" };
  return { email, platform, lang: site.languages.some((l) => l.code === lang) ? lang : "en" };
}

/**
 * A call into the CRM through the external JSON-2 API (Odoo 19 and later:
 * POST /json/2/<model>/<method>, a bearer API key, X-Odoo-Database), or null
 * when the secrets are missing.
 */
function crm(env, fetcher, agent) {
  const base = String(env.ODOO_URL ?? "").replace(/\/+$/, "");
  if (!base || !env.ODOO_API_KEY) return null;
  return async (model, method, body) => {
    const res = await fetcher(`${base}/json/2/${model}/${method}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${env.ODOO_API_KEY}`,
        "content-type": "application/json; charset=utf-8",
        "user-agent": `timeperative-website ${agent}`,
        ...(env.ODOO_DB ? { "x-odoo-database": env.ODOO_DB } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${model}.${method}: HTTP ${res.status}`);
    return res.json();
  };
}

/** Creates the lead once: a second one with the same address and name adds nothing. */
async function addLead(lead, env, fetcher, agent) {
  const call = crm(env, fetcher, agent);
  if (!call) return { error: "unavailable" };
  try {
    const seen = await call("crm.lead", "search_count", { domain: [["email_from", "=ilike", lead.email_from], ["name", "=", lead.name]] });
    if (seen > 0) return { ok: true, known: true };
    if (env.ODOO_TEAM_ID) lead.team_id = Number(env.ODOO_TEAM_ID);
    if (env.ODOO_COMPANY_ID) lead.company_id = Number(env.ODOO_COMPANY_ID);
    if (env.ODOO_TAG_IDS) lead.tag_ids = String(env.ODOO_TAG_IDS).split(",").map((id) => [4, Number(id.trim())]);
    await call("crm.lead", "create", { vals_list: [lead] });
    return { ok: true };
  } catch (error) {
    console.error(`${agent}: ${error.message}`);
    return { error: "unavailable" };
  }
}

/** The waitlist sign-up as a lead in the CRM. */
export async function addToWaitlist(signup, env, fetcher = fetch) {
  const platform = WAITLIST_PLATFORMS[signup.platform];
  return addLead({
    name: `TIMEperative for ${platform}: waitlist`,
    email_from: signup.email,
    description: `Signed up on ${ORIGIN.host} to hear when TIMEperative for ${platform} is out. Language of the page: ${signup.lang}.`,
  }, env, fetcher, "waitlist");
}

// ------------------------------------------------------------ converter requests

// SAP reads time sheets differently at almost every company, so a converter
// for SAP is built when a company asks for one (owner, 2026-10-23). The
// request names the system and the number of people, so the owner can judge
// how serious it is. The keys are the form's values; the labels go into the
// lead.
export const SAP_SYSTEMS = {
  "r3": "SAP R/3 4.x or older",
  "ecc-ehp0-5": "SAP ERP 6.0 (ECC), enhancement package 0 to 5",
  "ecc-ehp6-8": "SAP ERP 6.0 (ECC), enhancement package 6 to 8",
  "s4-on-premise": "SAP S/4HANA, on premise",
  "s4-private": "SAP S/4HANA Cloud Private Edition",
  "s4-public": "SAP S/4HANA Cloud Public Edition",
  "successfactors": "SAP SuccessFactors Employee Central Time Tracking",
  "business-one": "SAP Business One",
  "bydesign": "SAP Business ByDesign",
  "other": "Another SAP system, or not sure",
};
export const USER_COUNTS = { "1-10": "1 to 10", "11-50": "11 to 50", "51-250": "51 to 250", "251-1000": "251 to 1,000", "1000+": "more than 1,000" };

// A request for a converter is a sales lead from a company, so it needs the
// company's own address (owner, 2026-10-23): the policy "converter-request"
// in src/email-domains.js refuses public mailboxes, internet providers'
// mailboxes and throwaway addresses Castle confirms, and takes the rest with
// the type in the lead for the owner to judge. The browser learns only
// "personal", never the type or the list.

/** The registry's view of an address's domain: its type, its confidence and the registry's version. */
export function classifyEmail(email, groups = GROUPS, version = REGISTRY_VERSION) {
  return { ...classifyDomain(emailDomain(email), groups), registry_version: version };
}

const NAME = /^[^<>{}\[\]\\/@:;"=]{1,80}$/u;

/** The converter request a form sent, or the reason it cannot be taken. */
export function readConverterRequest(form, groups = GROUPS, version = REGISTRY_VERSION) {
  const field = (name) => String(form.get(name) ?? "").trim();
  if (field("website") !== "") return { robot: true };
  const email = field("email");
  const firstName = field("first_name");
  const lastName = field("last_name");
  const system = field("system");
  const users = field("users");
  const lang = field("lang");
  if (!emailDomain(email)) return { error: "invalid" };
  if (!NAME.test(firstName) || !NAME.test(lastName) || !SAP_SYSTEMS[system] || !USER_COUNTS[users]) return { error: "invalid" };
  const domain = classifyEmail(email, groups, version);
  if (decide("converter-request", domain) === "refuse") return { error: "personal" };
  return { email, firstName, lastName, system, users, lang: site.languages.some((l) => l.code === lang) ? lang : "en", domain };
}

/** The request as a lead in the CRM. */
export async function addConverterRequest(request, env, fetcher = fetch) {
  const domain = request.domain ?? classifyEmail(request.email);
  return addLead({
    name: "TIMEperative converter for SAP: request",
    contact_name: `${request.firstName} ${request.lastName}`,
    email_from: request.email,
    description: `Asked on ${ORIGIN.host} for a converter for SAP. SAP system: ${SAP_SYSTEMS[request.system]}. People who would use it: ${USER_COUNTS[request.users]}. Language of the page: ${request.lang}. Email domain: email_domain_type ${domain.email_domain_type}, confidence ${domain.confidence}, registry ${domain.registry_version} (the Worker leaves out ${OUTSIDE_THE_WORKER}).`,
  }, env, fetcher, "converter-request");
}

// ------------------------------------------------------------ the forms

/** Where a form without script goes back to: the page it came from, at its own message. */
function backTo(form, anchor) {
  const page = String(form.get("page") ?? "/");
  const path = page.startsWith("/") && !page.startsWith("//") ? page : "/";
  return `${ORIGIN.origin}${path}#${anchor}`;
}

/**
 * A form posted to the Worker: only from the site's own pages, robots get the
 * same answer as people, script gets JSON, a plain form a redirect to its
 * own message.
 */
async function takeForm(request, read, add, anchor, env, fetcher) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const from = request.headers.get("origin");
  if (from && new URL(from).host !== ORIGIN.host) return new Response(null, { status: 403 });
  let form;
  try {
    form = await request.formData();
  } catch {
    return new Response(null, { status: 400 });
  }
  const entry = read(form);
  const result = entry.robot ? { ok: true } : entry.error ? entry : await add(entry, env, fetcher);
  const refused = result.error === "invalid" || result.error === "personal";
  if ((request.headers.get("accept") ?? "").includes("application/json")) {
    return Response.json({ ok: !!result.ok, error: result.error }, { status: result.ok ? 200 : refused ? 400 : 503, headers: { "cache-control": "no-store" } });
  }
  const outcome = result.ok ? "ok" : refused ? result.error : "error";
  return new Response(null, { status: 303, headers: { location: backTo(form, anchor(form, outcome)), "cache-control": "no-store" } });
}

export function waitlist(request, env, fetcher = fetch) {
  return takeForm(request, readSignup, addToWaitlist, (form, outcome) => {
    const platform = String(form.get("platform") ?? "");
    return `waitlist-${platform in WAITLIST_PLATFORMS ? platform : "macos"}-${outcome}`;
  }, env, fetcher);
}

export function converterRequest(request, env, fetcher = fetch) {
  return takeForm(request, readConverterRequest, addConverterRequest, (form, outcome) => `sap-request-${outcome}`, env, fetcher);
}

// ------------------------------------------------------------ routing

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (site.redirectHosts.includes(url.hostname)) {
      return Response.redirect(`${ORIGIN.origin}${url.pathname}${url.search}`, 301);
    }
    if (url.pathname === "/waitlist") return waitlist(request, env);
    if (url.pathname === "/converter-request") return converterRequest(request, env);
    const match = /^\/download\/(windows|android)\/?$/.exec(url.pathname);
    if (!match) return env.ASSETS.fetch(request);
    const location = (await latestInstaller(match[1])) ?? site.releasePage;
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
  },
};
