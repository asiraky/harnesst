/**
 * A stylised mock of the harnesst editor for the landing hero — not a real
 * screenshot (it renders as an app window with a file rail, an instructions
 * pane, and the assistant drafting a tool). Built from the `harnesst-*` band/panel
 * tokens so it reads as a dark product shot on the cream page and stays legible
 * in dark mode. Decorative: hidden from assistive tech.
 */
export function ProductMockup() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-xl border border-harnesst-panel-line bg-harnesst-band-bg text-harnesst-band-fg shadow-2xl shadow-black/10"
    >
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-harnesst-panel-line px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-harnesst-band-muted/50" />
        <span className="h-3 w-3 rounded-full bg-harnesst-band-muted/35" />
        <span className="h-3 w-3 rounded-full bg-harnesst-band-muted/25" />
        <span className="ml-3 text-xs text-harnesst-band-muted">
          support-agent — harnesst
        </span>
      </div>

      <div className="grid grid-cols-[9rem_1fr] sm:grid-cols-[11rem_1fr]">
        {/* file rail */}
        <div className="hidden flex-col gap-1 border-r border-harnesst-panel-line p-4 font-mono text-xs text-harnesst-band-muted sm:flex">
          <span className="text-harnesst-band-fg">support-agent/</span>
          <span className="pl-3 text-harnesst-band-fg">instructions.md</span>
          <span className="pl-3">tools/refund.ts</span>
          <span className="pl-3">skills/triage/</span>
          <span className="pl-3">schedules/daily.ts</span>
          <span className="pl-3">channels/slack.ts</span>
        </div>

        {/* editor + assistant */}
        <div className="flex flex-col">
          <div className="border-b border-harnesst-panel-line p-5 font-mono text-xs leading-relaxed sm:text-sm">
            <p className="text-harnesst-band-muted"># instructions.md</p>
            <p className="mt-3">
              You handle customer support for an online store.
            </p>
            <p className="mt-2">
              Look up the order, answer clearly, and refund up to{" "}
              <span className="rounded bg-harnesst-band-fg/10 px-1">$50</span>{" "}
              without asking.
            </p>
            <p className="mt-2 text-harnesst-band-muted">
              Anything unusual, hand it to a human.
              <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-harnesst-band-fg/70" />
            </p>
          </div>

          {/* assistant drafting a tool */}
          <div className="bg-harnesst-panel-bg p-5">
            <p className="text-xs uppercase tracking-[0.2em] text-harnesst-band-muted">
              Assistant
            </p>
            <p className="mt-3 text-sm leading-relaxed">
              Drafted{" "}
              <span className="font-mono text-harnesst-band-fg">tools/refund.ts</span>{" "}
              — looks up the order and refunds it. Saved it for your review —
              publish when you&rsquo;re ready.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-harnesst-panel-line px-3 py-1 text-harnesst-band-muted">
                + refund.ts
              </span>
              <span className="rounded-full bg-harnesst-band-fg px-3 py-1 font-medium text-harnesst-band-bg">
                Review &amp; publish
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
