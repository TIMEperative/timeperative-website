// The email domain registry at run time, shared by the Worker (src/worker.js)
// and the builder (scripts/email-domains.mjs).
//
// data/email-domains.json is the published registry: an array of
// { domain, type, sources, confidence }, generated from the feeds and our
// overrides (data/README.md). The Worker does not bundle that file: the
// builder also writes src/email-domains.generated.js, the same domains
// grouped by type and confidence, one string per group, so a lookup is a
// search in a string and the Worker's start does no work for it.
//
// Matching is exact (owner's specification 2.3): gmail.com never matches
// sub.gmail.com or gmail.com.evil.test. A domain the registry does not list
// is CUSTOM_DOMAIN, which says nothing about who owns it.

export const TYPES = ["WEBMAIL", "ISP_PERSONAL", "ALIAS", "DISPOSABLE", "CUSTOM_DOMAIN", "UNKNOWN"];
export const CONFIDENCES = ["HIGH", "MEDIUM", "LOW"];

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// Characters that end or change a host in a URL: such input is not a domain.
const NOT_IN_A_DOMAIN = /[\s@/\\?#:%[\]<>"'`^{}|,;=+*!$&()~]/u;

/** IDNA to ASCII through the URL parser (UTS 46, as node:url domainToASCII); "" when it fails. */
export function urlToASCII(value) {
  try {
    return new URL(`http://${value}/`).hostname;
  } catch {
    return "";
  }
}

/**
 * A domain in its canonical form (lowercase ASCII, IDNA, no trailing dot),
 * or null when it is not a plausible mail domain. The builder passes
 * node:url domainToASCII; the Worker, which runs without Node's modules,
 * the URL parser, which does the same.
 */
export function canonicalDomain(input, toASCII = urlToASCII) {
  const value = String(input ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!value || NOT_IN_A_DOMAIN.test(value)) return null;
  const ascii = toASCII(value);
  if (!ascii || ascii.length > 253 || !ascii.includes(".")) return null;
  const labels = ascii.split(".");
  if (labels.some((label) => label.length > 63 || !LABEL.test(label))) return null;
  // A host whose last label is a number is an IP address, never a mail domain.
  const last = labels.at(-1);
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return null;
  return ascii;
}

const LOCAL = /^[^\s@<>()[\]\\,;:"]{1,64}$/u;

/** The canonical domain of a plausible email address, or null. */
export function emailDomain(address) {
  const email = String(address ?? "");
  const at = email.lastIndexOf("@");
  if (email.length > 254 || at < 1 || !LOCAL.test(email.slice(0, at))) return null;
  return canonicalDomain(email.slice(at + 1));
}

/** The key of a group in src/email-domains.generated.js. */
export const groupKey = (type, confidence) => `${type} ${confidence}`;

/** The groups of the runtime module: "\nexample.com\nexample.org\n" per type and confidence. */
export function groupRows(rows) {
  const groups = {};
  for (const row of rows) {
    const key = groupKey(row.type, row.confidence);
    (groups[key] ??= []).push(row.domain);
  }
  return Object.fromEntries(Object.keys(groups).sort().map((key) => [key, `\n${groups[key].join("\n")}\n`]));
}

/**
 * The type and confidence of a domain: from the registry's groups when it is
 * listed, CUSTOM_DOMAIN when it is not, UNKNOWN when it is no domain at all.
 */
export function classifyDomain(domain, groups) {
  const key = canonicalDomain(domain);
  if (!key) return { email_domain_type: "UNKNOWN", confidence: "LOW" };
  const needle = `\n${key}\n`;
  for (const [group, list] of Object.entries(groups)) {
    if (list.includes(needle)) {
      const [type, confidence] = group.split(" ");
      return { email_domain_type: type, confidence };
    }
  }
  return { email_domain_type: "CUSTOM_DOMAIN", confidence: "LOW" };
}
