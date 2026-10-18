// Builds timeperative.com into dist/.
//
//   node scripts/build.mjs            pages, news and the latest release from the stores
//   node scripts/build.mjs --offline  the same without reading the stores
//
// Pages are src/pages/<lang>/**/*.html, each opening with a comment of
// "key: value" lines (title, description, nav). English is served at /,
// German at /de/, with the same paths. News and release notes come from
// content/news/*.json (written by scripts/notion-news.mjs) and from the
// update manifests the app's release workflows publish. The build then
// checks every page it wrote (one h1, headings that never skip, meta
// lengths, alt text, internal links) and fails on any error.
//
// Node built-ins only.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const OFFLINE = process.argv.includes("--offline");

const read = (path) => readFileSync(join(ROOT, path), "utf8");
const site = JSON.parse(read("src/site.json"));
const strings = Object.fromEntries(site.languages.map((l) => [l.code, JSON.parse(read(`src/i18n/${l.code}.json`))]));
const layout = read("src/layout.html");

export const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** "<!--\nkey: value\n-->" at the top of a page, then its body. */
export function frontMatter(text, file) {
  const m = /^<!--\n([\s\S]*?)\n-->\n/.exec(text);
  if (!m) throw new Error(`${file}: the page must open with a <!-- key: value --> block`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: text.slice(m[0].length) };
}

/** A language's URL for a path that every language shares ("/download/"). */
const localPath = (lang, path) => (site.languages.find((l) => l.code === lang).prefix + path).replace(/\/{2,}/g, "/") || "/";

function formatDate(iso, lang) {
  const locale = site.languages.find((l) => l.code === lang).locale;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
}

// ------------------------------------------------------------ the release

const PLATFORMS = {
  windows: { file: "latest.json", url: (m) => m.platforms?.["windows-x86_64"]?.url, date: (m) => m.pub_date },
  android: { file: "latest-android.json", url: (m) => m.url, date: (m) => m.pubDate },
};

/** The newest release per platform across the stores, as the Worker picks it. */
async function readRelease() {
  if (OFFLINE) return null;
  const release = {};
  for (const [platform, p] of Object.entries(PLATFORMS)) {
    for (const store of site.stores) {
      try {
        const res = await fetch(`https://github.com/${store}/releases/latest/download/${p.file}`, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) continue;
        const manifest = await res.json();
        const date = p.date(manifest);
        if (!p.url(manifest) || !date) continue;
        if (!release[platform] || Date.parse(date) > Date.parse(release[platform].date)) {
          release[platform] = { version: manifest.version, date, notes: manifest.notes ?? "", store };
        }
      } catch (error) {
        console.warn(`release: ${store} ${p.file}: ${error.message}`);
      }
    }
  }
  if (!release.windows && !release.android) {
    console.warn("release: no store answered; pages show the release page link only");
    return null;
  }
  return release;
}

