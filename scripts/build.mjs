// Builds timeperative.com into dist/.
//
//   node scripts/build.mjs            pages, news and the latest release from the stores
//   node scripts/build.mjs --offline  the same without reading the stores
//
// Pages are src/pages/<lang>/**/*.html, each opening with a comment of
// "key: value" lines (title, description, nav). English is served at /,
// the other languages under their prefix in site.json (/de/, /fr/, /es/),
// with the same paths. News and release notes come from
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
  <h${level}><a href="${localPath(lang, `/news/${i.slug}/`)}">${i.title[lang] ? escapeHtml(i.title[lang]) : `<span lang="en">${escapeHtml(i.title.en)}</span>`}</a></h${level}>
  ${i.subtitle?.[lang] ? `<p>${escapeHtml(i.subtitle[lang])}</p>` : i.subtitle?.en ? `<p lang="en">${escapeHtml(i.subtitle.en)}</p>` : ""}
</li>`).join("\n")}\n</ul>`;
}

// ------------------------------------------------------------ platforms

// The platform marks on the download buttons are the owner's decision against
// the vendors' guidelines (acustique HOST-007, AQ-089). Drawn
// in the text colour, so they follow the theme. Apple and Android: Simple
// Icons 16.35.0 (CC0-1.0 for the drawing; the Android robot is Google's,
// CC BY 3.0). Windows: four panes, drawn here.
const MARKS = {
  windows: "M0 0h11.4v11.4H0zM12.6 0H24v11.4H12.6zM0 12.6h11.4V24H0zM12.6 12.6H24V24H12.6z",
  android: "M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0254-1.1328a1.1001 1.1001 0 0 0-.9165-.4996.9631.9631 0 0 0-.9663.5252zm-.0078 8.4082c.5378.7972.4061 1.8366-.2944 2.3215-.7005.485-1.7038.2302-2.2416-.5669-.5378-.7972-.4061-1.8366.2944-2.3216.7005-.4849 1.7038-.2302 2.2416.567zM7.8887 14.4964c.5378-.7972.4061-1.8366-.2944-2.3216-.7005-.4849-1.7038-.2302-2.2416.5669-.5378.7972-.4061 1.8366.2944 2.3216.7005.4849 1.7038.2302 2.2416-.5669z",
  apple: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
};
MARKS.macos = MARKS.apple;
MARKS.ios = MARKS.apple;

const mark = (platform) => `<svg class="platform-mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path fill="currentColor" d="${MARKS[platform]}"/></svg>`;

/**
 * The four platforms as one row of buttons. Windows and Android download (on
 * the download page) or lead to it; macOS and iOS open, under the row, the
 * message that the version does not exist yet and the waitlist, so the row
 * itself never breaks. Without script a button is a link to its panel, which
 * shows as the target.
 */
