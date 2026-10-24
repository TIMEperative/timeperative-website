# Screenshots of the app

`src/static/assets/shots/` holds screens of the TIMEperative app itself, not
mock-ups. The app's React front end runs in a browser with its demo backend
(youserpath/timely-you `src/api/mock.ts`, "UI previews, screenshots"). The
script below fills that backend with a sample month for a fictional person,
Alex Meier, with fictional projects (Contoso rollout, Fabrikam website), and
captures each screen in the dark and the light scheme, with the TIMEperative
orange as the accent and the projects in the brand's orange and purple. Every
name and entry on these screens is an example.

The screens of 24 October 2026 come from timely-you `main` (after
v0.1.0-alpha.17) with commit 5eda161 of the branch `ai/bold-wozniak-xoeue9`
applied, which keeps the week grid's entries inside their day. Recapture from
`main` once that fix is merged.

Recapture after a release that changes these screens (PowerShell):

```powershell
# in a timely-you checkout
npm ci
npx vite --port 5199 --strictPort
# in a second window, in a folder with Playwright installed
node capture.mjs dark;  node capture.mjs light
node capture.mjs dark phone;  node capture.mjs light phone
```

Then convert each PNG to WebP at 1440 x 900 (phone: 780 wide) and copy them
here, named `<screen>-<scheme>.webp`. The build shows the file that matches
the page's scheme (`shotHtml` in `scripts/build.mjs`).

Playwright is not a dependency of this repository (non-negotiable 9); the
script runs where it is installed.

## capture.mjs

