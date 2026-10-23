// News and release articles from Notion into content/news/notion/.
//
//   NOTION_TOKEN=... node scripts/notion-news.mjs [--strict]
//   node scripts/notion-news.mjs --if-token   (the site build: skips without a
//                                              token, warns instead of failing)
//
// Reads the Notion database "TIMEperative website content" (TIMEperative >
// TIMEperative.com website) and keeps the rows whose Status is Publish and
// whose Kind is News or Release. Each row becomes one JSON file that the
// build turns into /news/<slug>/ and /de/news/<slug>/. The article's body is
// English, then a heading 1 "Deutsch", then the German (as acunomic.com's
// blog articles are written). Images are copied out of Notion, whose file
// links expire after an hour.
//
// A row that breaks a rule (slug, titles, meta lengths, long dashes, the
// sharp s in German) is left out and named on stderr; --strict makes that
// fail. The folder is rewritten on every run, so a row set back to Draft or
// Withdrawn disappears at the next build. The integration behind
// NOTION_TOKEN must be shared with the database. Behind a proxy, set
// NODE_USE_ENV_PROXY=1. Node built-ins only.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "content/news/notion");
const MEDIA = join(ROOT, "content/news/media");
const DATA_SOURCE = "eda9f42b-758d-4fe1-8b1c-0d853e18284e";
const NOTION_VERSION = "2026-03-11"; // as acustique build/lib/notion.mjs
const API = "https://api.notion.com/v1";
const SEPARATORS = new Set(["deutsch", "german"]);

const token = process.env.NOTION_TOKEN;

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Notion ${method} ${path}: HTTP ${res.status}: ${(await res.text()).replaceAll(token, "[REDACTED]").slice(0, 400)}`);
  return res.json();
}

async function rows() {
  const out = [];
  let cursor;
  do {
    const page = await call("POST", `/data_sources/${DATA_SOURCE}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
      filter: { and: [
        { property: "Status", select: { equals: "Publish" } },
        { or: [{ property: "Kind", select: { equals: "News" } }, { property: "Kind", select: { equals: "Release" } }] },
      ] },
    });
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function children(blockId) {
  const out = [];
  let cursor;
  do {
    const page = await call("GET", `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const block of page.results) {
      if (block.has_children && block.type !== "child_page") block.children = await children(block.id);
      out.push(block);
    }
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

const plain = (rich) => (rich ?? []).map((r) => r.plain_text ?? "").join("");
const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function property(page, name) {
  const p = page.properties?.[name];
  if (!p) return "";
  if (p.type === "title" || p.type === "rich_text") return plain(p[p.type]).trim();
  if (p.type === "select") return p.select?.name ?? "";
  if (p.type === "date") return p.date?.start ?? "";
  return "";
}

/** Our own links relative; app.notion.com links are a mistake in an article. */
function link(href, problems) {
  try {
    const url = new URL(href);
    if (["timeperative.com", "www.timeperative.com"].includes(url.host)) return url.pathname + url.search + url.hash;
    if (url.host === "app.notion.com" || url.host.endsWith("notion.so")) problems.push(`link to Notion (${href}); link the page on www.timeperative.com instead`);
  } catch {
    // a relative link stays as written
  }
  return href;
}

function richHtml(rich, problems) {
  return (rich ?? []).map((part) => {
    let text = escapeHtml(part.plain_text ?? "");
    const a = part.annotations ?? {};
    if (a.code) text = `<code>${text}</code>`;
    if (a.bold) text = `<strong>${text}</strong>`;
    if (a.italic) text = `<em>${text}</em>`;
    if (a.strikethrough) text = `<s>${text}</s>`;
    if (part.href) text = `<a href="${escapeHtml(link(part.href, problems))}">${text}</a>`;
    return text;
  }).join("");
}

/** Notion blocks as HTML. Colours are dropped: every colour comes from a token. */
function render(blocks, ctx) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const kind = block.type;
    if (kind === "bulleted_list_item" || kind === "numbered_list_item") {
      const tag = kind === "bulleted_list_item" ? "ul" : "ol";
      const items = [];
      while (i < blocks.length && blocks[i].type === kind) {
        items.push(`<li>${richHtml(blocks[i][kind].rich_text, ctx.problems)}${render(blocks[i].children ?? [], ctx)}</li>`);
        i++;
      }
      i--;
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    const data = block[kind] ?? {};
    if (kind === "paragraph") { if (data.rich_text?.length) out.push(`<p>${richHtml(data.rich_text, ctx.problems)}</p>`); }
    else if (kind === "heading_2" || kind === "heading_3") out.push(`<h${kind.at(-1)}>${richHtml(data.rich_text, ctx.problems)}</h${kind.at(-1)}>`);
    else if (kind === "heading_1") ctx.problems.push(`a heading 1 other than "Deutsch": the title is the page's only h1, use heading 2`);
    else if (kind === "quote" || kind === "callout") out.push(`<blockquote><p>${richHtml(data.rich_text, ctx.problems)}</p>${render(block.children ?? [], ctx)}</blockquote>`);
    else if (kind === "divider") out.push("<hr>");
    else if (kind === "image") {
      const source = data.file?.url ?? data.external?.url ?? "";
      const alt = plain(data.caption);
      if (!alt) ctx.problems.push("an image without a caption: the caption is its alt text (WEB-003)");
      ctx.media.push(source);
      out.push(`<figure><img src="{{media:${ctx.media.length - 1}}}" alt="${escapeHtml(alt)}" loading="lazy"></figure>`);
    } else if (kind === "table") {
      const rows = (block.children ?? []).map((row, n) => {
        const cell = n === 0 && data.has_column_header ? "th" : "td";
        return `<tr>${row.table_row.cells.map((c) => `<${cell}>${richHtml(c, ctx.problems)}</${cell}>`).join("")}</tr>`;
      });
      const head = data.has_column_header ? `<thead>${rows.shift() ?? ""}</thead>` : "";
      out.push(`<table>${head}<tbody>${rows.join("")}</tbody></table>`);
    } else ctx.problems.push(`unsupported Notion block "${kind}": write it as text`);
    if (!["quote", "callout", "table"].includes(kind) && block.children?.length && !kind.endsWith("list_item")) out.push(render(block.children, ctx));
  }
  return out.join("\n");
}

function splitLanguages(blocks) {
  const n = blocks.findIndex((b) => b.type === "heading_1" && SEPARATORS.has(plain(b.heading_1.rich_text).trim().toLowerCase()));
  if (n < 0) return [blocks, []];
  let english = blocks.slice(0, n);
  if (english[0]?.type === "heading_1" && plain(english[0].heading_1.rich_text).trim().toLowerCase() === "english") english = english.slice(1);
  return [english, blocks.slice(n + 1)];
}

const COPY = [
  [/—/, "a long dash (COPY-001)"],
  [/–/, "an en dash (COPY-002)"],
  // acustique brands/timely-you not_public: the site never names Odoo; host names and paths are not copy.
  [/(?<![/\\.@_\w])[Oo][Dd][Oo][Oo]s?(?![/\\_\w]|\.\w)/u, "Odoo; write TIMEperative Cloud Sync (COPY-016)"],
];

/** The rules a row must meet; returns what is wrong. */
export function problemsOf(item) {
  const problems = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(item.slug)) problems.push(`Slug "${item.slug}" must be English, lowercase and hyphenated`);
  if (!/^\d{4}-\d{2}-\d{2}/.test(item.published)) problems.push("Published is empty");
  for (const lang of ["en", "de"]) {
    const suffix = lang === "de" ? " DE" : "";
    if (!item.title[lang]) problems.push(`Title${suffix} is empty`);
    if ((item.metaTitle[lang] || item.title[lang]).length > 60) problems.push(`Meta title${suffix} is over 60 characters (WEB-002)`);
    const description = item.metaDescription[lang] || item.subtitle[lang];
    if (!description) problems.push(`Meta description${suffix} and Subtitle${suffix} are empty (WEB-002)`);
    else if (description.length > 155) problems.push(`Meta description${suffix} is over 155 characters (WEB-002)`);
    if (!item.body[lang]) problems.push(lang === "de" ? 'no German text after a heading 1 "Deutsch"' : "no English text");
    const text = [item.title[lang], item.subtitle[lang], item.metaTitle[lang], item.metaDescription[lang], item.body[lang]].join("\n");
    for (const [re, what] of COPY) if (re.test(text)) problems.push(`${lang}: ${what}`);
    if (lang === "de" && /ß/.test(text)) problems.push("de: the sharp s; Swiss German writes ss (COPY-003)");
  }
  return problems;
}

