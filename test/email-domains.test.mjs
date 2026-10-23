import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainToASCII } from "node:url";
import { canonicalDomain, classifyDomain, emailDomain, groupRows, urlToASCII } from "../src/email-domains.js";
import { GROUPS } from "../src/email-domains.generated.js";
import {
  FEEDS, FILES, build, buildRegistry, check, checkDelta, checkFeeds, checkHandList, checkRegistry, fetchFeed, nextVersion, parseFeed, registryText, validateSchema,
} from "../scripts/email-domains.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const schema = (name) => JSON.parse(readFileSync(join(ROOT, FILES.schemas[name]), "utf8"));

// ------------------------------------------------------------ normalisation

test("a domain is normalised to lowercase ASCII through IDNA, with no trailing dot", () => {
  assert.equal(canonicalDomain(" GMail.COM. "), "gmail.com");
  assert.equal(canonicalDomain("bücher.ch"), "xn--bcher-kva.ch");
  assert.equal(canonicalDomain("XN--BCHER-KVA.CH"), "xn--bcher-kva.ch");
  assert.equal(canonicalDomain("ｇｍａｉｌ．ｃｏｍ"), "gmail.com");
  assert.equal(canonicalDomain("mail.sub-domain.example.org"), "mail.sub-domain.example.org");
});

test("anything that is not a mail domain is refused, so no URL trick reaches the registry", () => {
  for (const bad of ["", "gmail", "user@gmail.com", "evil.test/gmail.com", "evil.test?gmail.com", "evil.test#gmail.com", "gmail.com:25", "a b.com",
    "gmail..com", ".gmail.com", "-a.com", "a-.com", "a_b.com", `${"a".repeat(64)}.com`, `${"a.".repeat(127)}com`, "1.2.3.4", "0x7f.1", "127.0.0.1", "[::1]", "xn--a.com"]) {
    assert.equal(canonicalDomain(bad), null, bad);
  }
});

test("the Worker's IDNA through the URL parser agrees with node:url domainToASCII", () => {
  for (const d of ["gmail.com", "bücher.ch", "MÜNCHEN.de", "ｇｍａｉｌ．ｃｏｍ", "straße.de", "παράδειγμα.gr", "例え.jp", "xn--bcher-kva.ch", "a.b.c.d.example"]) {
    assert.equal(canonicalDomain(d), canonicalDomain(d, domainToASCII), d);
    assert.equal(urlToASCII(d.toLowerCase()), domainToASCII(d.toLowerCase()), d);
  }
});

test("an address gives its domain; the local part is never changed or read", () => {
  assert.equal(emailDomain("Ana.Muster+sap@Firma.CH"), "firma.ch");
  assert.equal(emailDomain("ana@bücher.ch"), "xn--bcher-kva.ch");
  for (const bad of ["ana", "@firma.ch", "ana@", "ana@firma", "a b@firma.ch", "ana@firma.ch/x", `${"a".repeat(65)}@firma.ch`, `a@${"b".repeat(250)}.ch`]) {
    assert.equal(emailDomain(bad), null, bad);
  }
});

// ------------------------------------------------------------ classification (specification 11.1)

test("the committed registry classifies the specification's table", () => {
  const type = (d) => classifyDomain(d, GROUPS);
  assert.deepEqual(type("gmail.com"), { email_domain_type: "WEBMAIL", confidence: "HIGH" });
  assert.deepEqual(type("proton.me"), { email_domain_type: "WEBMAIL", confidence: "HIGH" });
  assert.deepEqual(type("bluewin.ch"), { email_domain_type: "ISP_PERSONAL", confidence: "HIGH" });
  assert.deepEqual(type("duck.com"), { email_domain_type: "ALIAS", confidence: "HIGH" });
  assert.deepEqual(type("privaterelay.appleid.com"), { email_domain_type: "ALIAS", confidence: "HIGH" });
  assert.deepEqual(type("mailinator.com"), { email_domain_type: "DISPOSABLE", confidence: "HIGH" });
  assert.deepEqual(type("yopmail.com"), { email_domain_type: "DISPOSABLE", confidence: "HIGH" });
  // Unlisted: CUSTOM_DOMAIN, which says only that no list knows it. Without
  // a DNS check, an unlisted domain is never UNKNOWN; only no domain is.
  assert.deepEqual(type("example.org"), { email_domain_type: "CUSTOM_DOMAIN", confidence: "LOW" });
  assert.deepEqual(type("not a domain"), { email_domain_type: "UNKNOWN", confidence: "LOW" });
  // Exact match only: no suffix and no prefix inference.
  assert.equal(type("gmail.com.evil.test").email_domain_type, "CUSTOM_DOMAIN");
  assert.equal(type("sub.gmail.com").email_domain_type, "CUSTOM_DOMAIN");
  assert.equal(type("GMAIL.COM.").email_domain_type, "WEBMAIL");
});