```js
// Fills the app's in-browser demo backend with a believable week for a
// fictional person, then captures screens. Not product code.
import { chromium } from "playwright";
const out = process.env.SHOTS_OUT ?? ".";
const scheme = process.argv[2] ?? "dark";
const phone = process.argv[3] === "phone";
const b = await chromium.launch();
const c = await b.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone, colorScheme: scheme, locale: "en-GB", timezoneId: "Europe/Zurich", deviceScaleFactor: 2 });
const p = await c.newPage();
await p.goto("http://localhost:5199/"); await p.waitForTimeout(1500);
await p.evaluate(() => {
  const key = "timely-you-mock";
  const s = JSON.parse(localStorage.getItem(key));
  const ts = new Date().toISOString();
  s.users[0].name = "Alex Meier";
  const P = (id, name, color, billable) => ({ ...s.projects[0], id, name, color, billableDefault: billable, customer: null });
  s.projects = [
    P(2, "Contoso rollout", "#B03F10", true), P(3, "Internal", "#7A7574", false), P(4, "Private", "#13A10E", false),
    s.projects.find((x) => x.projectType === "public_holiday"), s.projects.find((x) => x.projectType === "vacation"),
    P(20, "Fabrikam website", "#7D1290", true),
  ];
  s.projects[2].projectType = "private";
  const A = (id, projectId, name, wbs) => ({ id, projectId, name, billableOverride: null, standardText: null, isActive: true, parentActivityId: null, seq: id * 10, wbsCode: wbs, createdAt: ts, updatedAt: ts });
  s.activities = [A(7, 2, "Consulting", "1"), A(8, 2, "Meetings", "2"), A(21, 2, "Data migration", "3"), A(9, 3, "Administration", "1"), A(22, 20, "Design", "1"), A(23, 20, "Development", "2")];
  const proj = Object.fromEntries(s.projects.map((x) => [x.id, x.name])), act = Object.fromEntries(s.activities.map((x) => [x.id, x.name]));
  const plan = [
    [[8, 0, 9, 30, 2, 8, "Steering committee"], [9, 45, 12, 0, 2, 7, "Process workshop: order to cash"], [13, 0, 15, 30, 20, 22, "Landing page layout"], [15, 45, 17, 15, 3, 9, "Expense reports"]],
    [[8, 15, 12, 0, 2, 21, "Customer master data import"], [13, 0, 16, 45, 20, 23, "Contact form and newsletter"]],
    [[8, 0, 10, 0, 2, 8, "Weekly status call"], [10, 15, 12, 15, 2, 7, "Pricing rules review"], [13, 15, 17, 0, 2, 21, "Open items migration test"]],
    [[8, 30, 12, 0, 20, 22, "Design review with marketing"], [13, 0, 14, 0, 3, 9, ""], [14, 15, 17, 30, 20, 23, "Accessibility fixes"]],
    [[8, 0, 11, 30, 2, 7, "User training, finance team"], [12, 30, 15, 0, 2, 21, "Cut-over rehearsal"]],
  ];
  const monday = new Date(); monday.setHours(12, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  let id = 500; const entries = [];
  const days = [];
  for (let back = 3; back >= 1; back--) for (let i = 0; i < 5; i++) { const d = new Date(monday); d.setDate(monday.getDate() - back * 7 + i); if (d.getMonth() === monday.getMonth()) days.push([d, plan[(i + back) % 5], true]); }
  for (let i = 0; i < 5; i++) { const d = new Date(monday); d.setDate(monday.getDate() + i); days.push([d, plan[i], false]); }
  days.forEach(([d, day, past], n) => {
    const i = past ? 0 : (d.getDay() + 6) % 7;
    const date = d.toISOString().slice(0, 10);
    for (const [h1, m1, h2, m2, pr, ac, text] of day) {
      const start = new Date(`${date}T${String(h1).padStart(2, "0")}:${String(m1).padStart(2, "0")}:00+02:00`);
      const end = new Date(`${date}T${String(h2).padStart(2, "0")}:${String(m2).padStart(2, "0")}:00+02:00`);
      entries.push({ id: id++, userId: 1, userName: "Alex Meier", entryDate: date, startUtc: start.toISOString(), endUtc: end.toISOString(),
        durationMinutes: (end - start) / 60000, timezone: "Europe/Zurich", projectId: pr, projectName: proj[pr], activityId: ac, activityName: act[ac],
        description: text, internalComment: null, entryType: "actual", plannedEntryId: null, status: past || i < 3 ? "approved" : "draft",
        complianceStatus: text || past ? "compliant" : "description_missing", workLocation: i === 1 ? "Home office" : "Office Zürich", placeId: i === 1 ? 30 : 31,
        source: "manual", sourceRef: null, deletedAt: null, createdAt: ts, updatedAt: ts });
    }
  });
  s.timeEntries = entries;
  s.settings.onboardingDone = "1";
  // The TIMEperative brand: orange accent (acustique brands/timely-you, brand-orange).
  s.settings.accentMode = "custom";
  s.settings.accentColor = "#F6672A";
  // The demo day's window titles name a real repository; keep the example neutral.
  s.activitySessions = JSON.parse(JSON.stringify(s.activitySessions).replace(/acunomic/gi, "contoso"));
  localStorage.setItem(key, JSON.stringify(s));
});
await p.reload(); await p.waitForTimeout(1500);
const skip = p.getByRole("button", { name: "Skip" });
if (await skip.count()) { await skip.first().click(); await p.waitForTimeout(500); }
async function nav(label) { await p.keyboard.press("Escape"); await p.locator("nav").getByText(label, { exact: true }).first().click(); await p.waitForTimeout(700); await p.keyboard.press("Escape"); }
async function to8() { await p.evaluate(() => { const l = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent.trim() === "07:00"); l?.scrollIntoView({ block: "start" }); }); }
async function shot(name) { await p.evaluate(() => document.activeElement?.blur()); await p.mouse.move(5, 895); await p.waitForTimeout(900); await p.screenshot({ path: `${out}/${name}-${scheme}${phone ? "-phone" : ""}.png` }); }
if (phone) { await p.keyboard.press("Escape"); await shot("phone-home"); await b.close(); process.exit(0); }
await p.getByRole("tab", { name: "Week" }).first().click().catch(async () => { await p.getByText("Week", { exact: true }).first().click(); });
await to8(); await shot("week");
await p.getByText("Calendar", { exact: true }).first().click(); await shot("calendar");
await p.getByText("List", { exact: true }).first().click(); await shot("list");
await nav("Tracking"); await shot("tracking");
await nav("Planning"); await to8(); await shot("planning");
await nav("Reports"); await shot("reports");
await nav("Billing"); await shot("billing");
await b.close();
```