async function copyMedia(url, slug, n) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`image ${n}: HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" }[type.split(";")[0]];
  if (!ext) throw new Error(`image ${n}: unsupported type ${type}`);
  const name = `${slug}-${n + 1}.${ext}`;
  writeFileSync(join(MEDIA, name), Buffer.from(await res.arrayBuffer()));
  return `/news/media/${name}`;
}

async function main() {
  if (!token) throw new Error("Set NOTION_TOKEN to an integration that the database TIMEperative website content is shared with.");
  rmSync(OUT, { recursive: true, force: true });
  rmSync(MEDIA, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(MEDIA, { recursive: true });
  const skipped = [];
  let written = 0;
  for (const page of await rows()) {
    const ctx = { problems: [], media: [] };
    const [en, de] = splitLanguages(await children(page.id));
    const item = {
      slug: property(page, "Slug"),
      kind: property(page, "Kind"),
      published: property(page, "Published"),
      title: { en: property(page, "Title"), de: property(page, "Title DE") },
      subtitle: { en: property(page, "Subtitle"), de: property(page, "Subtitle DE") },
      metaTitle: { en: property(page, "Meta title"), de: property(page, "Meta title DE") },
      metaDescription: { en: property(page, "Meta description"), de: property(page, "Meta description DE") },
      body: { en: render(en, ctx), de: render(de, ctx) },
      source: `notion:${page.id}`,
    };
    const problems = [...ctx.problems, ...problemsOf(item)];
    if (problems.length) { skipped.push({ title: item.title.en || page.id, url: page.url, problems }); continue; }
    try {
      const urls = await Promise.all(ctx.media.map((url, n) => copyMedia(url, item.slug, n)));
      for (const lang of ["en", "de"]) item.body[lang] = item.body[lang].replace(/\{\{media:(\d+)\}\}/g, (all, n) => urls[Number(n)]);
    } catch (error) {
      skipped.push({ title: item.title.en, url: page.url, problems: [error.message] });
      continue;
    }
    writeFileSync(join(OUT, `${item.slug}.json`), JSON.stringify(item, null, 2) + "\n");
    written++;
  }
  console.log(`notion-news: ${written} article(s) written, ${skipped.length} left out`);
  for (const s of skipped) console.error(`left out: ${s.title} (${s.url})\n  - ${s.problems.join("\n  - ")}`);
  if (skipped.length && process.argv.includes("--strict")) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const optional = process.argv.includes("--if-token");
  if (optional && !token) {
    console.log("notion-news: no NOTION_TOKEN, the site is built without the news from Notion");
  } else {
    // In the site build a Notion outage must not stop a deployment: warn, build without news.
    main().catch((error) => { console.error(error.message); process.exit(optional ? 0 : 1); });
  }
}
