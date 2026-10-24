import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { latestInstaller, readSignup, addToWaitlist, waitlist, readAccessRequest, requestSyncAccess, syncAccess } from "../src/worker.js";

const json = (body, ok = true) => ({ ok, json: async () => body });
const stores = ["New/store", "Old/store"];

test("takes the newest installer across the stores", async () => {
  const fetcher = async (url) => url.startsWith("https://github.com/New/store/")
    ? json({ pub_date: "2026-11-02T10:00:00Z", platforms: { "windows-x86_64": { url: "https://github.com/New/store/releases/download/v2/setup.exe" } } })
    : json({ pub_date: "2026-10-16T10:00:00Z", platforms: { "windows-x86_64": { url: "https://github.com/Old/store/releases/download/v1/setup.exe" } } });
  assert.equal(await latestInstaller("windows", stores, fetcher), "https://github.com/New/store/releases/download/v2/setup.exe");
});

test("skips a store that has no releases yet", async () => {
  const fetcher = async (url) => url.includes("New/store")
    ? json({}, false)
    : json({ pubDate: "2026-10-16T21:32:57Z", url: "https://github.com/Old/store/releases/download/v1/app.apk" });
  assert.equal(await latestInstaller("android", stores, fetcher), "https://github.com/Old/store/releases/download/v1/app.apk");
});

test("follows only installers in the store's own releases", async () => {
  const fetcher = async () => json({ pubDate: "2026-10-16T21:32:57Z", url: "https://example.com/app.apk" });
  assert.equal(await latestInstaller("android", stores, fetcher), null);
});

test("a store that cannot be read does not stop the others", async () => {
  const fetcher = async (url) => {
    if (url.includes("New/store")) throw new Error("network");
    return json({ pubDate: "2026-10-16T21:32:57Z", url: "https://github.com/Old/store/releases/download/v1/app.apk" });
  };
  assert.equal(await latestInstaller("android", stores, fetcher), "https://github.com/Old/store/releases/download/v1/app.apk");
});

test("every other path is a static asset", async () => {
  const seen = [];
  const env = { ASSETS: { fetch: async (request) => { seen.push(new URL(request.url).pathname); return new Response("asset"); } } };
  const res = await worker.fetch(new Request("https://www.timeperative.com/download/"), env);
  assert.equal(await res.text(), "asset");
  assert.deepEqual(seen, ["/download/"]);
});

test("timeperative.com goes to the same path on www with a 301, whatever the path", async () => {
  const env = { ASSETS: { fetch: async () => { throw new Error("no asset for the apex"); } } };
  for (const path of ["/", "/de/download/?x=1", "/assets/site.css", "/download/windows"]) {
    const res = await worker.fetch(new Request(`https://timeperative.com${path}`), env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), `https://www.timeperative.com${path}`);
  }
});

const form = (fields) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };

test("a sign-up needs a platform without a release and a plausible address; the hidden field marks a robot", () => {
  assert.deepEqual(readSignup(form({ email: " ana@example.ch ", platform: "macos", lang: "fr" })), { email: "ana@example.ch", platform: "macos", lang: "fr" });
  assert.deepEqual(readSignup(form({ email: "ana@example.ch", platform: "windows" })), { error: "invalid" });
  assert.deepEqual(readSignup(form({ email: "ana@example", platform: "ios" })), { error: "invalid" });
  assert.deepEqual(readSignup(form({ email: "a b@example.ch", platform: "ios" })), { error: "invalid" });
  assert.equal(readSignup(form({ email: "ana@example.ch", platform: "ios", lang: "xx" })).lang, "en");
  assert.deepEqual(readSignup(form({ email: "ana@example.ch", platform: "ios", website: "http://spam" })), { robot: true });
});

const ENV = { ODOO_URL: "https://erp.example.com/", ODOO_DB: "erp", ODOO_API_KEY: "key", ODOO_TEAM_ID: "3", ODOO_TAG_IDS: "7, 8" };
const odoo = (count = 0, fail = 0) => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (fail) return { ok: false, status: fail, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (url.endsWith("/search_count") ? count : [42]) };
  };
  return { calls, fetcher };
};

test("a new sign-up becomes one lead through JSON-2, with the key, the database, the team and the tags", async () => {
  const { calls, fetcher } = odoo();
  assert.deepEqual(await addToWaitlist({ email: "ana@example.ch", platform: "ios", lang: "de" }, ENV, fetcher), { ok: true });
  assert.deepEqual(calls.map((c) => c.url), ["https://erp.example.com/json/2/crm.lead/search_count", "https://erp.example.com/json/2/crm.lead/create"]);
  assert.equal(calls[1].init.headers.authorization, "bearer key");
  assert.equal(calls[1].init.headers["x-odoo-database"], "erp");
  const [lead] = calls[1].body.vals_list;
  assert.equal(lead.name, "TIMEperative for iOS: waitlist");
  assert.equal(lead.email_from, "ana@example.ch");
  assert.equal(lead.team_id, 3);
  assert.deepEqual(lead.tag_ids, [[4, 7], [4, 8]]);
  assert.match(lead.description, /www\.timeperative\.com.*Language of the page: de/);
});

test("the same address for the same platform adds no second lead", async () => {
  const { calls, fetcher } = odoo(1);
  assert.deepEqual(await addToWaitlist({ email: "ana@example.ch", platform: "ios", lang: "de" }, ENV, fetcher), { ok: true, known: true });
  assert.equal(calls.length, 1);
});

