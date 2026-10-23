import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { latestInstaller, readSignup, addToWaitlist, waitlist, readConverterRequest, addConverterRequest, converterRequest, classifyEmail, refusedForConverter } from "../src/worker.js";
import { groupRows } from "../src/email-domains.js";
import { REGISTRY_VERSION } from "../src/email-domains.generated.js";

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

test("the waitlist takes any plausible address, a public mailbox and a throwaway one too, as a newsletter does", () => {
  for (const email of ["ana@gmail.com", "ana@bluewin.ch", "ana@duck.com", "ana@mailinator.com", "ana@bücher.ch"]) {
    assert.equal(readSignup(form({ email, platform: "ios" })).email, email);
  }
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

// ------------------------------------------------------------ converter requests

const REQUEST = { email: " ana@firma.ch ", first_name: "Ana", last_name: "Muster", system: "ecc-ehp6-8", users: "11-50", lang: "de" };
const CUSTOM = { email_domain_type: "CUSTOM_DOMAIN", confidence: "LOW", registry_version: REGISTRY_VERSION };

test("a converter request needs a work address, both names and a choice in both lists; the hidden field marks a robot", () => {
  assert.deepEqual(readConverterRequest(form(REQUEST)), { email: "ana@firma.ch", firstName: "Ana", lastName: "Muster", system: "ecc-ehp6-8", users: "11-50", lang: "de", domain: CUSTOM });
  assert.deepEqual(readConverterRequest(form({ ...REQUEST, email: "ana@Gmail.com" })), { error: "personal" });
  assert.deepEqual(readConverterRequest(form({ ...REQUEST, email: "ana@firma" })), { error: "invalid" });
  assert.deepEqual(readConverterRequest(form({ ...REQUEST, first_name: "" })), { error: "invalid" });
  assert.deepEqual(readConverterRequest(form({ ...REQUEST, last_name: "<script>" })), { error: "invalid" });
  assert.deepEqual(readConverterRequest(form({ ...REQUEST, system: "s5" })), { error: "invalid" });
  assert.deepEqual(readConverterRequest(form({ ...REQUEST, users: "" })), { error: "invalid" });
  assert.equal(readConverterRequest(form({ ...REQUEST, lang: "xx" })).lang, "en");
  assert.deepEqual(readConverterRequest(form({ ...REQUEST, website: "http://spam" })), { robot: true });
});

// A registry with one domain of each kind, so the policy is tested apart from the feeds.
const GROUPS = groupRows([
  { domain: "alias.example", type: "ALIAS", confidence: "MEDIUM" },
  { domain: "burn.example", type: "DISPOSABLE", confidence: "HIGH" },
  { domain: "isp.example", type: "ISP_PERSONAL", confidence: "HIGH" },
  { domain: "maybe-burn.example", type: "DISPOSABLE", confidence: "MEDIUM" },
  { domain: "webmail.example", type: "WEBMAIL", confidence: "MEDIUM" },
]);

test("a converter request refuses public mailboxes at any confidence and throwaway addresses Castle confirms", () => {
  const read = (email) => readConverterRequest(form({ ...REQUEST, email }), GROUPS, "test.1");
  assert.deepEqual(read("ana@webmail.example"), { error: "personal" });
  assert.deepEqual(read("ana@ISP.example."), { error: "personal" });
  assert.deepEqual(read("ana@burn.example"), { error: "personal" });
  assert.deepEqual(read("ana@maybe-burn.example").domain, { email_domain_type: "DISPOSABLE", confidence: "MEDIUM", registry_version: "test.1" });
  assert.deepEqual(read("ana@alias.example").domain, { email_domain_type: "ALIAS", confidence: "MEDIUM", registry_version: "test.1" });
  assert.deepEqual(read("ana@firma.ch").domain, { email_domain_type: "CUSTOM_DOMAIN", confidence: "LOW", registry_version: "test.1" });
  // Exact match only: a subdomain or a longer name of a listed domain is a domain of its own.
  assert.equal(read("ana@sub.webmail.example").domain.email_domain_type, "CUSTOM_DOMAIN");
  assert.equal(read("ana@webmail.example.firma.ch").domain.email_domain_type, "CUSTOM_DOMAIN");
});

test("with the committed registry, Gmail, Bluewin, Proton and Mailinator are refused; Apple's relay and a company's own domain are taken", () => {
  const read = (email) => readConverterRequest(form({ ...REQUEST, email }));
  for (const email of ["ana@gmail.com", "ana@Gmail.com", "ana@bluewin.ch", "ana@hispeed.ch", "ana@proton.me", "ana@tuta.com", "ana@mailinator.com", "ana@yopmail.com"]) {
    assert.deepEqual(read(email), { error: "personal" }, email);
  }
  assert.equal(read("ana@privaterelay.appleid.com").domain.email_domain_type, "ALIAS");
  assert.equal(read("ana@duck.com").domain.email_domain_type, "ALIAS");
  assert.equal(read("ana@sub.gmail.com").domain.email_domain_type, "CUSTOM_DOMAIN");
  assert.equal(read("ana@gmail.com.evil.test").domain.email_domain_type, "CUSTOM_DOMAIN");
  assert.equal(classifyEmail("ana@firma.ch").registry_version, REGISTRY_VERSION);
  assert.equal(refusedForConverter({ email_domain_type: "DISPOSABLE", confidence: "LOW" }), false);
});

test("a converter request becomes one lead with the contact, the system and the number of people", async () => {
  const { calls, fetcher } = odoo();
  const request = readConverterRequest(form(REQUEST));
  assert.deepEqual(await addConverterRequest(request, ENV, fetcher), { ok: true });
  assert.deepEqual(calls.map((c) => c.url), ["https://erp.example.com/json/2/crm.lead/search_count", "https://erp.example.com/json/2/crm.lead/create"]);
  const [lead] = calls[1].body.vals_list;
  assert.equal(lead.name, "TIMEperative converter for SAP: request");
  assert.equal(lead.contact_name, "Ana Muster");
  assert.equal(lead.email_from, "ana@firma.ch");
  assert.equal(lead.team_id, 3);
  assert.match(lead.description, /SAP system: SAP ERP 6\.0 \(ECC\), enhancement package 6 to 8\. People who would use it: 11 to 50\. Language of the page: de\./);
  assert.ok(lead.description.endsWith(`Email domain: email_domain_type CUSTOM_DOMAIN, confidence LOW, registry ${REGISTRY_VERSION}.`));
  const alias = odoo();
  await addConverterRequest(readConverterRequest(form({ ...REQUEST, email: "ana@maybe-burn.example" }), GROUPS, "test.1"), ENV, alias.fetcher);
  assert.match(alias.calls[1].body.vals_list[0].description, /email_domain_type DISPOSABLE, confidence MEDIUM, registry test\.1\.$/);
  const again = odoo(1);
  assert.deepEqual(await addConverterRequest(request, ENV, again.fetcher), { ok: true, known: true });
  assert.equal(again.calls.length, 1);
});

const postRequest = (fields, headers = {}) => new Request("https://www.timeperative.com/converter-request", { method: "POST", body: form(fields), headers });

test("the converter request answers script with JSON and a plain form with a redirect to its own message", async () => {
  const { fetcher } = odoo();
  const json = await converterRequest(postRequest(REQUEST, { accept: "application/json", origin: "https://www.timeperative.com" }), ENV, fetcher);
  assert.equal(json.status, 200);
  assert.deepEqual(await json.json(), { ok: true });
  const personal = await converterRequest(postRequest({ ...REQUEST, email: "ana@gmail.com" }, { accept: "application/json" }), ENV, fetcher);
  assert.equal(personal.status, 400);
  // The browser learns only that the address is not a work address: never the type, the confidence or the list.
  assert.deepEqual(await personal.json(), { ok: false, error: "personal" });
  const burner = await converterRequest(postRequest({ ...REQUEST, email: "ana@mailinator.com" }, { accept: "application/json" }), ENV, fetcher);
  assert.deepEqual(await burner.json(), { ok: false, error: "personal" });
  const plain = await converterRequest(postRequest({ ...REQUEST, page: "/de/resources/converters/" }), ENV, fetcher);
  assert.equal(plain.status, 303);
  assert.equal(plain.headers.get("location"), "https://www.timeperative.com/de/resources/converters/#sap-request-ok");
  const invalid = await converterRequest(postRequest({ ...REQUEST, system: "", page: "//evil.example/" }), ENV, fetcher);
  assert.equal(invalid.headers.get("location"), "https://www.timeperative.com/#sap-request-invalid");
});

test("the converter request refuses another site's form and anything but POST; the Worker routes it", async () => {
  const { calls, fetcher } = odoo();
  assert.equal((await converterRequest(postRequest(REQUEST, { origin: "https://evil.example" }), ENV, fetcher)).status, 403);
  assert.equal((await converterRequest(new Request("https://www.timeperative.com/converter-request"), ENV, fetcher)).status, 405);
  assert.equal(calls.length, 0);
  const res = await worker.fetch(new Request("https://www.timeperative.com/converter-request"), { ASSETS: { fetch: async () => new Response("asset") } });
  assert.equal(res.status, 405);
});
