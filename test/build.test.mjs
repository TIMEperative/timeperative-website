import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkPage, frontMatter, notesHtml } from "../scripts/build.mjs";

const page = { file: "src/pages/en/x.html", lang: "en", path: "/x/", meta: { title: "A title", description: "A description" } };
const exists = (path) => ["/", "/download/"].includes(path);

test("a page passes with one h1, headings in order and its links written", () => {
  assert.deepEqual(checkPage('<h1>T</h1><h2>A</h2><h3>B</h3><h2>C</h2><a href="/download/">d</a><img src="x" alt="">', page, exists), []);
});

test("finds two h1, a skipped level, a missing alt and a dead link", () => {
  const problems = checkPage('<h1>T</h1><h1>U</h1><h3>B</h3><img src="x"><a href="/nowhere/">n</a>', page, exists);
  assert.equal(problems.length, 4);
  assert.match(problems.join("\n"), /2 h1 elements/);
  assert.match(problems.join("\n"), /h1 is followed by h3/);
  assert.match(problems.join("\n"), /without alt/);
  assert.match(problems.join("\n"), /\/nowhere\//);
});

test("meta title and description lengths (WEB-002)", () => {
  const long = { ...page, meta: { title: "x".repeat(61), description: "" } };
  assert.equal(checkPage("<h1>T</h1>", long, exists).length, 2);
});

test("front matter is read from the opening comment", () => {
  const { meta, body } = frontMatter("<!--\ntitle: T: a page\nnav: home\n-->\n<h1>T</h1>\n", "x.html");
  assert.deepEqual(meta, { title: "T: a page", nav: "home" });
  assert.equal(body, "<h1>T</h1>\n");
  assert.throws(() => frontMatter("<h1>T</h1>", "x.html"));
});

test("release notes become headings, lists and escaped text", () => {
  assert.equal(notesHtml("## New\r\n- One <b>\n- Two `code`\n\nText"), "<h2>New</h2>\n<ul>\n<li>One &lt;b&gt;</li>\n<li>Two <code>code</code></li>\n</ul>\n<p>Text</p>");
});

test("the Worker routes in site.json and wrangler.jsonc agree", () => {
  const site = JSON.parse(readFileSync(new URL("../src/site.json", import.meta.url), "utf8"));
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const routes = JSON.parse(/"run_worker_first":\s*(\[[^\]]*\])/.exec(wrangler)[1]);
  assert.deepEqual(routes, site.workerRoutes);
});
