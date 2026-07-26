import type { Route } from "./+types/case-studies.$slug";
import { Link } from "react-router";
import { sessionLoader } from "~/auth/session.server";
import type { LoaderFunctionArgs } from "react-router";

import { SiteHeader, SiteFooter } from "~/components/marketing/site-chrome";
import { Reveal, Parallax } from "~/components/landing-motion";
import { caseStudies, getCaseStudy } from "~/lib/case-studies";
import {
  appOrigin,
  isMarketingHost,
  marketingHostRedirect,
} from "~/lib/marketing-host.server";
import { pageMeta } from "~/lib/seo";

export async function loader(args: LoaderFunctionArgs) {
  // Host split (D11): marketing-host-only when configured (middleware bounces first; this
  // guard keeps the rule local too).
  const away = marketingHostRedirect(args.request);
  if (away) throw away;
  const study = getCaseStudy(args.params.slug ?? "");
  if (!study) throw new Response("Not found", { status: 404 });
  const session = await sessionLoader(args);
  return {
    ...session,
    // Cross-host auth CTAs (cookies don't cross subdomains); "" = same-origin links.
    appOrigin: isMarketingHost(args.request) ? (appOrigin() ?? "") : "",
  };
}

export function meta({ params }: Route.MetaArgs) {
  const study = getCaseStudy(params.slug ?? "");
  if (!study) return [{ title: "Case study — harnesst" }];
  return pageMeta({
    title: `${study.company} — harnesst case study`,
    description: study.dek,
    path: `/case-studies/${study.slug}`,
  });
}

/**
 * Case-study detail. One vertical per page. Reads from the static case-study
 * module by slug (the loader 404s an unknown slug). Same tokens/motion as the
 * rest of the marketing site.
 */
