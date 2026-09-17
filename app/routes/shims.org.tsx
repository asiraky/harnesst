/**
 * Pre-consolidation workspace settings URLs — 301 into /settings. `/org/settings` and
 * `/org/members` were separate top-level pages; they are tabs of one Settings page now.
 */
import { redirect, type LoaderFunctionArgs } from "react-router";

const TARGETS: Record<string, string> = {
  "/org/settings": "/settings",
  "/org/members": "/settings/members",
};

export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const to = TARGETS[url.pathname] ?? "/settings";
  throw redirect(`${to}${url.search}`, 301);
}
