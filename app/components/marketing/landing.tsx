/**
 * Editorial landing page, extracted from the old `routes/home.tsx` when Front of House took
 * over `/` (FOH PRD §2.6). Rendered by the FOH index route on the configured marketing host
 * — self-hosts without MARKETING_HOST never see it. Swiss/grotesque type (Suisse Intl),
 * cream-paper light theme and warm-charcoal dark theme — both driven by the `harnesst-*` color
 * tokens in app.css, so the whole page follows the ThemeToggle (defaults to system). Motion
 * (scroll-reveal + parallax) comes from ~/components/landing-motion and is disabled for
 * prefers-reduced-motion.
 *
 * `appOrigin` is the app's absolute origin when serving cross-host (cookies do not cross
 * subdomains, so auth CTAs are plain full-navigation anchors); empty string means same-host.
 */
import { Link } from "react-router";

import { Reveal, Parallax } from "~/components/landing-motion";
import { SiteHeader, SiteFooter } from "~/components/marketing/site-chrome";
import { ProductMockup } from "~/components/marketing/product-mockup";
import { caseStudies } from "~/lib/case-studies";

export function MarketingLanding({ appOrigin = "" }: { appOrigin?: string }) {
  return (
    <main className="min-h-screen bg-harnesst-bg font-suisse text-harnesst-fg">
      <SiteHeader appOrigin={appOrigin} />

      {/* ————— Hero ————— */}
      <section className="mx-auto max-w-6xl px-6 pb-20 pt-20">
        <Parallax speed={0.1}>
          <Reveal
            as="p"
            className="text-sm uppercase tracking-[0.25em] text-harnesst-faint"
          >
            Built on Vercel&rsquo;s eve
          </Reveal>
          <Reveal
            as="h1"
            delay={90}
            className="mt-6 text-6xl font-medium leading-[1.02] tracking-[-0.02em] sm:text-8xl"
          >
            You know how the work gets done.
            <span className="italic"> Build the agents that do it.</span>
          </Reveal>
          <Reveal
            delay={180}
            className="mt-12 grid gap-10 sm:grid-cols-[1fr_auto] sm:items-end"
          >
            <p className="max-w-xl text-lg leading-relaxed text-harnesst-muted">
              Pick something your team does over and over — triaging tickets,
              chasing invoices, prepping the weekly report. Describe how it
              should work in plain words, and harnesst builds an agent that runs
              it. Stack a few together and you&rsquo;ve got a small team working
              while you do something else.
            </p>
            <a
              href={`${appOrigin}/signup`}
              className="inline-flex items-center gap-2 text-lg font-medium underline underline-offset-8 hover:opacity-70"
            >
              Begin →
            </a>
          </Reveal>
        </Parallax>
      </section>

      {/* ————— Product shot ————— */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <Reveal>
          <Parallax speed={0.05}>
            <ProductMockup />
          </Parallax>
        </Reveal>
        <Reveal as="p" delay={120} className="mt-5 text-sm text-harnesst-faint">
          Describe the job in plain words. The assistant writes the code and
          opens it for your review.
        </Reveal>
      </section>

      <hr className="mx-auto max-w-6xl border-harnesst-line" />

      {/* ————— The problem ————— */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="grid gap-12 sm:grid-cols-[auto_1fr] sm:gap-20">
          <Reveal
            as="span"
            className="text-sm uppercase tracking-[0.25em] text-harnesst-faint"
          >
            The problem
          </Reveal>
          <Reveal delay={100} className="max-w-2xl">
            <h2 className="text-4xl font-medium leading-tight tracking-[-0.01em] sm:text-5xl">
              The best ideas sit in a queue.
            </h2>
            <p className="mt-6 text-lg leading-relaxed text-harnesst-muted">
              You can see exactly where an agent would save your team hours
              every week. But making it real means writing a spec, handing it to
              engineering, and waiting for a slot that might never open. By the
              time it ships, the process has already moved on.
            </p>
            <p className="mt-4 text-lg leading-relaxed text-harnesst-muted">
              harnesst takes out the hand-off. The person who actually knows the
              work builds the agent, and changes it the moment the work changes.
            </p>
          </Reveal>
        </div>
      </section>

      <hr className="mx-auto max-w-6xl border-harnesst-line" />

      {/* ————— How it works ————— */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <Reveal
          as="span"
          className="text-sm uppercase tracking-[0.25em] text-harnesst-faint"
        >
          How it works
        </Reveal>
        <ol className="mt-12 grid gap-12 sm:grid-cols-3">
          {[
            {
              n: "01",
              title: "Describe",
              blurb:
                "Tell harnesst what the job is, in plain words — the steps, the rules, the exceptions. Its assistant turns that into a working agent while you watch.",
            },
            {
              n: "02",
              title: "Check",
              blurb:
                "See exactly what the agent will do before it does anything. Approve it, tweak it, or ask for a change. Nothing goes live behind your back.",
            },
            {
              n: "03",
              title: "Put it to work",
              blurb:
                "Sign off, and the agent starts — in Slack, over email, on your site, or on a schedule you set. Change your mind tomorrow and update it in minutes.",
            },
          ].map((s, i) => (
            <Reveal as="li" key={s.n} delay={i * 110}>
              <Parallax
                as="span"
                speed={0.06 + i * 0.06}
                className="inline-block text-3xl italic text-harnesst-numeral"
              >
                {s.n}
              </Parallax>
              <h3 className="mt-3 text-xl font-medium">{s.title}</h3>
              <p className="mt-3 leading-relaxed text-harnesst-muted">{s.blurb}</p>
            </Reveal>
          ))}
        </ol>
      </section>

      {/* ————— Anatomy (inverted band) ————— */}
      <section className="overflow-hidden bg-harnesst-band-bg text-harnesst-band-fg">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <Reveal
            as="span"
            className="text-sm uppercase tracking-[0.25em] text-harnesst-band-muted"
          >
            What&rsquo;s inside an agent
          </Reveal>
          <div className="mt-12 grid gap-12 lg:grid-cols-2 lg:items-center">
            <Reveal>
              <h2 className="text-4xl font-medium leading-tight tracking-[-0.01em] sm:text-5xl">
                No black box.
                <span className="italic"> Just a few plain parts.</span>
              </h2>
              <p className="mt-6 max-w-lg text-lg leading-relaxed text-harnesst-band-muted">
                An agent is made of pieces you can open and understand: what it
                does, the actions it can take, when it runs, and where it shows
                up. Change any of them yourself. When something needs real code,
                the assistant writes it for you.
              </p>
            </Reveal>
            <Reveal delay={120}>
              <Parallax speed={0.12}>
                <div className="rounded-lg border border-harnesst-panel-line bg-harnesst-panel-bg p-6 font-mono text-sm leading-loose">
                  <p className="text-harnesst-band-muted"># support-agent/</p>
                  <p>
                    ├── instructions.md{"  "}
                    <span className="text-harnesst-band-muted">
                      — what it should do
                    </span>
                  </p>
                  <p>
                    ├── tools/refund.ts{"  "}
                    <span className="text-harnesst-band-muted">
                      — an action it can take
                    </span>
                  </p>
                  <p>
                    ├── skills/triage/{"  "}
                    <span className="text-harnesst-band-muted">
                      — know-how it reuses
                    </span>
                  </p>
                  <p>
                    ├── schedules/daily.ts{"  "}
                    <span className="text-harnesst-band-muted">
                      — runs every morning
                    </span>
                  </p>
                  <p>
                    └── channels/slack.ts{"  "}
                    <span className="text-harnesst-band-muted">
                      — where it works
                    </span>
                  </p>
                </div>
              </Parallax>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ————— What you get ————— */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <Reveal
          as="span"
          className="text-sm uppercase tracking-[0.25em] text-harnesst-faint"
        >
          What you get
        </Reveal>
        <div className="mt-12 grid gap-x-16 gap-y-14 sm:grid-cols-2">
          {[
            {
              title: "Change it yourself",
              blurb:
                "Adjust how an agent behaves without opening a ticket. The person closest to the work makes the call and ships it the same day.",
            },
            {
              title: "Nothing goes live by surprise",
              blurb:
                "Every change waits for your sign-off, and the agent stops for you on anything that matters. No unexpected refunds, no rogue emails.",
            },
            {
              title: "It keeps its place",
              blurb:
                "Agents don't lose track when something crashes or a task takes hours. They pick up where they left off and finish the job.",
            },
            {
              title: "Wherever your team works",
              blurb:
                "One agent answers in Slack, replies to email, chats on your site, and wakes up on a schedule. Build it once, use it everywhere.",
            },
            {
              title: "It writes the hard parts",
              blurb:
                'Ask for what you want — "look up the order and refund it" — and the built-in assistant handles the technical side for you.',
            },
            {
              title: "Yours to keep",
              blurb:
                "harnesst is open source and free to run on your own servers, or let us host it. Every version is saved, so you can roll back or walk away anytime.",
            },
          ].map((f, i) => (
            <Reveal
              key={f.title}
              delay={(i % 2) * 90}
              className="border-t border-harnesst-line pt-6"
            >
              <h3 className="text-xl font-medium">{f.title}</h3>
              <p className="mt-3 leading-relaxed text-harnesst-muted">{f.blurb}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <hr className="mx-auto max-w-6xl border-harnesst-line" />

      {/* ————— Pull quote ————— */}
      <section className="mx-auto max-w-6xl overflow-hidden px-6 py-24">
        <Parallax speed={0.08}>
          <Reveal as="blockquote" className="mx-auto max-w-4xl text-center">
            <p className="text-4xl font-medium italic leading-snug tracking-[-0.01em] sm:text-5xl">
              &ldquo;The best person to build the support agent is the one
              who&rsquo;s already answered a thousand support tickets.&rdquo;
            </p>
            <p className="mt-8 text-sm uppercase tracking-[0.25em] text-harnesst-faint">
              The idea behind harnesst
            </p>
          </Reveal>
        </Parallax>
      </section>

      <hr className="mx-auto max-w-6xl border-harnesst-line" />

      {/* ————— Who it's for ————— */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <Reveal
          as="span"
          className="text-sm uppercase tracking-[0.25em] text-harnesst-faint"
        >
          Who it&rsquo;s for
        </Reveal>
        <div className="mt-12 grid gap-12 sm:grid-cols-3">
          {[
            {
              title: "Product & ops",
              blurb:
                "Turn the process you run every week into an agent that runs it for you. Change how it works the same afternoon you think of it.",
            },
            {
              title: "Support teams",
              blurb:
                "Hand the playbook you know by heart to an agent that follows it exactly, and checks in with you on the calls that actually matter.",
            },
            {
              title: "Engineers",
              blurb:
                "Let the team build the first draft themselves. Spend your time reviewing the work instead of turning specs into boilerplate.",
            },
          ].map((p, i) => (
            <Reveal key={p.title} delay={i * 110}>
              <h3 className="text-2xl italic">{p.title}</h3>
              <p className="mt-4 leading-relaxed text-harnesst-muted">{p.blurb}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <hr className="mx-auto max-w-6xl border-harnesst-line" />

      {/* ————— In the wild (case studies teaser) ————— */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <Reveal
            as="span"
            className="text-sm uppercase tracking-[0.25em] text-harnesst-faint"
          >
            In the wild
          </Reveal>
          <Reveal delay={60}>
            <Link
              to="/case-studies"
              className="text-sm font-medium underline underline-offset-8 hover:opacity-70"
            >
              All case studies →
            </Link>
          </Reveal>
        </div>
        <Reveal
          as="h2"
          delay={90}
          className="mt-8 max-w-3xl text-4xl font-medium leading-tight tracking-[-0.01em] sm:text-5xl"
        >
          Same teams.
          <span className="italic"> Far more done.</span>
        </Reveal>
        <div className="mt-12 grid gap-8 sm:grid-cols-3">
          {caseStudies.slice(0, 3).map((cs, i) => (
            <Reveal key={cs.slug} delay={i * 100}>
              <Link to={`/case-studies/${cs.slug}`} className="group block">
                <div className="overflow-hidden rounded-xl border border-harnesst-line">
                  <img
                    src={cs.image}
                    alt={cs.imageAlt}
                    loading="lazy"
                    className="marketing-photo aspect-[4/3] w-full object-cover transition duration-700 group-hover:scale-[1.04]"
                  />
                </div>
                <p className="mt-4 text-xs uppercase tracking-[0.2em] text-harnesst-faint">
                  {cs.industry}
                </p>
                <p className="mt-2 text-lg font-medium leading-snug group-hover:opacity-70">
                  {cs.headline}
                </p>
                <p className="mt-3 flex items-baseline gap-2 text-sm text-harnesst-muted">
                  <span className="font-medium text-harnesst-fg">
                    {cs.highlight.value}
                  </span>
                  {cs.highlight.label}
                </p>
              </Link>
            </Reveal>
          ))}
        </div>
      </section>

      <hr className="mx-auto max-w-6xl border-harnesst-line" />

      {/* ————— Open source / self-host ————— */}
      <section className="mx-auto max-w-6xl overflow-hidden px-6 py-20">
        <Reveal
          as="span"
          className="text-sm uppercase tracking-[0.25em] text-harnesst-faint"
        >
          Open source
        </Reveal>
        <div className="mt-12 grid gap-12 lg:grid-cols-2 lg:items-center">
          <Reveal>
            <h2 className="text-4xl font-medium leading-tight tracking-[-0.01em] sm:text-5xl">
              Run it on your own hardware.
              <span className="italic"> Own the whole thing.</span>
            </h2>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-harnesst-muted">
              harnesst is open source. Clone the repo, run it on your own
              servers, and keep your agents and your data on machines you
              control. There&rsquo;s no vendor holding the keys — read every
              line, change what you want, and never worry about being locked in
              or shut off.
            </p>
            <p className="mt-4 max-w-lg text-lg leading-relaxed text-harnesst-muted">
              Don&rsquo;t want to run it yourself? We&rsquo;ll host it for you.
              Same software either way.
            </p>
            <a
              href="https://github.com/asiraky/harnesst"
              className="mt-8 inline-flex items-center gap-2 text-lg font-medium underline underline-offset-8 hover:opacity-70"
            >
              View the source on GitHub →
            </a>
          </Reveal>
          <Reveal delay={120}>
            <Parallax speed={0.1}>
              <div className="rounded-lg border border-harnesst-panel-line bg-harnesst-panel-bg p-6 font-mono text-sm leading-loose text-harnesst-band-fg">
                <p className="text-harnesst-band-muted">
                  # your server, your rules
                </p>
                <p>
                  <span className="text-harnesst-band-muted">$ </span>
                  git clone github.com/asiraky/harnesst
                </p>
                <p>
                  <span className="text-harnesst-band-muted">$ </span>
                  npm install
                </p>
                <p>
                  <span className="text-harnesst-band-muted">$ </span>
                  npm run start
                </p>
                <p className="text-harnesst-band-muted">
                  → running at localhost, on your box
                </p>
              </div>
            </Parallax>
          </Reveal>
        </div>
      </section>

      {/* ————— Final CTA ————— */}
      <section className="bg-harnesst-band-bg text-harnesst-band-fg">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center">
          <Reveal
            as="h2"
            className="mx-auto max-w-3xl text-5xl font-medium leading-tight tracking-[-0.02em] sm:text-6xl"
          >
            Your first agent,
            <span className="italic"> before the meeting ends.</span>
          </Reveal>
          <Reveal
            as="p"
            delay={90}
            className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-harnesst-band-muted"
          >
            Start from a template or a blank slate. Describe the job, check the
            work, put it live. That&rsquo;s the whole loop.
          </Reveal>
          <Reveal delay={180} className="mt-10">
            <a
              href={`${appOrigin}/signup`}
              className="rounded-full bg-harnesst-band-fg px-8 py-3 text-lg font-medium text-harnesst-band-bg transition hover:opacity-85"
            >
              Sign up
            </a>
          </Reveal>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