export default function CaseStudyDetail({
  params,
  loaderData,
}: Route.ComponentProps) {
  const { appOrigin } = loaderData;
  const study = getCaseStudy(params.slug ?? "");
  // The loader guarantees this exists; guard keeps TypeScript happy.
  if (!study) return null;

  const others = caseStudies.filter((c) => c.slug !== study.slug).slice(0, 2);

  return (
    <main className="min-h-screen bg-harnesst-bg font-suisse text-harnesst-fg">
      <SiteHeader appOrigin={appOrigin} />

      {/* ————— Hero ————— */}
      <section className="mx-auto max-w-4xl px-6 pb-12 pt-12 sm:pt-20">
        <Reveal
          as="p"
          className="text-sm uppercase tracking-[0.25em] text-harnesst-faint"
        >
          <Link to="/case-studies" className="hover:underline">
            Case studies
          </Link>{" "}
          · {study.industry}
        </Reveal>
        <Reveal
          as="h1"
          delay={90}
          className="mt-6 text-4xl font-medium leading-[1.08] tracking-[-0.02em] sm:text-6xl"
        >
          {study.headline}
        </Reveal>
        <Reveal
          as="p"
          delay={180}
          className="mt-8 max-w-2xl text-xl leading-relaxed text-harnesst-muted"
        >
          {study.dek}
        </Reveal>
      </section>

      {/* ————— Hero image + highlight ————— */}
      <section className="mx-auto max-w-6xl px-6">
        <Reveal className="overflow-hidden rounded-2xl border border-harnesst-line">
          <Parallax speed={0.08}>
            <img
              src={study.image}
              alt={study.imageAlt}
              className="marketing-photo aspect-[16/9] w-full object-cover"
            />
          </Parallax>
        </Reveal>
        <Reveal delay={120} className="mt-6 flex items-baseline gap-4">
          <span className="text-4xl font-medium tracking-[-0.02em] sm:text-5xl">
            {study.highlight.value}
          </span>
          <span className="text-harnesst-faint">{study.highlight.label}</span>
        </Reveal>
      </section>

      {/* ————— The challenge ————— */}
      <section className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
        <div className="grid gap-10 sm:grid-cols-[auto_1fr] sm:gap-20">
          <Reveal
            as="span"
            className="text-sm uppercase tracking-[0.25em] text-harnesst-faint"
          >
            The challenge
          </Reveal>
          <Reveal delay={100} className="max-w-2xl space-y-4">
            {study.challenge.map((p, i) => (
              <p key={i} className="text-lg leading-relaxed text-harnesst-muted">
                {p}
              </p>
            ))}
          </Reveal>
        </div>
      </section>

      {/* ————— What they built (inverted band) ————— */}
      <section className="overflow-hidden bg-harnesst-band-bg text-harnesst-band-fg">
        <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
          <Reveal
            as="span"
            className="text-sm uppercase tracking-[0.25em] text-harnesst-band-muted"
          >
            What they built
          </Reveal>
          <div className="mt-10 grid gap-12 lg:grid-cols-2 lg:gap-16">
            <Reveal className="max-w-xl space-y-4">
              {study.approach.map((p, i) => (
                <p
                  key={i}
                  className="text-lg leading-relaxed text-harnesst-band-muted"
                >
                  {p}
                </p>
              ))}
            </Reveal>
            <Reveal delay={120}>
              <Parallax speed={0.1}>
                <div className="rounded-lg border border-harnesst-panel-line bg-harnesst-panel-bg p-6">
                  <p className="font-mono text-xs uppercase tracking-[0.2em] text-harnesst-band-muted">
                    Agents they stood up
                  </p>
                  <ul className="mt-5 space-y-4">
                    {study.agents.map((a) => (
                      <li key={a.name} className="font-mono text-sm">
                        <span className="text-harnesst-band-fg">{a.name}</span>
                        <span className="text-harnesst-band-muted">
                          {"  "}— {a.does}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Parallax>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ————— The result ————— */}
      <section className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
        <Reveal
          as="span"
          className="text-sm uppercase tracking-[0.25em] text-harnesst-faint"
        >
          The result
        </Reveal>
        <div className="mt-10 grid gap-12 lg:grid-cols-[1fr_auto] lg:gap-20">
          <Reveal className="max-w-2xl space-y-4">
            {study.result.map((p, i) => (
              <p key={i} className="text-lg leading-relaxed text-harnesst-muted">
                {p}
              </p>
            ))}
          </Reveal>
          <Reveal
            delay={120}
            className="grid gap-8 sm:grid-cols-3 lg:grid-cols-1"
          >
            {study.stats.map((s) => (
              <div key={s.label} className="border-t border-harnesst-line pt-4">
                <p className="text-3xl font-medium tracking-[-0.01em]">
                  {s.value}
                </p>
                <p className="mt-2 text-sm leading-snug text-harnesst-faint">
                  {s.label}
                </p>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      <hr className="mx-auto max-w-6xl border-harnesst-line" />

      {/* ————— Pull quote ————— */}
      <section className="mx-auto max-w-4xl px-6 py-20 sm:py-24">
        <Reveal as="blockquote" className="text-center">
          <p className="text-3xl font-medium italic leading-snug tracking-[-0.01em] sm:text-4xl">
            &ldquo;{study.quote.text}&rdquo;
          </p>
          <p className="mt-8 text-sm uppercase tracking-[0.25em] text-harnesst-faint">
            {study.quote.name} · {study.quote.role}
          </p>
        </Reveal>
      </section>

      {/* ————— More stories ————— */}
      <section className="mx-auto max-w-6xl px-6 pb-8">
        <Reveal
          as="span"
          className="text-sm uppercase tracking-[0.25em] text-harnesst-faint"
        >
          More stories
        </Reveal>
        <div className="mt-8 grid gap-8 sm:grid-cols-2">
          {others.map((cs) => (
            <Reveal key={cs.slug}>
              <Link
                to={`/case-studies/${cs.slug}`}
                className="group grid grid-cols-[6rem_1fr] items-center gap-5"
              >
                <div className="overflow-hidden rounded-lg border border-harnesst-line">
                  <img
                    src={cs.image}
                    alt={cs.imageAlt}
                    loading="lazy"
                    className="marketing-photo aspect-square w-full object-cover transition duration-700 group-hover:scale-[1.05]"
                  />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-harnesst-faint">
                    {cs.industry}
                  </p>
                  <p className="mt-1 font-medium leading-snug group-hover:opacity-70">
                    {cs.headline}
                  </p>
                </div>
              </Link>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ————— CTA band ————— */}
      <section className="mt-8 bg-harnesst-band-bg text-harnesst-band-fg">
        <div className="mx-auto max-w-6xl px-6 py-20 text-center sm:py-24">
          <Reveal
            as="h2"
            className="mx-auto max-w-3xl text-4xl font-medium leading-tight tracking-[-0.02em] sm:text-5xl"
          >
            Build your first agent
            <span className="italic"> before the meeting ends.</span>
          </Reveal>
          <Reveal delay={120} className="mt-10">
            <a
              href={`${appOrigin}/signup`}
              className="rounded-full bg-harnesst-band-fg px-8 py-3 text-lg font-medium text-harnesst-band-bg transition hover:opacity-85"
            >
              Sign up
            </a>
          </Reveal>
        </div>
      </section>

      {/* photo credit — not required by the Unsplash license, but fair. */}
      <p className="mx-auto max-w-6xl px-6 pt-8 text-xs text-harnesst-faint">
        Photograph by{" "}
        <a
          href={study.creditUrl}
          className="underline-offset-2 hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          {study.credit}
        </a>{" "}
        on Unsplash.
      </p>

      <SiteFooter />
    </main>
  );
}
