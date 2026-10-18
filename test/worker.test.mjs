import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { latestInstaller } from "../src/worker.js";

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
  const res = await worker.fetch(new Request("https://timeperative.com/download/"), env);
  assert.equal(await res.text(), "asset");
  assert.deepEqual(seen, ["/download/"]);
});
