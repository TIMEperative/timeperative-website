# timeperative.com

The website of TIMEperative, the time tracker for Windows and Android by
Acunomic GmbH. It replaces www.timely.you.

- **Pages:** Home (with News and releases), Download, Resources (with
  Features), Support; Privacy policy and Imprint in the footer. English at
  `/`, German at `/de/`.
- **Hosting:** Cloudflare Workers static assets, with a small Worker for the
  download links. Cloudflare recommends Workers over Pages for new sites
  (developers.cloudflare.com/workers/best-practices/workers-best-practices/,
  read 2026-10-18).
- **News:** written in Notion (TIMEperative > TIMEperative.com website >
  TIMEperative website content), built into the site when Status is Publish.
- **Design:** acustique, the TIMEperative brand (`CLAUDE.md`).

## How it fits together

| Path | What it is |
|---|---|
| `src/pages/en/**`, `src/pages/de/**` | The pages, one HTML file each, opening with a comment that holds the meta title, the meta description and the menu entry |
| `src/layout.html`, `src/i18n/*.json` | Header, footer and the strings around the pages |
| `src/static/` | Copied as is: stylesheets, the tokens from acustique, the fonts, the mark |
| `src/site.json` | Languages, menu, the release stores, the Worker routes, the support address |
| `src/worker.js` | `/download/windows` and `/download/android`: a redirect to the newest installer the stores' update manifests name |
| `scripts/build.mjs` | Builds `dist/` and checks every page (one h1, headings in order, meta lengths, alt text, internal links) |
| `scripts/notion-news.mjs` | News and release articles from Notion into `content/news/notion/` |
| `.github/workflows/site.yml` | Build on every push; deploy from `main`, every three hours and on demand |

The download links never need a new build: the Worker reads `latest.json`
and `latest-android.json` from each store in `src/site.json` and sends the
visitor to the newest installer. The stores are TIMEperative/timeperative
(from 1 November 2026) and Acunomic/timeperative (today); whichever has the
newer release wins, so the move needs no change here. After the move, set
`releasePage` in `src/site.json` to the new store's release page.

## Run it on your PC (PowerShell)

Needs Node.js 22 or later.

```powershell
git clone https://github.com/TIMEperative/timeperative-website.git
Set-Location timeperative-website
npm ci
npm test
npm run build
npx wrangler dev        # then open http://localhost:8787
```

`npm run build -- --offline` builds without reading the stores. To pull the
news from Notion as well:

```powershell
$env:NOTION_TOKEN = "<the integration's secret>"
npm run news
npm run build
Remove-Item Env:NOTION_TOKEN
```

## Deploy

Cloudflare Workers Builds deploys the production branch (`main`) on every
push: Cloudflare dashboard, Workers & Pages, timeperative-website, Settings,
Build. `npm ci` builds the site through the `prepare` script, so the default
deploy command `npx wrangler deploy` finds `dist/` whatever the build command
is. Set `NOTION_TOKEN` there as a build variable to include the news.

News set to Publish in Notion needs a new build. The workflow `Site` rebuilds
and deploys every three hours and on demand once the repository has the
secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers"),
`CLOUDFLARE_ACCOUNT_ID` and `NOTION_TOKEN`.

To deploy by hand:

```powershell
npx wrangler login
npm run deploy
```

## Writing a news article

1. In Notion, add a row to TIMEperative website content: Kind News (or
   Release), Title and Title DE, Subtitle and Subtitle DE, Slug (English,
   lowercase, hyphenated), Published.
2. Write the article in English, then a heading 1 "Deutsch", then the
   German. Use heading 2 and 3 inside; every image needs a caption, which
   becomes its alt text.
3. Set Status to Publish. The next build, at most three hours later, puts it
   on the site; run the workflow by hand for it to appear at once. Set
   Status to Withdrawn to take it down again.

A row that breaks a rule (meta title over 60 characters, meta description
over 155, a long dash, the sharp s in German) is left out, and the workflow
log names it and the rule.

## Before a change is done

```powershell
npm test
npm run build
node ..\acustique\checks\run.mjs --root .
```
