/**
 * Shared marketing chrome — the header and footer used by the home page and the
 * case-study pages so navigation stays consistent. Uses the same `harnesst-*` tokens
 * and Suisse type as the rest of the landing site, so it themes with the toggle.
 */
import { Link, useRouteLoaderData } from "react-router";
import type { loader as rootLoader } from "~/root";
import { ThemeToggle } from "~/components/theme-toggle";
import { Logo } from "~/components/marketing/logo";

/** The public source repository. harnesst is open source; every marketing page links here. */
export const REPO_URL = "https://github.com/asiraky/harnesst";

/**
 * `appOrigin` is the app's absolute origin when the page serves from the marketing host
 * (host split, FOH D11) — session cookies don't cross subdomains, so auth CTAs become plain
 * cross-host anchors and the header always renders its signed-out state there. Empty string
 * (the default, and always the case when MARKETING_HOST is unset) keeps same-origin links.
 */
export function SiteHeader({ appOrigin = "" }: { appOrigin?: string }) {
  // The root loader reads the Better Auth session, so identity is available app-wide.
  // When the visitor is already signed in, offer a Dashboard link instead of Sign in.
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const isSignedIn = !appOrigin && Boolean(rootData?.user);

  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
      <Link to="/" aria-label="harnesst home">
        <Logo />
      </Link>
      <nav className="flex items-center gap-5 text-sm">
        <Link
          to="/case-studies"
          className="hidden underline-offset-4 hover:underline sm:inline"
        >
          Case studies
        </Link>
        <a
          href={REPO_URL}
          className="hidden underline-offset-4 hover:underline sm:inline"
        >
          GitHub
        </a>
        <ThemeToggle />
        <a
          href={`${appOrigin}${isSignedIn ? "/dashboard" : "/login"}`}
          className="rounded-full border border-harnesst-fg px-4 py-1.5 transition hover:bg-harnesst-fg hover:text-harnesst-bg"
        >
          {isSignedIn ? "Dashboard" : "Sign in"}
        </a>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-24 border-t border-harnesst-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12 sm:flex-row sm:items-center sm:justify-between">
        <Link to="/" aria-label="harnesst home">
          <Logo className="h-7" />
        </Link>
        <nav className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm text-harnesst-muted">
          <Link to="/case-studies" className="transition hover:text-harnesst-fg">
            Case studies
          </Link>
          <a href={REPO_URL} className="transition hover:text-harnesst-fg">
            GitHub
          </a>
        </nav>
      </div>
      <div className="mx-auto max-w-6xl px-6 pb-10 text-xs text-harnesst-faint">
        © {year} harnesst
      </div>
    </footer>
  );
}
