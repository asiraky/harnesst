/**
 * Central SEO metadata for the public marketing pages. Every crawlable route builds
 * its <title>/description/canonical plus Open Graph + Twitter card tags through
 * `pageMeta`, so social shares and search results stay consistent. React Router does
 * not merge a parent route's `meta` into children, so the shared tags live here and
 * each public route spreads them in.
 */
// Canonical/OG URLs follow the configured marketing host (host split, D11). The env read is
// guarded because meta functions also run in the browser, where `process` does not exist —
// crawlers only ever see the server-rendered document, so the SSR value is the one that
// matters and the client-side fallback to the constant is harmless.
const configuredMarketingHost =
  typeof process !== "undefined"
    ? process.env.MARKETING_HOST?.trim()
    : undefined;
export const SITE_URL = configuredMarketingHost
  ? `https://${configuredMarketingHost}`
  : "https://harnesst.dev";

/** Absolute URL of the social share image (1200×630). Served from /public. */
export const OG_IMAGE = `${SITE_URL}/og.png`;

type MetaDescriptor = Record<string, unknown>;

/**
 * Build the full tag set for a crawlable page. `path` is the site-relative URL
 * (leading slash) used for the canonical + og:url. Pass `noindex` for pages that
 * should render publicly but stay out of the index.
 */
export function pageMeta(opts: {
  title: string;
  description: string;
  path?: string;
  noindex?: boolean;
}): MetaDescriptor[] {
  const { title, description, path = "/", noindex = false } = opts;
  const url = `${SITE_URL}${path}`;
  const tags: MetaDescriptor[] = [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "harnesst" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: OG_IMAGE },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: OG_IMAGE },
  ];
  if (noindex) tags.push({ name: "robots", content: "noindex, nofollow" });
  return tags;
}

/** Robots tag for authed/app pages that must never be indexed. */
export const noindexMeta: MetaDescriptor[] = [
  { name: "robots", content: "noindex, nofollow" },
];