/** The release notes are Markdown with headings, bullets and paragraphs. */
export function notesHtml(markdown) {
  const inline = (text) => escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const out = [];
  let list = false;
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const item = /^[-*] (.*)$/.exec(line);
    if (!item && list) { out.push("</ul>"); list = false; }
    if (!line) continue;
    const heading = /^#{1,6} (.*)$/.exec(line);
    if (heading) out.push(`<h2>${inline(heading[1])}</h2>`);
    else if (item) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(item[1])}</li>`); }
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("\n");
}

const releaseSlug = (version) => `release-${version.replace(/[^0-9a-z]+/gi, "-").toLowerCase()}`;

function releaseArticle(release) {
  const r = release.windows ?? release.android;
  const title = (lang) => strings[lang].release.title.replace("{version}", r.version);
  const meta = (lang) => strings[lang].release.metaDescription.replace("{version}", r.version);
  const body = notesHtml(r.notes);
  return {
    slug: releaseSlug(r.version),
    kind: "Release",
    published: r.date.slice(0, 10),
    title: Object.fromEntries(site.languages.map((l) => [l.code, title(l.code)])),
    subtitle: Object.fromEntries(site.languages.map((l) => [l.code, strings[l.code].release.subtitle])),
    metaTitle: Object.fromEntries(site.languages.map((l) => [l.code, title(l.code)])),
    metaDescription: Object.fromEntries(site.languages.map((l) => [l.code, meta(l.code)])),
    // Release notes are written in English only; other languages say so and show them.
    body: Object.fromEntries(site.languages.map((l) => [l.code, l.code === "en" ? body : `<p>${escapeHtml(strings[l.code].release.englishOnly)}</p>\n<div lang="en">\n${body}\n</div>`])),
  };
}

// ------------------------------------------------------------ news

function readNews(release) {
  const items = walk(join(ROOT, "content/news")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(f, "utf8")));
  if (release) {
    const article = releaseArticle(release);
    if (!items.some((i) => i.slug === article.slug)) items.push(article);
  }
  return items.sort((a, b) => b.published.localeCompare(a.published) || a.slug.localeCompare(b.slug));
}

function newsList(items, lang, limit, level = 3) {
  const t = strings[lang];
  const shown = items.slice(0, limit ?? items.length);
  if (!shown.length) return `<p class="empty">${escapeHtml(t.news.empty)}</p>`;
  return `<ul class="news-list">\n${shown.map((i) => `<li class="news-item">
  <p class="news-meta"><span class="kind">${escapeHtml(t.news.kinds[i.kind] ?? i.kind)}</span> <time datetime="${i.published}">${formatDate(i.published, lang)}</time></p>
  <h${level}><a href="${localPath(lang, `/news/${i.slug}/`)}">${escapeHtml(i.title[lang] ?? i.title.en)}</a></h${level}>
  ${i.subtitle?.[lang] ? `<p>${escapeHtml(i.subtitle[lang])}</p>` : ""}
</li>`).join("\n")}\n</ul>`;
}

// ------------------------------------------------------------ pages

function pagesOf(lang) {
  const dir = join(ROOT, "src/pages", lang);
  return walk(dir).filter((f) => f.endsWith(".html")).map((file) => {
    const rel = relative(dir, file).split(sep).join("/").replace(/\.html$/, "");
    const { meta, body } = frontMatter(readFileSync(file, "utf8"), relative(ROOT, file));
    const path = rel === "index" ? "/" : rel === "404" ? "/404.html" : `/${rel.replace(/\/index$/, "")}/`;
    return { lang, path, meta, body, file: relative(ROOT, file) };
  });
}

/** Page sources link the shared paths ("/download/"); another language's page links its own. */
function localiseLinks(html, lang) {
  const own = localPath(lang, "/");
  if (own === "/") return html;
  return html.replace(/\bhref="(\/[^"]*)"/g, (all, path) =>
    /^\/(assets|fonts|news\/media)\//.test(path) || site.workerRoutes.includes(path) || path.startsWith(own) ? all : `href="${localPath(lang, path)}"`);
}

function render(page, ctx) {
  const t = strings[page.lang];
  const lang = site.languages.find((l) => l.code === page.lang);
  const other = site.languages.filter((l) => l.code !== page.lang);
  const nav = site.nav.map((n) => {
    const current = page.meta.nav === n.id;
    return `<li><a href="${localPath(page.lang, n.path)}"${current ? ' aria-current="page"' : ""}>${escapeHtml(t.nav[n.id])}</a></li>`;
  }).join("");
  const footerLinks = site.footer.map((n) => `<li><a href="${localPath(page.lang, n.path)}">${escapeHtml(t.footer[n.id])}</a></li>`).join("");
  const isNotFound = page.path === "/404.html";
  const alternates = isNotFound ? "" : site.languages.map((l) => `<link rel="alternate" hreflang="${l.locale}" href="${site.origin}${localPath(l.code, page.path)}">`).join("\n")
    + `\n<link rel="alternate" hreflang="x-default" href="${site.origin}${localPath("en", page.path)}">`;
  const switcher = other.map((l) => `<a class="lang-switch" href="${localPath(l.code, isNotFound ? "/" : page.path)}" hreflang="${l.locale}" lang="${l.locale}">${escapeHtml(strings[l.code].language.name)}</a>`).join("");
  const fill = (text) => text
    .replace(/\{\{release\.summary\}\}/g, ctx.releaseSummary(page.lang))
    .replace(/\{\{release\.notes\}\}/g, ctx.releaseNotesLink(page.lang))
    .replace(/\{\{release\.page\}\}/g, site.releasePage)
    .replace(/\{\{news\.latest\}\}/g, newsList(ctx.news, page.lang, 3))
    .replace(/\{\{news\.all\}\}/g, newsList(ctx.news, page.lang, undefined, 2))
    .replace(/\{\{support\.email\}\}/g, site.supportEmail)
    .replace(/\{\{year\}\}/g, String(new Date().getUTCFullYear()));
  const vars = {
    locale: lang.locale,
    title: escapeHtml(page.meta.title),
    description: escapeHtml(page.meta.description),
    canonical: isNotFound ? "" : `<link rel="canonical" href="${site.origin}${page.path === "/404.html" ? "/" : localPath(page.lang, page.path)}">`,
    ogUrl: `${site.origin}${localPath(page.lang, isNotFound ? "/" : page.path)}`,
    alternates,
    home: localPath(page.lang, "/"),
    skip: escapeHtml(t.skip),
    navLabel: escapeHtml(t.navLabel),
    nav,
    switcher,
    footerLinks,
    footerLabel: escapeHtml(t.footer.label),
    tagline: escapeHtml(t.tagline),
    owner: escapeHtml(t.footer.owner),
    contact: escapeHtml(t.footer.contact),
    supportEmail: site.supportEmail,
    schemeLabel: escapeHtml(t.scheme.label),
    schemeSystem: escapeHtml(t.scheme.system),
    schemeLight: escapeHtml(t.scheme.light),
    schemeDark: escapeHtml(t.scheme.dark),
    robots: isNotFound ? '<meta name="robots" content="noindex">' : "",
    content: localiseLinks(fill(page.body), page.lang),
  };
  return layout.replace(/\{\{(\w+)\}\}/g, (all, key) => (key in vars ? vars[key] : all));
}

function articlePage(item, lang) {
  const t = strings[lang];
  const title = item.title[lang] ?? item.title.en;
  return {
    lang,
    path: `/news/${item.slug}/`,
    meta: { title: item.metaTitle?.[lang] || title, description: item.metaDescription?.[lang] || item.subtitle?.[lang] || "", nav: "home" },
    body: `<article class="container article">