test("without the secrets, or when the CRM refuses, the sign-up is not lost silently: it reports unavailable", async () => {
  assert.deepEqual(await addToWaitlist({ email: "a@b.ch", platform: "ios", lang: "en" }, {}, odoo().fetcher), { error: "unavailable" });
  const original = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await addToWaitlist({ email: "a@b.ch", platform: "ios", lang: "en" }, ENV, odoo(0, 401).fetcher), { error: "unavailable" });
  } finally {
    console.error = original;
  }
});

const post = (fields, headers = {}) => new Request("https://www.timeperative.com/waitlist", { method: "POST", body: form(fields), headers });

test("the waitlist answers script with JSON and a plain form with a redirect to its own message", async () => {
  const { fetcher } = odoo();
  const json = await waitlist(post({ email: "ana@example.ch", platform: "macos", lang: "en" }, { accept: "application/json", origin: "https://www.timeperative.com" }), ENV, fetcher);
  assert.equal(json.status, 200);
  assert.deepEqual(await json.json(), { ok: true });
  const plain = await waitlist(post({ email: "nope", platform: "ios", lang: "de", page: "/de/download/" }), ENV, fetcher);
  assert.equal(plain.status, 303);
  assert.equal(plain.headers.get("location"), "https://www.timeperative.com/de/download/#waitlist-ios-invalid");
  const away = await waitlist(post({ email: "ana@example.ch", platform: "ios", page: "//evil.example/" }), ENV, fetcher);
  assert.equal(away.headers.get("location"), "https://www.timeperative.com/#waitlist-ios-ok");
});

test("the waitlist refuses another site's form and anything but POST", async () => {
  const { calls, fetcher } = odoo();
  assert.equal((await waitlist(post({ email: "ana@example.ch", platform: "ios" }, { origin: "https://evil.example" }), ENV, fetcher)).status, 403);
  assert.equal((await waitlist(new Request("https://www.timeperative.com/waitlist"), ENV, fetcher)).status, 405);
  assert.equal(calls.length, 0);
});

test("a robot gets the same answer as a person and adds nothing", async () => {
  const { calls, fetcher } = odoo();
  const res = await waitlist(post({ email: "ana@example.ch", platform: "ios", website: "x" }, { accept: "application/json" }), ENV, fetcher);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------ TIMEperative.sync

const request = { email: "ana@example.ch", name: "Ana Muster", organisation: "Muster AG", lang: "de" };

test("a request for TIMEperative.sync needs a name, an organisation and a plausible address; GitHub user names are checked", () => {
  assert.deepEqual(readAccessRequest(form({ ...request, github: "@ana-m", server: " https://hub.muster.ch ", message: "Hi" })),
    { ...request, github: "ana-m", server: "https://hub.muster.ch", message: "Hi" });
  assert.deepEqual(readAccessRequest(form({ ...request, name: " " })), { error: "invalid" });
  assert.deepEqual(readAccessRequest(form({ ...request, organisation: "" })), { error: "invalid" });
  assert.deepEqual(readAccessRequest(form({ ...request, email: "ana" })), { error: "invalid" });
  assert.deepEqual(readAccessRequest(form({ ...request, github: "-bad-" })), { error: "invalid" });
  assert.deepEqual(readAccessRequest(form({ ...request, website: "x" })), { robot: true });
  assert.equal(readAccessRequest(form({ ...request, lang: "xx" })).lang, "en");
});

test("a request becomes one lead with the contact, the organisation and escaped notes; a repeat adds none", async () => {
  const { calls, fetcher } = odoo();
  assert.deepEqual(await requestSyncAccess({ ...request, github: "", server: "", message: "<b>soon</b>\nplease" }, ENV, fetcher), { ok: true });
  const [lead] = calls[1].body.vals_list;
  assert.equal(lead.name, "TIMEperative.sync: access for Muster AG");
  assert.equal(lead.contact_name, "Ana Muster");
  assert.equal(lead.partner_name, "Muster AG");
  assert.equal(lead.email_from, "ana@example.ch");
  assert.equal(lead.team_id, 3);
  assert.match(lead.description, /<p>GitHub user: \(not given\)<\/p>/);
  assert.match(lead.description, /<p>&lt;b&gt;soon&lt;\/b&gt;<\/p><p>please<\/p>/);
  const again = odoo(1);
  assert.deepEqual(await requestSyncAccess({ ...request, github: "", server: "", message: "" }, ENV, again.fetcher), { ok: true, known: true });
  assert.equal(again.calls.length, 1);
});

test("the request form answers script with JSON and a plain form with a redirect to its own message", async () => {
  const { fetcher } = odoo();
  const send = (fields, headers = {}) => syncAccess(new Request("https://www.timeperative.com/sync-access", { method: "POST", body: form(fields), headers }), ENV, fetcher);
  const json = await send(request, { accept: "application/json", origin: "https://www.timeperative.com" });
  assert.equal(json.status, 200);
  assert.deepEqual(await json.json(), { ok: true });
  const plain = await send({ ...request, email: "nope", page: "/de/download/sync/" });
  assert.equal(plain.status, 303);
  assert.equal(plain.headers.get("location"), "https://www.timeperative.com/de/download/sync/#sync-access-invalid");
  const away = await send({ ...request, page: "//evil.example/" });
  assert.equal(away.headers.get("location"), "https://www.timeperative.com/download/sync/#sync-access-ok");
  const foreign = await send(request, { origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
});

test("the Worker routes /sync-access to the request form", async () => {
  const res = await worker.fetch(new Request("https://www.timeperative.com/sync-access"), { ASSETS: { fetch: async () => new Response("asset") } });
  assert.equal(res.status, 405);
});
