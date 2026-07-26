/**
 * Per-host robots.txt (host split, D11 — replaces the static /public file, whose bytes were
 * identical on every host). Three modes:
 *
 *  - MARKETING_HOST unset (self-host default): the single host serves both surfaces, so keep
 *    the marketing policy — case studies stay crawlable, app paths stay out of the index —
 *    with the sitemap on this host's own origin.
 *  - Marketing host: the marketing policy, sitemap on the marketing origin.
 *  - App host with a marketing host configured: nothing here is indexable (every app page
 *    already carries noindex meta) — disallow everything.
 */
import type { LoaderFunctionArgs } from "react-router";

import {
  isMarketingHost,
  marketingHost,
  marketingOrigin,
} from "~/lib/marketing-host.server";

const APP_DISALLOWS = [
  "/dashboard",
  "/repos/",
  "/t/",
  "/org/",
  "/connect",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/accept-invitation/",
  "/workspaces",
  "/api/",
  "/marketplace",
];

export function loader({ request }: LoaderFunctionArgs) {
  const configured = marketingHost();
  const marketingMode = configured ? isMarketingHost(request) : true;

  const body = marketingMode
    ? [
        "# harnesst — marketing pages are open to all crawlers; the authed app is kept out of the index.",
        "User-agent: *",
        "Allow: /",
        ...APP_DISALLOWS.map((path) => `Disallow: ${path}`),
        "",
        `Sitemap: ${
          configured ? marketingOrigin() : new URL(request.url).origin
        }/sitemap.xml`,
        "",
      ].join("\n")
    : [
        "# harnesst app host — the marketing site lives on its own host; nothing here is indexable.",
        "User-agent: *",
        "Disallow: /",
        "",
      ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
