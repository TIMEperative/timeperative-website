// Builds the email domain registry (data/README.md).
//
//   node scripts/email-domains.mjs                       fetch the feeds, build, run the gates, publish
//   node scripts/email-domains.mjs --check               check the committed files, offline (npm test)
//   node scripts/email-domains.mjs --allow-large-change  publish although a delta gate failed
//   node scripts/email-domains.mjs --feeds <dir>         read <dir>/<feed id>.txt instead of fetching
//
// The algorithm and the precedence follow the owner's specification
// (sections 3 and 4, 2026-10-23): exclusions, then our overrides, then
// Castle (DISPOSABLE, HIGH), the community list (DISPOSABLE, MEDIUM), the
// forwarding list less the community list (ALIAS, MEDIUM), and the free
// provider list (WEBMAIL, MEDIUM). Every disagreement between the feeds and
// the result goes to .email-domains/source-conflicts.json. The build writes
// to .email-domains/staging/ first and publishes only when every gate passes;
// on any failure it exits with 1 and leaves the published files as they were.
//
// Node built-ins only.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";
import { canonicalDomain as canonical, groupRows, inWorker, OUTSIDE_THE_WORKER } from "../src/email-domains.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const canonicalDomain = (input) => canonical(input, domainToASCII);

// The feeds of the specification, 3.1. Licences read 2026-10-23 in each
// repository (THIRD-PARTY-NOTICES.md). min: fewer domains than this means the
// feed is broken, not that the world changed. maxBytes: a response larger
// than this is refused.
export const FEEDS = [
  {
    id: "free-email-providers",
    url: "https://www.validemailchecker.com/free-email-provider-domains.txt",
    repository: "https://github.com/Validemailchecker/free-email-provider-domains",
    licence: "MIT, Copyright (c) 2026 Valid Email Checker; aggregates Kikobeats/free-email-domains (MIT) and willwhite/freemail (MIT)",
    min: 10000,
    maxBytes: 8 * 1024 * 1024,
  },
  {
    id: "castle-disposable",
    url: "https://raw.githubusercontent.com/castle/disposable-email-domains/master/disposable-email-domains.txt",
    repository: "https://github.com/castle/disposable-email-domains",
    licence: "MIT, Copyright (c) 2026 Castle",
    min: 500,
    maxBytes: 1024 * 1024,
  },
  {
    id: "disposable-community",
    url: "https://disposable.github.io/disposable-email-domains/domains.txt",
    repository: "https://github.com/disposable/disposable-email-domains",
    licence: "MIT, Copyright (c) 2017 Andrei Simionescu, Copyright (c) 2017 Stefan Meinecke, greenSec GmbH",
    min: 50000,
    maxBytes: 16 * 1024 * 1024,
  },
  {
    id: "forwarding-combined",
    url: "https://disposable.github.io/disposable-email-domains/domains_forwarding.txt",
    repository: "https://github.com/disposable/disposable-email-domains",
    licence: "MIT, Copyright (c) 2017 Andrei Simionescu, Copyright (c) 2017 Stefan Meinecke, greenSec GmbH",
    min: 50000,
    maxBytes: 16 * 1024 * 1024,
  },
];

export const CURATED = "timeperative-curated";
export const RULESET_VERSION = "converter-request-v1";
// A feed may hold a few odd lines; more than this share means it is broken.
export const MAX_INVALID_SHARE = 0.01;
// The specification's starting guideline (3.4): investigate more than 20 %
// change in any feed or more than 10 % shrinkage of the registry.
export const MAX_FEED_CHANGE = 0.2;
export const MAX_REGISTRY_SHRINK = 0.1;
// The registry must classify these as stated (3.4, 4, 11.1).
export const SENTINELS = [
  { domain: "gmail.com", type: "WEBMAIL" },
  { domain: "proton.me", type: "WEBMAIL" },
  { domain: "bluewin.ch", type: "ISP_PERSONAL" },
  { domain: "duck.com", type: "ALIAS" },
  { domain: "privaterelay.appleid.com", type: "ALIAS" },
  { domain: "mailinator.com", type: "DISPOSABLE", confidence: "HIGH" },
  { domain: "yopmail.com", type: "DISPOSABLE", confidence: "HIGH" },
];

export const FILES = {
  registry: "data/email-domains.json",
  manifest: "data/email-domains-manifest.json",
  overrides: "data/email-domains-overrides.json",
  exclusions: "data/email-domains-exclusions.json",
  runtime: "src/email-domains.generated.js",
  schemas: {
    registry: "data/email-domains.schema.json",
    overrides: "data/email-domains-overrides.schema.json",
    exclusions: "data/email-domains-exclusions.schema.json",
  },
};

