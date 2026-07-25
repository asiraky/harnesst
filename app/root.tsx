import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  type LoaderFunctionArgs,
} from "react-router";

import {
  betterAuthSessionMiddleware,
  getSessionAuth,
} from "~/auth/session.server";
import { ensureSplitterStarted } from "~/deploy/splitter.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { ensureReconcilerStarted } from "~/observability/reconcile.server";
import "./app.css";
import type { Route } from "./+types/root";

export { ErrorBoundary } from "~/components/error-boundary";

export const middleware: Route.MiddlewareFunction[] = [
  betterAuthSessionMiddleware,
];

export const loader = async (args: LoaderFunctionArgs) => {
  // Boot the background singletons with the first server render (per-process guards).
  ensureWorkerStarted();
  ensureSplitterStarted();
  ensureReconcilerStarted();
  const session = await getSessionAuth(args);
  return { user: session.user };
};

/**
 * Resolve the `.dark` class before first paint (no FOUC). Preference order:
 *   explicit cookie ("light"/"dark") wins; otherwise follow the OS. The OS
 *   listener only steers the theme while in "system" mode. Keep this in sync
 *   with THEME_COOKIE / applyTheme in app/components/theme-toggle.tsx.
 */
const darkModeScript = `
(function () {
  var mql = window.matchMedia("(prefers-color-scheme: dark)");
  var read = function () {
    var m = document.cookie.match(/(?:^|; )harnesst-theme=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "system";
  };
  var apply = function () {
    var pref = read();
    var dark = pref === "dark" || (pref !== "light" && mql.matches);
    document.documentElement.classList.toggle("dark", dark);
  };
  apply();
  mql.addEventListener("change", function () {
    if (read() === "system") apply();
  });
})();
`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Brand icons + PWA manifest. SVG is the primary favicon (crisp at any size);
            the .ico is the legacy fallback for older crawlers/browsers. */}
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon.ico" sizes="48x48" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <meta name="theme-color" content="#4A7DFF" />
        <script dangerouslySetInnerHTML={{ __html: darkModeScript }} />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