function platformsHtml(lang, pagePath) {
  const t = strings[lang].platforms;
  const fill = (text, platform) => text.replaceAll("{platform}", t.names[platform]);
  const onDownloadPage = pagePath === "/download/";
  const available = ["windows", "android"].map((p) => {
    const href = onDownloadPage ? `/download/${p}` : `/download/#${p}`;
    const label = onDownloadPage ? fill(t.download, p) : fill(t.about, p);
    return `<li><a class="platform" href="${href}" aria-label="${escapeHtml(label)}">${mark(p)}<span>${escapeHtml(t.names[p])}</span></a></li>`;
  });
  const soon = ["macos", "ios"];
  const toggles = soon.map((p) => `<li><a class="platform" href="#waitlist-${p}" data-waitlist-toggle aria-controls="waitlist-${p}" aria-expanded="false">${mark(p)}<span>${escapeHtml(t.names[p])}</span></a></li>`);
  const panels = soon.map((p) => `<div class="waitlist" id="waitlist-${p}">
  <p>${escapeHtml(fill(t.soon, p))}</p>
  <form class="waitlist-form" method="post" action="/waitlist" data-ok="${escapeHtml(fill(t.ok, p))}" data-invalid="${escapeHtml(t.invalid)}" data-error="${escapeHtml(t.error.replace("{email}", site.supportEmail))}">
    <input type="hidden" name="platform" value="${p}">
    <input type="hidden" name="lang" value="${lang}">
    <input type="hidden" name="page" value="${localPath(lang, pagePath)}">
    <label for="waitlist-${p}-email">${escapeHtml(t.email)}</label>
    <div class="waitlist-row">
      <input id="waitlist-${p}-email" type="email" name="email" required maxlength="254" autocomplete="email" inputmode="email">
      <button class="button button-primary" type="submit">${escapeHtml(t.submit)}</button>
    </div>
    <p class="waitlist-trap" aria-hidden="true"><label>${escapeHtml(t.trap)} <input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
    <p class="fine">${escapeHtml(fill(t.use, p))} <a href="/privacy/#waitlist">${escapeHtml(t.privacy)}</a></p>
    <p class="waitlist-status" role="status" aria-live="polite"></p>
    <p class="waitlist-done" id="waitlist-${p}-ok">${escapeHtml(fill(t.ok, p))}</p>
    <p class="waitlist-done" id="waitlist-${p}-invalid">${escapeHtml(t.invalid)}</p>
    <p class="waitlist-done" id="waitlist-${p}-error">${escapeHtml(t.error.replace("{email}", site.supportEmail))}</p>
  </form>
</div>`);
  return `<div class="platform-block">\n<ul class="platforms" aria-label="${escapeHtml(t.label)}">\n${[...available, ...toggles].join("\n")}\n</ul>\n${panels.join("\n")}\n</div>`;
}

// ------------------------------------------------------------ screenshots

// Screens of the app itself, run in a browser with its demo backend and a
// sample week (scripts/shots.md), one file per colour scheme. The page shows
// the one that matches its own scheme.
const SHOTS = { week: [1440, 900], tracking: [1440, 900], planning: [1440, 900], reports: [1440, 900], phone: [780, 1688] };

function shotHtml(name, lang, { caption = true } = {}) {
  const t = strings[lang].shots[name];
  const [w, h] = SHOTS[name];
  const img = (scheme) => `<img class="shot-img shot-${scheme}" src="/assets/shots/${name}-${scheme}.webp" alt="${escapeHtml(t.alt)}" width="${w}" height="${h}" loading="lazy" decoding="async">`;
  return `<figure class="shot shot-${name}">${img("dark")}${img("light")}${caption ? `<figcaption>${escapeHtml(t.caption)}</figcaption>` : ""}</figure>`;
}

function shotsSection(lang) {
  const t = strings[lang].shots;
  return `<section class="section shots-section">
  <div class="container">
    <h2>${escapeHtml(t.title)}</h2>
    <p class="note">${escapeHtml(t.intro)}</p>
    <div class="shots-main">${shotHtml("week", lang)}${shotHtml("phone", lang)}</div>
    <div class="shots-row">${shotHtml("tracking", lang)}${shotHtml("planning", lang)}${shotHtml("reports", lang)}</div>
  </div>
</section>`;
}

// ------------------------------------------------------------ languages

