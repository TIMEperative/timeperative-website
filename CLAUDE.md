# CLAUDE.md: timeperative.com

The TIMEperative website: a static site in this repository, served by
Cloudflare Workers. Read [README.md](README.md) first.

## Non-negotiables

1. **Pages live in the repository.** `src/pages/en/**` and `src/pages/de/**`
   hold the same paths; the build fails when a language misses a page.
   English is the source; German is Swiss German with Du (COPY-003, COPY-012).
2. **News comes from Notion.** Rows of "TIMEperative website content" with
   Status Publish and Kind News or Release become `/news/<slug>/`
   (`scripts/notion-news.mjs`). Never commit what the script writes
   (`content/news/notion/`, `content/news/media/`).
3. **Keep the navigation simple:** Home, Download, Resources, Support; the
   privacy policy and the imprint in the footer (owner, 2026-10-18).
4. **The download links are the Worker's** (`/download/windows`,
   `/download/android`): they follow the stores' update manifests, so a
   release needs no new build. `src/site.json` names the stores and the
   Worker routes; `wrangler.jsonc` `run_worker_first` lists the same routes.
5. **Only what the app does today.** The privacy policy and the features
   page describe shipped behaviour, checked against the app's code and docs
   (youserpath/timely-you `docs/PRIVACY.md`); a change in the app that
   changes what leaves the device changes the privacy policy too.
6. **Node built-ins only** for the build and the scripts; Wrangler is the
   one devDependency.

## Commands

```bash
npm ci
npm test                 # the build's checks and the Worker
npm run build            # dist/; --offline skips reading the stores
npm run news             # needs NOTION_TOKEN
npx wrangler dev         # the built site and the Worker on http://localhost:8787
```

## Design system: acustique

Everything a user sees or reads in this product follows **acustique**
(`Acunomic/acustique`): brand, host styles, colours, tokens, fonts, icons,
layout and wording. Before changing any of it, load acustique's skill
(`.claude/skills/acustique/SKILL.md`) and the rule that applies
(`references/rules.md`; full text in acustique `docs/RULES.md`). Use token
names, never literal colours.

Before you finish, run the product check and fix what you introduced:

```bash
node <acustique>/checks/run.mjs --root .     # reads .acustique.json
```

Findings marked `new` are yours. Never edit `.acustique-baseline.json` by
hand, and never work around a check here: if a check is wrong, fix it in
acustique. Rules, tokens and vendor values (Odoo, Oracle, Microsoft) change
in acustique first; `used_by` in its `suppliers/*/sources.json` lists the
files here that use them.

`src/static/assets/tokens.css` is a byte copy of acustique
`dist/timely-you/tokens.css`; copy it again after acustique changes a token.