test("a lookup matches whole lines only, and explicitly listed subdomains", () => {
  const groups = groupRows([
    { domain: "gmail.com", type: "WEBMAIL", confidence: "HIGH" },
    { domain: "mx.throwaway.example", type: "DISPOSABLE", confidence: "MEDIUM" },
  ]);
  assert.equal(classifyDomain("mx.throwaway.example", groups).email_domain_type, "DISPOSABLE");
  assert.equal(classifyDomain("throwaway.example", groups).email_domain_type, "CUSTOM_DOMAIN");
  assert.equal(classifyDomain("mail.com", groups).email_domain_type, "CUSTOM_DOMAIN");
  assert.equal(classifyDomain("ail.com", groups).email_domain_type, "CUSTOM_DOMAIN");
});

// ------------------------------------------------------------ the committed files

test("the committed registry, manifest, overrides, exclusions and the Worker's copy pass every check", () => {
  assert.deepEqual(check(ROOT), []);
});

test("the published files hold the specification's names and the overrides it requires", () => {
  const overrides = JSON.parse(readFileSync(join(ROOT, FILES.overrides), "utf8"));
  const want = { "bluewin.ch": "ISP_PERSONAL", "hispeed.ch": "ISP_PERSONAL", "gmail.com": "WEBMAIL", "proton.me": "WEBMAIL", "protonmail.com": "WEBMAIL", "tuta.com": "WEBMAIL", "duck.com": "ALIAS", "privaterelay.appleid.com": "ALIAS" };
  for (const [domain, type] of Object.entries(want)) assert.equal(overrides.find((o) => o.domain === domain)?.type, type, domain);
  const registry = readFileSync(join(ROOT, FILES.registry), "utf8");
  assert.doesNotMatch(registry, /"category"|PUBLIC_WEBMAIL|EMAIL_ALIAS/);
});

