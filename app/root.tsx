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
import { Toaster } from "~/components/ui/sonner";
import "./app.css";
import type { Route } from "./+types/root";

export { ErrorBoundary } from "~/components/error-boundary";

export const middleware: Route.MiddlewareFunction[] = [
  betterAuthSessionMiddleware,
];

export const loader = async (args: LoaderFunctionArgs) => {
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
  // The pre-paint script owns this imperative class because SSR cannot see the browser's color
  // scheme. A client error recreates the root document tree, at which point React otherwise
  // removes the class and flashes the light palette. In production, teach the hydrated tree
  // about the active class so an error remount preserves it. Development intentionally keeps
  // the conspicuous light error screen as a visual signal that an error escaped.
  const retainedThemeClass =
    import.meta.env.PROD &&
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "dark"
      : undefined;

  return (
    <html lang="en" className={retainedThemeClass} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        {/* `interactive-widget=resizes-content` shrinks the layout viewport when the on-screen
            keyboard opens, so a `dvh`-sized shell keeps its composer above the keyboard instead
            of letting it overlay one. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, interactive-widget=resizes-content"
        />
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
      {/* `dvh`, not `screen`/`vh`: on mobile `100vh` is the LARGE viewport (toolbars retracted),
          so a `100vh` floor under a `h-dvh` app shell makes the document permanently taller than
          the viewport. The page then scrolls the shell's header — and its only back control —
          off the top, and leaves dead space under a pinned composer (issue #265). */}
      <body className="min-h-dvh antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  );
}