/** The language menu: the current language's flag and code, the others to choose. */
function switcherHtml(page) {
  const isNotFound = page.path === "/404.html";
  const current = site.languages.find((l) => l.code === page.lang);
  const flag = (l) => `<img class="flag" src="/assets/flags/${l.code}.svg" alt="" width="21" height="14">`;
  const items = site.languages.map((l) => {
    const name = strings[l.code].language.name;
    const here = l.code === page.lang;
    return `<li><a href="${localPath(l.code, isNotFound ? "/" : page.path)}" hreflang="${l.locale}" lang="${l.locale}"${here ? ' aria-current="true"' : ""}>${flag(l)}<span class="lang-code">${l.code.toUpperCase()}</span><span class="lang-name">${escapeHtml(name)}</span></a></li>`;
  }).join("");
  const t = strings[page.lang].language;
  return `<details class="lang-menu"><summary aria-label="${escapeHtml(`${t.label}: ${t.name}`)}">${flag(current)}<span class="lang-code">${current.code.toUpperCase()}</span></summary><ul>${items}</ul></details>`;
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
  const nav = site.nav.map((n) => {
    const current = page.meta.nav === n.id;
    return `<li><a href="${localPath(page.lang, n.path)}"${current ? ' aria-current="page"' : ""}>${escapeHtml(t.nav[n.id])}</a></li>`;
  }).join("");
  const footerLinks = site.footer.map((n) => `<li><a href="${localPath(page.lang, n.path)}">${escapeHtml(t.footer[n.id])}</a></li>`).join("");
  const isNotFound = page.path === "/404.html";
  const alternates = isNotFound ? "" : site.languages.map((l) => `<link rel="alternate" hreflang="${l.locale}" href="${site.origin}${localPath(l.code, page.path)}">`).join("\n")
    + `\n<link rel="alternate" hreflang="x-default" href="${site.origin}${localPath("en", page.path)}">`;
  const switcher = switcherHtml(page);
  const fill = (text) => text
    .replace(/\{\{release\.summary\}\}/g, ctx.releaseSummary(page.lang))
    .replace(/\{\{release\.notes\}\}/g, ctx.releaseNotesLink(page.lang))
    .replace(/\{\{release\.page\}\}/g, site.releasePage)
    .replace(/\{\{news\.latest\}\}/g, newsList(ctx.news, page.lang, 3))
    .replace(/\{\{news\.all\}\}/g, newsList(ctx.news, page.lang, undefined, 2))
    .replace(/\{\{platforms\}\}/g, () => platformsHtml(page.lang, page.path))
    .replace(/\{\{shots\}\}/g, () => shotsSection(page.lang))
    .replace(/\{\{shot:(\w+)\}\}/g, (all, name) => shotHtml(name, page.lang))
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
    origin: site.origin,
    skip: escapeHtml(t.skip),
    navLabel: escapeHtml(t.navLabel),
    nav,
    switcher,
    footerLinks,
    footerLabel: escapeHtml(t.footer.label),
    tagline: escapeHtml(t.tagline),
    contact: escapeHtml(t.footer.contact),
    supportEmail: site.supportEmail,
    schemeLabel: escapeHtml(t.scheme.label),
    schemeSystem: escapeHtml(t.scheme.system),
    schemeNames: escapeHtml(JSON.stringify({ dark: t.scheme.dark, light: t.scheme.light, system: t.scheme.system })),
    schemeLight: escapeHtml(t.scheme.light),
    schemeDark: escapeHtml(t.scheme.dark),
    robots: isNotFound ? '<meta name="robots" content="noindex">' : "",
    content: localiseLinks(fill(page.body), page.lang),
  };
  return layout.replace(/\{\{(\w+)\}\}/g, (all, key) => (key in vars ? vars[key] : all));
}

function articlePage(item, lang) {
  const t = strings[lang];
  // News written in English and German only shows its English in the other languages, marked as English.
  const own = (field) => item[field]?.[lang];
  const english = (field) => item[field]?.en;
  const title = own("title") ?? english("title");
  return {
    lang,
    path: `/news/${item.slug}/`,
    meta: { title: own("metaTitle") || title, description: own("metaDescription") || own("subtitle") || english("metaDescription") || english("subtitle") || "", nav: "home" },
    body: `<article class="container article">
<p class="breadcrumb"><a href="${localPath(lang, "/news/")}">${escapeHtml(t.news.title)}</a></p>
<h1${own("title") ? "" : ' lang="en"'}>${escapeHtml(title)}</h1>
<p class="news-meta"><span class="kind">${escapeHtml(t.news.kinds[item.kind] ?? item.kind)}</span> <time datetime="${item.published}">${formatDate(item.published, lang)}</time></p>
${own("subtitle") ? `<p class="lead">${escapeHtml(own("subtitle"))}</p>` : english("subtitle") ? `<p class="lead" lang="en">${escapeHtml(english("subtitle"))}</p>` : ""}
<div class="prose"${own("body") ? "" : ' lang="en"'}>
${own("body") ?? english("body")}
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
