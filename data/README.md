# The email domain registry

Tells a company's own email address from a public mailbox. The Worker uses
it for the request for a converter for SAP (`POST /converter-request`); the
macOS and iOS waitlist takes any address. It follows the owner's
specification "Email Domain Intelligence & Secure Corporate Signup" 1.0
(2026-10-23), sections 2 to 4. The registry is a list of domains, never of
people, and it never reaches the browser: it is not part of `dist/`, and the
form only ever learns "please use your work address".

## The files

| File | Who writes it | What it is |
|---|---|---|
| `email-domains-overrides.json` | you, by hand | Reviewed classifications that win over every feed |
| `email-domains-exclusions.json` | you, by hand | Reviewed false positives: domains the feeds list that the registry must not |
| `email-domains.json` | the builder | The registry: `{ domain, type, sources, confidence }` per domain, sorted by domain |
| `email-domains-manifest.json` | the builder | Version, build time, the feeds' hashes, counts and licences |
| `../src/email-domains.generated.js` | the builder | The Worker's copy: the same domains grouped by type and confidence |
| `*.schema.json` | rarely changes | JSON Schema of the three lists; Visual Studio Code checks the lists as you type (`.vscode/settings.json`) |

The types are the specification's six: `WEBMAIL` (a public mailbox,
Proton and Tuta included), `ISP_PERSONAL` (an internet provider's consumer
mailbox), `ALIAS` (forwarding and masking), `DISPOSABLE` (throwaway),
`CUSTOM_DOMAIN` and `UNKNOWN`. The registry stores only the first four; a
domain it does not list is `CUSTOM_DOMAIN` at run time, which says only that
no list knows it, never that a company owns it. `confidence` is how sure the
classification is (`HIGH`, `MEDIUM`, `LOW`), not how likely fraud is.

## What the converter request does with it

| Type of the address's domain | The request |
|---|---|
| `WEBMAIL`, `ISP_PERSONAL` (any confidence) | refused: "Please use your work email address. If your business has no domain of its own, write to us at support@timeperative.com." |
| `DISPOSABLE` with `HIGH` (Castle lists it) | refused, same message |
| `DISPOSABLE` with `MEDIUM` (only the community list), `ALIAS` | taken; the lead's description names the type, the confidence and the registry version |
| not listed (`CUSTOM_DOMAIN`) | taken, the same note in the lead |

Matching is exact, after IDNA: `gmail.com` never matches `sub.gmail.com`
or `gmail.com.evil.test`. List a subdomain on its own when it needs a type.

## Correcting a classification

Edit the list in Visual Studio Code, keep one object per line, sorted by
domain, then rebuild and test (PowerShell, in the repository's folder):

```powershell
npm run email-domains     # fetches the feeds, applies your lists, runs the gates
npm test
```

- **A domain should have another type** (a Swiss provider's consumer
  mailbox, say): add it to `email-domains-overrides.json`:

  ```json
  { "domain": "example.ch", "type": "ISP_PERSONAL", "reason": "Consumer mailboxes of Example AG", "reviewed_by": "owner", "reviewed_at": "2026-10-23" },
  ```

  `type` is `WEBMAIL`, `ISP_PERSONAL`, `ALIAS` or `DISPOSABLE`; the override
  gets confidence `HIGH`.
- **A feed lists a domain wrongly** (a company's own domain in the free
  provider list, say): add it to `email-domains-exclusions.json`, with
  `domain`, `reason`, `reviewed_by` and `reviewed_at`. The registry then
  leaves it out, so it is `CUSTOM_DOMAIN`.

Write an international domain in its `xn--` form (`bücher.ch` is
`xn--bcher-kva.ch`); the check says so when one is not. Only public
providers' domains belong here, never a customer's (specification 2.3,
rule 8): this repository is public.

`npm test` fails while the registry does not reflect your lists; running
`npm run email-domains` fixes that. It needs the internet, as it reads the
feeds afresh, so the result may also carry the feeds' changes since the last
refresh.

## The feeds and how they are combined

| Feed id | URL | Gives |
|---|---|---|
| `castle-disposable` | raw.githubusercontent.com/castle/disposable-email-domains/master/disposable-email-domains.txt | `DISPOSABLE`, `HIGH`: Castle's 1,000 most abused throwaway domains, checked by Castle |
| `disposable-community` | disposable.github.io/disposable-email-domains/domains.txt | `DISPOSABLE`, `MEDIUM`: the broad community list |
| `forwarding-combined` | disposable.github.io/disposable-email-domains/domains_forwarding.txt | `ALIAS`, `MEDIUM`: only what it lists beyond the community list |
| `free-email-providers` | www.validemailchecker.com/free-email-provider-domains.txt | `WEBMAIL`, `MEDIUM` |

Precedence, strongest first (specification 3.3): your exclusions, your
overrides, Castle, the community list, forwarding less the community list,
free providers. `sources` names your override (`timeperative-curated`) and
the feeds that agree with the result; a feed that disagrees goes into the
conflicts report instead. Several feeds never raise the confidence: the
community list already includes Castle's. The strict lists of the community
project are never read; they also hold Outlook and Hotmail.

Licences: `THIRD-PARTY-NOTICES.md`.

## The gates

The builder writes to `.email-domains/staging/` and replaces the published
files only when every gate passes. Otherwise it exits with 1 and the
registry stays as it was:

- every feed answered over HTTPS within 60 seconds and its size limit, after
  up to three tries, with at least a plausible number of domains and at
  most 1 % lines that are no domain;
- the three lists match their schemas; every domain is canonical and listed
  once; the registry is sorted;
- the sentinels: gmail.com and proton.me `WEBMAIL`, bluewin.ch
  `ISP_PERSONAL`, duck.com and privaterelay.appleid.com `ALIAS`,
  mailinator.com and yopmail.com `DISPOSABLE` `HIGH`;
- no excluded domain is listed, every override is;
- against the published registry: no feed changes by more than 20 %, and the
  registry shrinks by no more than 10 % (the specification's starting
  guideline). `npm run email-domains -- --allow-large-change` publishes such
  a change after you have looked at it.

Every build writes `.email-domains/source-conflicts.json` (each disagreement
between the feeds, every exclusion applied, and the lines a feed held that
were no domain) and `.email-domains/summary.md`; neither is committed.

## The daily refresh

The workflow `Email domains` (`.github/workflows/email-domains.yml`) builds
every day at 04:41 UTC and, when the registry changed, proposes the change as
a pull request from `email-domains-refresh` into `main`, with the counts, the
reclassified and removed domains and a warning at the top when a large
change was accepted. Merging deploys it like any change. A failed gate fails
the run; GitHub then notifies the repository's watchers. Git keeps every
earlier registry: reverting the refresh's merge commit rolls it back.