test("the registry is never a page asset: the build copies src/static and src/pages only", () => {
  const buildScript = readFileSync(join(ROOT, "scripts/build.mjs"), "utf8");
  assert.doesNotMatch(buildScript, /data\//);
  assert.doesNotMatch(buildScript, /email-domains/);
});

// ------------------------------------------------------------ the builder

const feedsOf = (lists) => Object.fromEntries(FEEDS.map((f) => [f.id, new Set(lists[f.id] ?? [])]));
const override = (domain, type) => ({ domain, type, reason: "test", reviewed_by: "test", reviewed_at: "2026-10-23" });

test("a feed is read line by line; comments, blank lines and case do not matter; bad lines are counted", () => {
  const { domains, invalid } = parseFeed("# list\nMailinator.com\n\n yopmail.com \nnot a domain\nhttp://x.example/\n");
  assert.deepEqual([...domains], ["mailinator.com", "yopmail.com"]);
  assert.equal(invalid.length, 2);
});

test("precedence: overrides, then Castle, then the community list, then forwarding less the community list, then free providers", () => {
  const { rows, conflicts } = buildRegistry(feedsOf({
    "free-email-providers": ["gmail.com", "spam.example", "relay.example", "hot.example", "bluewin.ch"],
    "castle-disposable": ["hot.example", "mailinator.com"],
    "disposable-community": ["spam.example", "mailinator.com", "hot.example"],
    "forwarding-combined": ["spam.example", "mailinator.com", "hot.example", "relay.example", "duck.com"],
  }), [override("bluewin.ch", "ISP_PERSONAL"), override("gmail.com", "WEBMAIL")], []);
  const by = Object.fromEntries(rows.map((r) => [r.domain, r]));
  assert.deepEqual(by["gmail.com"], { domain: "gmail.com", type: "WEBMAIL", sources: ["timeperative-curated", "free-email-providers"], confidence: "HIGH" });
  assert.deepEqual(by["bluewin.ch"], { domain: "bluewin.ch", type: "ISP_PERSONAL", sources: ["timeperative-curated"], confidence: "HIGH" });
  assert.deepEqual(by["hot.example"], { domain: "hot.example", type: "DISPOSABLE", sources: ["castle-disposable", "disposable-community"], confidence: "HIGH" });
  assert.deepEqual(by["spam.example"], { domain: "spam.example", type: "DISPOSABLE", sources: ["disposable-community"], confidence: "MEDIUM" });
  assert.deepEqual(by["relay.example"], { domain: "relay.example", type: "ALIAS", sources: ["forwarding-combined"], confidence: "MEDIUM" });
  assert.deepEqual(by["duck.com"], { domain: "duck.com", type: "ALIAS", sources: ["forwarding-combined"], confidence: "MEDIUM" });
  // The forwarding list is not ALIAS as a whole: its disposable domains stay DISPOSABLE.
  assert.equal(by["mailinator.com"].type, "DISPOSABLE");
  assert.deepEqual(rows.map((r) => r.domain), [...rows.map((r) => r.domain)].sort());
  assert.deepEqual(conflicts["free-provider-and-disposable"].map((c) => c.domain), ["hot.example", "spam.example"]);
  assert.deepEqual(conflicts["free-provider-and-alias"].map((c) => c.domain), ["relay.example"]);
  assert.deepEqual(conflicts["override-differs-from-feeds"].map((c) => [c.domain, c.was]), [["bluewin.ch", "WEBMAIL MEDIUM"]]);
});

test("Gmail is never made disposable by a feed while an override holds it; an exclusion takes a domain out and is reported", () => {
  const { rows, conflicts } = buildRegistry(feedsOf({
    "free-email-providers": ["gmail.com", "firma.example"],
    "castle-disposable": ["gmail.com"],
    "disposable-community": ["gmail.com"],
    "forwarding-combined": ["gmail.com"],
  }), [override("gmail.com", "WEBMAIL")], [{ domain: "firma.example", reason: "a business", reviewed_by: "test", reviewed_at: "2026-10-23" }]);
  assert.deepEqual(rows, [{ domain: "gmail.com", type: "WEBMAIL", sources: ["timeperative-curated"], confidence: "HIGH" }]);
  assert.equal(conflicts["override-differs-from-feeds"][0].was, "DISPOSABLE HIGH");
  assert.deepEqual(conflicts.excluded.map((c) => [c.domain, c.was]), [["firma.example", "WEBMAIL MEDIUM"]]);
});

test("the schemas refuse an unknown type, a missing field, an extra field and a duplicate", () => {
  const row = { domain: "gmail.com", type: "WEBMAIL", sources: ["free-email-providers"], confidence: "HIGH" };
  assert.deepEqual(validateSchema([row], schema("registry")), []);
  assert.match(validateSchema([{ ...row, type: "PUBLIC_WEBMAIL" }], schema("registry")).join(), /not one of/);
  assert.match(validateSchema([{ ...row, category: "WEBMAIL" }], schema("registry")).join(), /category is not allowed/);
  assert.match(validateSchema([{ ...row, sources: [] }], schema("registry")).join(), /fewer than 1/);
  assert.match(validateSchema([row, row], schema("registry")).join(), /repeats/);
  assert.match(checkHandList("overrides", [override("gmail.com", "CUSTOM_DOMAIN")], schema("overrides")).join(), /not one of/);
  assert.match(checkHandList("overrides", [override("Gmail.com", "WEBMAIL")], schema("overrides")).join(), /pattern|canonical/);
  assert.match(checkHandList("overrides", [override("x.example", "WEBMAIL"), override("x.example", "ALIAS")], schema("overrides")).join(), /listed twice/);
  assert.match(checkHandList("exclusions", [{ domain: "b.example", reason: "x y", reviewed_by: "me", reviewed_at: "2026-10-23" }, { domain: "a.example", reason: "x y", reviewed_by: "me", reviewed_at: "2026-10-23" }], schema("exclusions")).join(), /out of order/);
});

test("the gates: duplicates, sentinels, exclusions still listed, stored run-time types", () => {
  const rows = [
    { domain: "a.example", type: "CUSTOM_DOMAIN", sources: ["free-email-providers"], confidence: "LOW" },
    { domain: "a.example", type: "WEBMAIL", sources: ["free-email-providers"], confidence: "MEDIUM" },
    { domain: "gmail.com", type: "DISPOSABLE", sources: ["disposable-community"], confidence: "MEDIUM" },
  ];
  const problems = checkRegistry(rows, { schema: schema("registry"), exclusions: [{ domain: "gmail.com" }] }).join("\n");
  assert.match(problems, /a\.example is listed twice/);
  assert.match(problems, /CUSTOM_DOMAIN, a result at run time/);
  assert.match(problems, /sentinel: gmail\.com should be WEBMAIL, is DISPOSABLE MEDIUM/);
  assert.match(problems, /sentinel: mailinator\.com should be DISPOSABLE HIGH, is not listed/);
  assert.match(problems, /exclusion: gmail\.com is excluded but listed/);
});

test("the gates: implausibly small feeds, feeds of junk, large shrinkage and large feed changes", () => {
  const small = checkFeeds({ "free-email-providers": { domains: new Set(["a.example"]), invalid: [] } }).join("\n");
  assert.match(small, /free-email-providers: 1 domains, fewer than/);
  assert.match(small, /castle-disposable: missing/);
  const junk = checkFeeds({ x: { domains: new Set(["a.example"]), invalid: ["<html>", "</html>"] } }, [{ id: "x", min: 1 }]).join();
  assert.match(junk, /2 of 3 lines are no domain/);
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ domain: `d${i}.example` }));
  assert.match(checkDelta(rows(100), rows(89), null, {}).join(), /shrinks from 100 to 89/);
  assert.deepEqual(checkDelta(rows(100), rows(91), null, {}), []);
  assert.match(checkDelta([], [], { source_counts: { "castle-disposable": 1000 } }, { "castle-disposable": 1210 }).join(), /changes from 1000 to 1210/);
  assert.deepEqual(checkDelta([], [], { source_counts: { "castle-disposable": 1000 } }, { "castle-disposable": 1190 }), []);
});