// ------------------------------------------------------------ reading

/** One feed: one domain per line; "#" starts a comment. */
export function parseFeed(text) {
  const domains = new Set();
  const invalid = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const domain = canonicalDomain(line);
    if (domain) domains.add(domain);
    else invalid.push(line.slice(0, 120));
  }
  return { domains, invalid };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A feed over HTTPS, with a timeout, a size limit and three tries. */
export async function fetchFeed(feed, fetcher = fetch, { tries = 3, timeoutMs = 60000, backoffMs = 2000 } = {}) {
  if (!feed.url.startsWith("https://")) throw new Error(`${feed.id}: only HTTPS feeds are read`);
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetcher(feed.url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow", headers: { "user-agent": "timeperative-website email-domains" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (res.url && !res.url.startsWith("https://")) throw new Error(`redirected away from HTTPS to ${res.url}`);
      const declared = Number(res.headers?.get?.("content-length") ?? 0);
      if (declared > feed.maxBytes) throw new Error(`${declared} bytes, over the limit of ${feed.maxBytes}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > feed.maxBytes) throw new Error(`over the limit of ${feed.maxBytes} bytes`);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      last = error;
      if (attempt < tries) await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }
  throw new Error(`${feed.id}: ${last.message}`);
}

const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

// ------------------------------------------------------------ JSON Schema

/**
 * The part of JSON Schema 2020-12 our schemas use: type, enum, required,
 * properties, additionalProperties false, items, minItems, uniqueItems,
 * minLength, maxLength, pattern. Returns the problems, empty when valid.
 */
export function validateSchema(value, schema, path = "$") {
  const problems = [];
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && schema.type !== kind) return [`${path}: ${kind}, expected ${schema.type}`];
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
  if (kind === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) problems.push(`${path}: does not match ${schema.pattern}`);
  }
  if (kind === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.uniqueItems) {
      const seen = new Set();
      value.forEach((item, i) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) problems.push(`${path}[${i}]: repeats an earlier item`);
        seen.add(key);
      });
    }
    if (schema.items) value.forEach((item, i) => problems.push(...validateSchema(item, schema.items, `${path}[${i}]`)));
  }
  if (kind === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${path}: ${key} is missing`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) problems.push(...validateSchema(item, schema.properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${path}: ${key} is not allowed`);
    }
  }
  return problems;
}

/** Problems with a hand-edited list: its schema, canonical and unique domains, sorted. */
export function checkHandList(name, list, schema) {
  const problems = validateSchema(list, schema).map((p) => `${name}: ${p}`);
  if (!Array.isArray(list)) return problems;
  const seen = new Set();
  list.forEach((entry, i) => {
    const domain = entry?.domain;
    if (typeof domain !== "string") return;
    if (canonicalDomain(domain) !== domain) problems.push(`${name}: ${domain} is not a canonical domain (lowercase, xn-- form for international domains)`);
    if (seen.has(domain)) problems.push(`${name}: ${domain} is listed twice`);
    seen.add(domain);
    if (i > 0 && typeof list[i - 1]?.domain === "string" && list[i - 1].domain >= domain) problems.push(`${name}: ${domain} is out of order; keep the list sorted by domain`);
  });
  return problems;
}

// ------------------------------------------------------------ building

/**
 * The registry from the feeds (sets of canonical domains by feed id), the
 * overrides and the exclusions: the specification's section 4, with the
 * precedence of 3.3. Sources name our overrides and the feeds that agree
 * with the result; feeds that disagree are reported, never counted as
 * evidence. Confidence never rises because several feeds list a domain:
 * the community list already includes Castle's.
 */
export function buildRegistry(feeds, overrides, exclusions) {
  const free = feeds["free-email-providers"];
  const castle = feeds["castle-disposable"];
  const disposable = feeds["disposable-community"];
  const forwarding = feeds["forwarding-combined"];
  const conflicts = {
    "free-provider-and-disposable": [],
    "free-provider-and-alias": [],
    "castle-not-in-community": [],
    "override-differs-from-feeds": [],
    "excluded": [],
  };
  const registry = new Map();
  const listedBy = (domain) => FEEDS.map((f) => f.id).filter((id) => feeds[id].has(domain));

  for (const domain of free) registry.set(domain, { type: "WEBMAIL", sources: ["free-email-providers"], confidence: "MEDIUM" });
  for (const domain of forwarding) {
    if (disposable.has(domain)) continue;
    if (free.has(domain)) conflicts["free-provider-and-alias"].push({ domain, feeds: listedBy(domain), resolved: "ALIAS MEDIUM" });
    registry.set(domain, { type: "ALIAS", sources: ["forwarding-combined"], confidence: "MEDIUM" });
  }
  for (const domain of disposable) {
    if (free.has(domain) && !castle.has(domain)) conflicts["free-provider-and-disposable"].push({ domain, feeds: listedBy(domain), resolved: "DISPOSABLE MEDIUM" });
    registry.set(domain, { type: "DISPOSABLE", sources: ["disposable-community"], confidence: "MEDIUM" });
  }
  for (const domain of castle) {
    if (!disposable.has(domain)) conflicts["castle-not-in-community"].push({ domain, feeds: listedBy(domain), resolved: "DISPOSABLE HIGH" });
    if (free.has(domain)) conflicts["free-provider-and-disposable"].push({ domain, feeds: listedBy(domain), resolved: "DISPOSABLE HIGH" });
    registry.set(domain, { type: "DISPOSABLE", sources: disposable.has(domain) ? ["castle-disposable", "disposable-community"] : ["castle-disposable"], confidence: "HIGH" });
  }
  for (const entry of exclusions) {
    const was = registry.get(entry.domain);
    conflicts.excluded.push({ domain: entry.domain, feeds: listedBy(entry.domain), resolved: "not listed", was: was ? `${was.type} ${was.confidence}` : "not in any feed", reason: entry.reason, reviewed_by: entry.reviewed_by });
    registry.delete(entry.domain);
  }
  for (const entry of overrides) {
    const was = registry.get(entry.domain);
    if (was && was.type !== entry.type) conflicts["override-differs-from-feeds"].push({ domain: entry.domain, feeds: listedBy(entry.domain), resolved: `${entry.type} HIGH`, was: `${was.type} ${was.confidence}`, reason: entry.reason });
    const agree = was && was.type === entry.type ? was.sources : [];
    registry.set(entry.domain, { type: entry.type, sources: [CURATED, ...agree], confidence: "HIGH" });
  }

  const rows = [...registry.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([domain, row]) => ({ domain, type: row.type, sources: row.sources, confidence: row.confidence }));
  for (const list of Object.values(conflicts)) list.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
  return { rows, conflicts };
}

/** Rows per type and per type and confidence. */
export function countRows(rows) {
  const by_type = {};
  const by_type_and_confidence = {};
  for (const row of rows) {
    by_type[row.type] = (by_type[row.type] ?? 0) + 1;
    const key = `${row.type} ${row.confidence}`;
    by_type_and_confidence[key] = (by_type_and_confidence[key] ?? 0) + 1;
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { by_type: sorted(by_type), by_type_and_confidence: sorted(by_type_and_confidence) };
}

/** What changed between two registries, by domain. */
export function diffRows(before, after) {
  const old = new Map(before.map((r) => [r.domain, r]));
  const now = new Map(after.map((r) => [r.domain, r]));
  const added = after.filter((r) => !old.has(r.domain));
  const removed = before.filter((r) => !now.has(r.domain));
  const changed = after.filter((r) => old.has(r.domain) && JSON.stringify(old.get(r.domain)) !== JSON.stringify(r))
    .map((r) => ({ domain: r.domain, from: `${old.get(r.domain).type} ${old.get(r.domain).confidence}`, to: `${r.type} ${r.confidence}` }));
  return { added, removed, changed };
}

// ------------------------------------------------------------ the gates

/** Problems with a registry: schema, canonical sorted unique domains, the sentinels, the exclusions, the overrides. */
export function checkRegistry(rows, { schema, overrides = [], exclusions = [] }) {
  const problems = validateSchema(rows, schema).slice(0, 20).map((p) => `registry: ${p}`);
  if (!Array.isArray(rows)) return problems;
  if (rows.length === 0) problems.push("registry: it is empty");
  const index = new Map();
  rows.forEach((row, i) => {
    const domain = row?.domain;
    if (typeof domain !== "string") return;
    if (canonicalDomain(domain) !== domain) problems.push(`registry: ${domain} is not a canonical domain`);
    if (index.has(domain)) problems.push(`registry: ${domain} is listed twice`);
    if (i > 0 && rows[i - 1]?.domain >= domain) problems.push(`registry: ${domain} is out of order`);
    if (row.type === "CUSTOM_DOMAIN" || row.type === "UNKNOWN") problems.push(`registry: ${domain} is ${row.type}, a result at run time that is never stored`);
    index.set(domain, row);
  });
  for (const s of SENTINELS) {
    const row = index.get(s.domain);
    if (!row || row.type !== s.type || (s.confidence && row.confidence !== s.confidence)) {
      problems.push(`sentinel: ${s.domain} should be ${s.type}${s.confidence ? ` ${s.confidence}` : ""}, is ${row ? `${row.type} ${row.confidence}` : "not listed"}`);
    }
  }
  for (const e of exclusions) if (index.has(e.domain)) problems.push(`exclusion: ${e.domain} is excluded but listed`);
  for (const o of overrides) {
    const row = index.get(o.domain);
    if (!row || row.type !== o.type || row.confidence !== "HIGH" || !row.sources.includes(CURATED)) problems.push(`override: ${o.domain} should be ${o.type} HIGH from ${CURATED}; run npm run email-domains`);
  }
  for (const row of index.values()) {
    if (row.sources?.includes(CURATED) && !overrides.some((o) => o.domain === row.domain)) problems.push(`registry: ${row.domain} names ${CURATED} but no override lists it; run npm run email-domains`);
  }
  const both = overrides.filter((o) => exclusions.some((e) => e.domain === o.domain));
  for (const o of both) problems.push(`${o.domain} is both an override and an exclusion; keep one`);
  return problems;
}

/** Problems with the feeds: too small, too many lines that are no domain. */
export function checkFeeds(parsed, feedList = FEEDS) {
  const problems = [];
  for (const feed of feedList) {
    const p = parsed[feed.id];
    if (!p) { problems.push(`feed ${feed.id}: missing`); continue; }
    if (p.domains.size < feed.min) problems.push(`feed ${feed.id}: ${p.domains.size} domains, fewer than the plausible ${feed.min}`);
    const lines = p.domains.size + p.invalid.length;
    if (lines && p.invalid.length / lines > MAX_INVALID_SHARE) problems.push(`feed ${feed.id}: ${p.invalid.length} of ${lines} lines are no domain, over ${MAX_INVALID_SHARE * 100} %`);
  }
  return problems;
}

/** Large changes against the published registry and manifest: the specification's 3.4 starting guideline. */
export function checkDelta(previousRows, rows, previousManifest, feedCounts) {
  const problems = [];
  if (previousRows.length > 0 && rows.length < previousRows.length * (1 - MAX_REGISTRY_SHRINK)) {
    problems.push(`delta: the registry shrinks from ${previousRows.length} to ${rows.length} rows, more than ${MAX_REGISTRY_SHRINK * 100} %`);
  }
  for (const [id, count] of Object.entries(feedCounts)) {
    const before = previousManifest?.source_counts?.[id];
    if (before && Math.abs(count - before) / before > MAX_FEED_CHANGE) problems.push(`delta: feed ${id} changes from ${before} to ${count} domains, more than ${MAX_FEED_CHANGE * 100} %`);
  }
  return problems;
}

// ------------------------------------------------------------ writing

/** The registry as published: an array, one object per line, so a diff shows one line per domain. */
export const registryText = (rows) => (rows.length ? `[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]\n` : "[]\n");

/** The module the Worker bundles: the version and the subset its policies use, grouped by type and confidence. */
export function runtimeText(rows, version) {
  const groups = groupRows(rows.filter(inWorker));
  const lines = Object.entries(groups).map(([key, list]) => `  ${JSON.stringify(key)}: ${JSON.stringify(list)},`);
  return [
    "// Generated by scripts/email-domains.mjs from data/email-domains.json; never edit by hand.",
    `// The Worker's copy of the registry (src/email-domains.js): every listed domain but ${OUTSIDE_THE_WORKER},`,
    "// grouped by type and confidence, so a lookup searches a string and the Worker's start does no work.",
    `export const REGISTRY_VERSION = ${JSON.stringify(version)};`,
    "export const GROUPS = {",
    ...lines,
    "};",
    "",
  ].join("\n");
}

/** The next registry version: the date, and a counter for a second build that day. */
export function nextVersion(previous, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(previous ?? "");
  return m && m[1] === day ? `${day}.${Number(m[2]) + 1}` : `${day}.1`;
}

const conflictCounts = (conflicts) => Object.fromEntries(Object.entries(conflicts).map(([k, v]) => [k, v.length]));

/** The Markdown summary the refresh workflow puts in its pull request. */
export function summaryText({ version, counts, previousCounts, diff, conflicts, warnings, feedCounts, previousFeedCounts }) {
  const out = [];
  if (warnings.length) {
    out.push("> [!WARNING]", "> **Unusually large change.** The builder's delta gate failed and this refresh was published with `--allow-large-change`. Check it before merging:", ...warnings.map((w) => `> - ${w}`), "");
  }
  out.push(`Registry version **${version}**: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} reclassified.`, "");
  out.push("| Type and confidence | Before | After |", "|---|---:|---:|");
  const keys = [...new Set([...Object.keys(previousCounts), ...Object.keys(counts)])].sort();
  for (const key of keys) out.push(`| ${key} | ${previousCounts[key] ?? 0} | ${counts[key] ?? 0} |`);
  out.push("", "| Feed | Domains before | Domains now |", "|---|---:|---:|");
  for (const [id, count] of Object.entries(feedCounts)) out.push(`| ${id} | ${previousFeedCounts?.[id] ?? "none"} | ${count} |`);
  out.push("", "Source conflicts (the workflow run's artifact holds the full report):", "");
  for (const [kind, n] of Object.entries(conflictCounts(conflicts))) out.push(`- ${kind}: ${n}`);
  const show = (title, list, line) => {
    if (!list.length) return;
    out.push("", `<details><summary>${title} (${list.length})</summary>`, "", ...list.slice(0, 200).map(line), list.length > 200 ? `- and ${list.length - 200} more` : "", "</details>");
  };
  show("Reclassified", diff.changed, (c) => `- ${c.domain}: ${c.from} to ${c.to}`);
  show("Removed", diff.removed, (r) => `- ${r.domain} (${r.type} ${r.confidence})`);
  show("Added, other than DISPOSABLE MEDIUM", diff.added.filter((r) => !(r.type === "DISPOSABLE" && r.confidence === "MEDIUM")), (r) => `- ${r.domain} (${r.type} ${r.confidence})`);
  return `${out.join("\n")}\n`;
}

// ------------------------------------------------------------ the command

const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const readJsonIf = (root, path, fallback) => (existsSync(join(root, path)) ? readJson(root, path) : fallback);

/** The hand-edited files and the schemas, with their problems. */
function readInputs(root) {
  const schemas = Object.fromEntries(Object.entries(FILES.schemas).map(([k, p]) => [k, readJson(root, p)]));
  const overrides = readJson(root, FILES.overrides);
  const exclusions = readJson(root, FILES.exclusions);
  const problems = [...checkHandList("overrides", overrides, schemas.overrides), ...checkHandList("exclusions", exclusions, schemas.exclusions)];
  return { schemas, overrides, exclusions, problems };
}

/** The committed files, offline: what npm test runs. */
export function check(root = ROOT) {
  const { schemas, overrides, exclusions, problems } = readInputs(root);
  const rows = readJson(root, FILES.registry);
  const manifest = readJson(root, FILES.manifest);
  problems.push(...checkRegistry(rows, { schema: schemas.registry, overrides, exclusions }));
  if (readFileSync(join(root, FILES.registry), "utf8") !== registryText(rows)) problems.push(`${FILES.registry}: not in the published layout (one object per line); run npm run email-domains`);
  if (manifest.row_count !== rows.length) problems.push(`manifest: row_count ${manifest.row_count}, the registry has ${rows.length}`);
  if (JSON.stringify(manifest.counts) !== JSON.stringify(countRows(rows))) problems.push("manifest: the counts do not match the registry");
  if (manifest.registry_sha256 !== sha256(readFileSync(join(root, FILES.registry), "utf8"))) problems.push("manifest: registry_sha256 does not match the registry; the registry was changed by hand");
  const runtime = join(root, FILES.runtime);
  if (!existsSync(runtime) || readFileSync(runtime, "utf8") !== runtimeText(rows, manifest.registry_version)) problems.push(`${FILES.runtime}: does not match the registry; run npm run email-domains`);
  return problems;
}

/** Fetch (or read), build, gate, then publish: returns the outcome, writes only when every gate passes. */
export async function build({ root = ROOT, feedsDir = null, allowLargeChange = false, now = new Date(), fetcher = fetch, log = console.log, fetchOptions, feedList = FEEDS } = {}) {
  const work = join(root, ".email-domains");
  const staging = join(work, "staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const { schemas, overrides, exclusions, problems } = readInputs(root);
  const texts = {};
  for (const feed of feedList) {
    try {
      texts[feed.id] = feedsDir ? readFileSync(join(feedsDir, `${feed.id}.txt`), "utf8") : await fetchFeed(feed, fetcher, fetchOptions);
      log(`feed ${feed.id}: ${Buffer.byteLength(texts[feed.id])} bytes`);
    } catch (error) {
      problems.push(`feed ${feed.id}: ${error.message}`);
    }
  }
  const parsed = Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, parseFeed(text)]));
  problems.push(...checkFeeds(parsed, feedList));
  if (problems.length) return fail(problems, log);

  const feeds = Object.fromEntries(Object.entries(parsed).map(([id, p]) => [id, p.domains]));
  const { rows, conflicts } = buildRegistry(feeds, overrides, exclusions);
  const previousRows = readJsonIf(root, FILES.registry, []);
  const previousManifest = readJsonIf(root, FILES.manifest, null);
  const feedCounts = Object.fromEntries(FEEDS.map((f) => [f.id, feeds[f.id].size]));
  const diff = diffRows(previousRows, rows);
  const unchanged = diff.added.length + diff.removed.length + diff.changed.length === 0 && previousRows.length > 0;
  const version = unchanged ? previousManifest?.registry_version : nextVersion(previousManifest?.registry_version, now);

  problems.push(...checkRegistry(rows, { schema: schemas.registry, overrides, exclusions }));
  const delta = checkDelta(previousRows, rows, previousManifest, feedCounts);
  const warnings = allowLargeChange ? delta : [];
  if (!allowLargeChange) problems.push(...delta);

  const counts = countRows(rows);
  const report = {
    registry_version: version,
    built_at: now.toISOString(),
    counts: conflictCounts(conflicts),
    invalid_feed_lines: Object.fromEntries(Object.entries(parsed).map(([id, p]) => [id, p.invalid])),
    conflicts,
  };
  writeFileSync(join(work, "source-conflicts.json"), `${JSON.stringify(report, null, 1)}\n`);
  const summary = summaryText({ version, counts: counts.by_type_and_confidence, previousCounts: previousManifest?.counts?.by_type_and_confidence ?? {}, diff, conflicts, warnings, feedCounts, previousFeedCounts: previousManifest?.source_counts });
  writeFileSync(join(work, "summary.md"), summary);
  if (problems.length) return fail(problems, log);
  if (unchanged) {
    log(`unchanged: registry ${version}, ${rows.length} rows; nothing written`);
    return { ok: true, changed: false, version, rows, conflicts, diff };
  }

  const text = registryText(rows);
  const manifest = {
    schema_version: 1,
    registry_version: version,
    built_at: now.toISOString(),
    ruleset_version: RULESET_VERSION,
    row_count: rows.length,
    counts,
    registry_sha256: sha256(text),
    source_versions: Object.fromEntries(FEEDS.map((f) => [f.id, sha256(texts[f.id])])),
    source_counts: feedCounts,
    sources: Object.fromEntries(FEEDS.map((f) => [f.id, { url: f.url, repository: f.repository, licence: f.licence }])),
    conflicts: conflictCounts(conflicts),
    ...(warnings.length ? { large_change_accepted: warnings } : {}),
  };
  writeFileSync(join(staging, "email-domains.json"), text);
  writeFileSync(join(staging, "email-domains-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(staging, "email-domains.generated.js"), runtimeText(rows, version));
  // Every gate passed: the staged files replace the published ones.
  renameSync(join(staging, "email-domains.json"), join(root, FILES.registry));
  renameSync(join(staging, "email-domains-manifest.json"), join(root, FILES.manifest));
  renameSync(join(staging, "email-domains.generated.js"), join(root, FILES.runtime));
  log(`published registry ${version}: ${rows.length} rows, ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} reclassified`);
  for (const [type, n] of Object.entries(counts.by_type)) log(`  ${type}: ${n}`);
  return { ok: true, changed: true, version, rows, conflicts, diff, warnings };
}

function fail(problems, log) {
  for (const p of problems) log(`FAILED ${p}`);
  log("Nothing was published; the registry stays as it was.");
  return { ok: false, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const problems = check();
    for (const p of problems) console.error(`FAILED ${p}`);
    if (problems.length) process.exit(1);
    console.log("email domain registry: the committed files pass every check");
  } else {
    const at = args.indexOf("--feeds");
    const result = await build({ feedsDir: at >= 0 ? args[at + 1] : null, allowLargeChange: args.includes("--allow-large-change") });
    if (!result.ok) process.exit(1);
  }
}