<p class="breadcrumb"><a href="${localPath(lang, "/news/")}">${escapeHtml(t.news.title)}</a></p>
<h1>${escapeHtml(title)}</h1>
<p class="news-meta"><span class="kind">${escapeHtml(t.news.kinds[item.kind] ?? item.kind)}</span> <time datetime="${item.published}">${formatDate(item.published, lang)}</time></p>
${item.subtitle?.[lang] ? `<p class="lead">${escapeHtml(item.subtitle[lang])}</p>` : ""}
<div class="prose">
${item.body[lang] ?? item.body.en}
</div>
</article>`,
    file: `content/news/${item.slug}.json`,
  };
}

// ------------------------------------------------------------ checks

/** Structural checks on a written page: WEB-001, WEB-002, WEB-003 and links. */
export function checkPage(html, page, exists) {
  const problems = [];
  const where = `${page.file} (${localPath(page.lang, page.path)})`;
  const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  if (levels.filter((l) => l === 1).length !== 1) problems.push(`${where}: ${levels.filter((l) => l === 1).length} h1 elements, expected exactly one (WEB-001)`);
  levels.forEach((l, i) => { if (i > 0 && l > levels[i - 1] + 1) problems.push(`${where}: h${levels[i - 1]} is followed by h${l} (WEB-001)`); });
  const title = page.meta.title ?? "";
  const description = page.meta.description ?? "";
  if (!title || title.length > 60) problems.push(`${where}: meta title has ${title.length} characters, 1 to 60 allowed (WEB-002)`);
  if (!description || description.length > 155) problems.push(`${where}: meta description has ${description.length} characters, 1 to 155 allowed (WEB-002)`);
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) if (!/\balt=/.test(m[0])) problems.push(`${where}: <img> without alt (WEB-003)`);
  for (const m of html.matchAll(/\b(?:href|src)="(\/[^"#?]*)/g)) if (!exists(m[1])) problems.push(`${where}: link to ${m[1]}, which the build does not write`);
  return problems;
}

// ------------------------------------------------------------ build

export async function build() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  cpSync(join(ROOT, "src/static"), DIST, { recursive: true });
  if (existsSync(join(ROOT, "content/news/media"))) cpSync(join(ROOT, "content/news/media"), join(DIST, "news/media"), { recursive: true });

  const release = await readRelease();
  const news = readNews(release);
  const latest = release && (release.windows ?? release.android);
  const ctx = {
    news,
    releaseSummary: (lang) => {
      const t = strings[lang].release;
      if (!latest) return `<p class="release-summary">${t.unknown.replace("{link}", `<a href="${site.releasePage}">${escapeHtml(t.releasePage)}</a>`)}</p>`;
      return `<p class="release-summary">${t.summary.replace("{version}", `<strong>${escapeHtml(latest.version)}</strong>`).replace("{date}", `<time datetime="${latest.date.slice(0, 10)}">${formatDate(latest.date, lang)}</time>`)}</p>`;
    },
    releaseNotesLink: (lang) => latest
      ? `<a href="${localPath(lang, `/news/${releaseSlug(latest.version)}/`)}">${escapeHtml(strings[lang].release.notesLink)}</a>`
      : `<a href="${site.releasePage}">${escapeHtml(strings[lang].release.releasePage)}</a>`,
  };

  const pages = site.languages.flatMap((l) => pagesOf(l.code));
  const byLang = Object.fromEntries(site.languages.map((l) => [l.code, new Set(pages.filter((p) => p.lang === l.code).map((p) => p.path))]));
  const problems = [];
  for (const l of site.languages.slice(1)) {
    for (const path of byLang.en) if (!byLang[l.code].has(path)) problems.push(`src/pages/${l.code}: ${path} is missing (every language has every page)`);
    for (const path of byLang[l.code]) if (!byLang.en.has(path)) problems.push(`src/pages/${l.code}: ${path} has no English page`);
  }
  for (const item of news) for (const l of site.languages) pages.push(articlePage(item, l.code));

  const written = [];
  for (const page of pages) {
    const out = page.path === "/404.html" ? localPath(page.lang, "/404.html") : join(localPath(page.lang, page.path), "index.html");
    const file = join(DIST, out);
    mkdirSync(dirname(file), { recursive: true });
    const html = render(page, ctx);
    writeFileSync(file, html);
    written.push({ page, html });
  }

  const sitemap = pages.filter((p) => p.lang === "en" && p.path !== "/404.html").map((p) => `<url><loc>${site.origin}${p.path}</loc>${site.languages.map((l) => `<xhtml:link rel="alternate" hreflang="${l.locale}" href="${site.origin}${localPath(l.code, p.path)}"/>`).join("")}</url>`);
  writeFileSync(join(DIST, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${sitemap.join("\n")}\n</urlset>\n`);
  writeFileSync(join(DIST, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${site.origin}/sitemap.xml\n`);

  const exists = (path) => site.workerRoutes.includes(path)
    || existsSync(join(DIST, path)) && (statSync(join(DIST, path)).isFile() || existsSync(join(DIST, path, "index.html")));
  for (const { page, html } of written) problems.push(...checkPage(html, page, exists));

  if (problems.length) {
    for (const p of problems) console.error(`error: ${p}`);
    throw new Error(`build: ${problems.length} problem(s)`);
  }
  console.log(`build: ${written.length} pages, ${news.length} news item(s), release ${latest ? latest.version : "unknown"}`);
  return { pages: written.length, news: news.length, release: latest?.version ?? null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build().catch((error) => { console.error(error.message); process.exit(1); });
}