test("a feed is read over HTTPS only, within its size limit, and fails after its tries", async () => {
  const feed = { id: "x", url: "https://feed.example/x.txt", maxBytes: 10 };
  const body = (text) => ({ ok: true, status: 200, url: feed.url, headers: new Headers(), body: [new TextEncoder().encode(text)] });
  assert.equal(await fetchFeed(feed, async () => body("a.example\n")), "a.example\n");
  await assert.rejects(fetchFeed({ ...feed, url: "http://feed.example/x.txt" }, async () => body("")), /only HTTPS/);
  await assert.rejects(fetchFeed(feed, async () => body("a-much-longer.example\n"), { tries: 1 }), /over the limit/);
  let calls = 0;
  await assert.rejects(fetchFeed(feed, async () => { calls++; throw new Error("offline"); }, { tries: 3, backoffMs: 0 }), /x: offline/);
  assert.equal(calls, 3);
});

test("the version counts builds within a day", () => {
  const day = new Date("2026-10-23T07:00:00Z");
  assert.equal(nextVersion(undefined, day), "2026-10-23.1");
  assert.equal(nextVersion("2026-10-23.1", day), "2026-10-23.2");
  assert.equal(nextVersion("2026-10-22.4", day), "2026-10-23.1");
});

// ------------------------------------------------------------ a whole build on fixture feeds

const FIXTURE_FEEDS = FEEDS.map((f) => ({ ...f, min: 2 }));
const many = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}.example`);
const fixture = {
  "free-email-providers": ["gmail.com", "proton.me", "bluewin.ch", "hotmail.com", "tuta.com", ...many("free", 20)],
  "castle-disposable": ["mailinator.com", "yopmail.com", "hot.example"],
  "disposable-community": ["mailinator.com", "yopmail.com", "hot.example", ...many("throw", 40)],
  "forwarding-combined": ["mailinator.com", "yopmail.com", "hot.example", ...many("throw", 40), "duck.com", "privaterelay.appleid.com", "relay.example"],
};

function workspace(feeds = fixture) {
  const root = mkdtempSync(join(tmpdir(), "email-domains-"));
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, "src"));
  for (const path of [FILES.overrides, FILES.exclusions, ...Object.values(FILES.schemas)]) cpSync(join(ROOT, path), join(root, path));
  const feedsDir = join(root, "feeds");
  mkdirSync(feedsDir);
  for (const [id, list] of Object.entries(feeds)) writeFileSync(join(feedsDir, `${id}.txt`), `${list.join("\n")}\n`);
  return { root, feedsDir };
}

const quiet = { log: () => {}, feedList: FIXTURE_FEEDS };
const snapshot = (root) => [FILES.registry, FILES.manifest, FILES.runtime].map((p) => readFileSync(join(root, p), "utf8"));

test("a build on fixture feeds publishes the registry, the manifest and the Worker's copy, which then pass the check", async () => {
  const { root, feedsDir } = workspace();
  try {
    const result = await build({ root, feedsDir, now: new Date("2026-10-23T07:00:00Z"), ...quiet });
    assert.equal(result.ok, true, result.problems?.join("\n"));
    assert.deepEqual(check(root), []);
    const manifest = JSON.parse(readFileSync(join(root, FILES.manifest), "utf8"));
    assert.equal(manifest.registry_version, "2026-10-23.1");
    assert.equal(manifest.row_count, result.rows.length);
    assert.match(manifest.source_versions["castle-disposable"], /^sha256:[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(root, FILES.registry), "utf8"), registryText(result.rows));
    assert.match(readFileSync(join(root, ".email-domains/summary.md"), "utf8"), /Registry version \*\*2026-10-23\.1\*\*/);
    JSON.parse(readFileSync(join(root, ".email-domains/source-conflicts.json"), "utf8"));
    // The same feeds again change nothing and write nothing.
    const before = snapshot(root);
    const again = await build({ root, feedsDir, now: new Date("2026-10-24T07:00:00Z"), ...quiet });
    assert.equal(again.changed, false);
    assert.deepEqual(snapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed gate publishes nothing: the previous registry stays as it was", async () => {
  const { root, feedsDir } = workspace();
  try {
    assert.equal((await build({ root, feedsDir, now: new Date("2026-10-23T07:00:00Z"), ...quiet })).ok, true);
    const before = snapshot(root);
    // Castle no longer lists Yopmail: the sentinel gate fails.
    writeFileSync(join(feedsDir, "castle-disposable.txt"), "mailinator.com\nhot.example\n");
    const sentinel = await build({ root, feedsDir, now: new Date("2026-10-24T07:00:00Z"), ...quiet });
    assert.equal(sentinel.ok, false);
    assert.match(sentinel.problems.join(), /yopmail\.com should be DISPOSABLE HIGH/);
    assert.deepEqual(snapshot(root), before);
    // The community feed loses most of its domains: the delta gate fails ...
    writeFileSync(join(feedsDir, "castle-disposable.txt"), "mailinator.com\nyopmail.com\nhot.example\n");
    writeFileSync(join(feedsDir, "disposable-community.txt"), "mailinator.com\nyopmail.com\nhot.example\n");
    const shrink = await build({ root, feedsDir, now: new Date("2026-10-24T07:00:00Z"), ...quiet });
    assert.equal(shrink.ok, false);
    assert.match(shrink.problems.join("\n"), /disposable-community changes from 43 to 3/);
    assert.deepEqual(snapshot(root), before);
    // ... unless a person accepts it, and then the summary says so first.
    const accepted = await build({ root, feedsDir, allowLargeChange: true, now: new Date("2026-10-24T07:00:00Z"), ...quiet });
    assert.equal(accepted.ok, true);
    assert.match(readFileSync(join(root, ".email-domains/summary.md"), "utf8"), /^> \[!WARNING\]\n> \*\*Unusually large change/);
    assert.ok(JSON.parse(readFileSync(join(root, FILES.manifest), "utf8")).large_change_accepted.length > 0);
    // A feed that cannot be read publishes nothing either.
    const kept = snapshot(root);
    rmSync(join(feedsDir, "free-email-providers.txt"));
    const missing = await build({ root, feedsDir, now: new Date("2026-10-25T07:00:00Z"), ...quiet });
    assert.equal(missing.ok, false);
    assert.deepEqual(snapshot(root), kept);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the builder reads the four feeds of the specification over HTTPS, never the strict list", () => {
  assert.deepEqual(FEEDS.map((f) => f.id), ["free-email-providers", "castle-disposable", "disposable-community", "forwarding-combined"]);
  for (const f of FEEDS) {
    assert.match(f.url, /^https:\/\//);
    assert.doesNotMatch(f.url, /strict/);
    assert.ok(f.licence && f.maxBytes && f.min, f.id);
  }
});
