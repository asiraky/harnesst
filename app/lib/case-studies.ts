/**
 * Case-study content for the marketing site. Fictional companies, written to
 * illustrate the same throughline: nobody gets replaced — the people already
 * doing the work get to stop doing its most tedious 80% and move up to the part
 * that needs a human. Consumed by the /case-studies index and the
 * /case-studies/:slug detail pages, and teased on the home page.
 *
 * Photography is downloaded from Unsplash into /public/img/case-studies and
 * self-hosted (so visitors never call Unsplash). Credit is kept per-study and
 * shown in the detail footer.
 */

export type Stat = { value: string; label: string };

export type CaseStudy = {
  slug: string;
  /** Small overline, e.g. the vertical. */
  industry: string;
  /** Fictional company name. */
  company: string;
  /** Big page/card headline. */
  headline: string;
  /** One-line outcome under the headline. */
  dek: string;
  /** Card-level highlight stat. */
  highlight: Stat;
  image: string;
  imageAlt: string;
  credit: string;
  creditUrl: string;
  /** "The challenge" — a couple of short paragraphs. */
  challenge: string[];
  /** "What they built" — a couple of short paragraphs. */
  approach: string[];
  /** The handful of agents they stood up, shown as a list. */
  agents: { name: string; does: string }[];
  /** "The result" — a couple of short paragraphs. */
  result: string[];
  /** Three result stats. */
  stats: Stat[];
  quote: { text: string; name: string; role: string };
};

export const caseStudies: CaseStudy[] = [
  {
    slug: "software-team",
    industry: "B2B software",
    company: "Cadence",
    headline: "One engineer, the output of a team.",
    dek: "The three-person platform team stopped being the bottleneck for every internal tool the company asked for.",
    highlight: { value: "~20×", label: "more internal tooling shipped" },
    image: "/img/case-studies/software-team.jpg",
    imageAlt: "A code editor open on a monitor in a dim room",
    credit: "Radowan Nakif Rehan",
    creditUrl: "https://unsplash.com/@radowanrehan",
    challenge: [
      "Cadence has three platform engineers and a company that never stops asking them for things. A CRM sync here, an alerting rule there, a data pull for the sales team, an onboarding script for the new hire. Each one is small. Together they ate the week.",
      "The engineers wanted to build the actual product. Instead they spent their days writing glue code they'd written a dozen times before, and the requests still piled up faster than they could clear them.",
    ],
    approach: [
      "Now the engineers describe the tool they need and the assistant drafts it. They read the change, adjust what's wrong, and publish. The work that used to mean an afternoon of boilerplate is a review and a nod.",
      "The bigger shift was upstream: teammates outside engineering build their own simple agents for the routine asks, so those never reach the platform team at all. The engineers moved from typing every integration to managing the fleet that writes them.",
    ],
    agents: [
      { name: "crm-sync", does: "keeps Salesforce and the product DB in step" },
      { name: "alert-router", does: "turns raw signals into the right Slack ping" },
      { name: "onboarding-bot", does: "provisions a new hire's accounts on day one" },
      { name: "data-desk", does: "answers ad-hoc data pulls without a ticket" },
    ],
    result: [
      "Same three engineers. No one was hired to keep up and no one was let go. They just stopped being the queue everyone waited behind.",
      "Requests that used to sit for a sprint now clear in a day, and the team spends most of the week on the product again instead of on other people's plumbing.",
    ],
    stats: [
      { value: "~20×", label: "internal-tool throughput per sprint" },
      { value: "3", label: "engineers, unchanged headcount" },
      { value: "70%", label: "of the week back on product work" },
    ],
    quote: {
      text: "I went from writing the same integration for the fifth time to reading over a change and hitting Publish. Same job title, completely different day.",
      name: "Priya Natarajan",
      role: "Staff Engineer, Cadence",
    },
  },
  {
    slug: "creative-agency",
    industry: "Creative agency",
    company: "Fold & Field",
    headline: "The agency that stopped saying “that’ll be next sprint.”",
    dek: "One developer went from writing every client automation by hand to maintaining a shelf of them the account team runs itself.",
    image: "/img/case-studies/creative-agency.jpg",
    imageAlt: "A bright studio meeting room with a long table and laptops",
    credit: "S O C I A L . C U T",
    creditUrl: "https://unsplash.com/@socialcut",
    highlight: { value: "5 days → same day", label: "on a typical client request" },
    challenge: [
      "Fold & Field runs on client requests, and most of them are small: resize this asset set, pull last week's campaign numbers, sort the shared inbox, send the Friday recap. The agency has one developer. Everything queued behind him.",
      "Account managers knew exactly what they needed but couldn't build it, so they wrote a brief and waited. By the time a small automation shipped, the campaign had usually moved on.",
    ],
    approach: [
      "The account managers now describe the routine work in plain words and harnesst builds the agent. The developer stopped writing one-off scripts and started reviewing and looking after a shelf of them instead.",
      "When something needs real code — a fiddly API, an odd file format — the assistant drafts it and the developer signs off. He's the reviewer now, not the entire assembly line.",
    ],
    agents: [
      { name: "asset-resizer", does: "renders every campaign size from one master" },
      { name: "inbox-triage", does: "sorts and routes the shared client inbox" },
      { name: "weekly-recap", does: "drafts the Friday numbers email per client" },
      { name: "brief-builder", does: "turns a kickoff call into a first-draft brief" },
    ],
    result: [
      "The developer maintains more than thirty agents and writes far less code than he used to. He says he actually likes the job again.",
      "Account managers ship the small stuff themselves the same afternoon they think of it, and the agency takes on more clients without adding to the payroll.",
    ],
    stats: [
      { value: "30+", label: "agents one developer maintains" },
      { value: "2 → 15", label: "automations shipped per quarter" },
      { value: "same day", label: "turnaround on routine requests" },
    ],
    quote: {
      text: "I used to be the reason everything was blocked. Now the account team builds the easy stuff and I review it over coffee. I'm not debugging the same script at 8pm anymore.",
      name: "Marcus Bell",
      role: "Lead Developer, Fold & Field",
    },
  },
  {
    slug: "law-firm",
    industry: "Legal",
    company: "Harlow & Crane",
    headline: "Associates reading the contracts that matter.",
    dek: "First-pass document review that used to swallow three days now finishes before lunch — and a lawyer signs off on everything.",
    image: "/img/case-studies/law-firm.jpg",
    imageAlt: "Rows of old leather-bound law books on wooden shelves",
    credit: "Thomas Bormans",
    creditUrl: "https://unsplash.com/@thomasbormans",
    highlight: { value: "3 days → before lunch", label: "first-pass review" },
    challenge: [
      "At Harlow & Crane, associates spent whole days on first-pass review: reading discovery, flagging clauses, summarising intake, calendaring deadlines. Necessary work, and a grind. The judgment they trained for sat underneath a pile of Ctrl-F.",
      "It's also work where a mistake is expensive, so the instinct was to throw more hours at it. Hours the firm didn't really have.",
    ],
    approach: [
      "A partner — who has never written a line of code — described the review checklist the firm already used. Their one technologist stood up agents that do the first pass: read the documents, flag the clauses that need a human, and draft the summary.",
      "Nothing leaves the building on its own. Every agent stops for a lawyer's approval before anything is filed or sent, so the firm keeps the same control it always had over what goes out the door.",
    ],
    agents: [
      { name: "first-pass-review", does: "reads discovery and flags what needs a human" },
      { name: "clause-check", does: "compares contract terms against the firm's playbook" },
      { name: "intake-summary", does: "turns a new matter into a one-page brief" },
      { name: "deadline-calendar", does: "pulls dates from filings, waits for sign-off" },
    ],
    result: [
      "First-pass review time fell by roughly four fifths. Associates spend that time on argument and strategy — the part clients actually pay for and the part lawyers actually enjoy.",
      "No one was replaced. The paralegals and associates are still here; they've handed the tedious first read to an agent and kept the judgment for themselves.",
    ],
    stats: [
      { value: "~80%", label: "less time on first-pass review" },
      { value: "0", label: "documents filed without a lawyer's sign-off" },
      { value: "3 days → hours", label: "to clear a discovery batch" },
    ],
    quote: {
      text: "I didn't go to law school to search PDFs for a keyword. Now I read what the agent flags, and I make the call. That's the job I wanted.",
      name: "Dana Okafor",
      role: "Associate, Harlow & Crane",
    },
  },
  {
    slug: "ecommerce",
    industry: "E-commerce",
    company: "Tidewater Goods",
    headline: "The support lead who built her own team — in software.",
    dek: "The repetitive 80% of tickets gets handled before a person looks, so the human crew takes the cases that actually need them.",
    image: "/img/case-studies/ecommerce.jpg",
    imageAlt: "Tall warehouse racks stacked with packed shipping boxes",
    credit: "CHUTTERSNAP",
    creditUrl: "https://unsplash.com/@chuttersnap",
    highlight: { value: "next morning → minutes", label: "first response" },
    challenge: [
      "Tidewater sells direct, which means a small support crew and big seasonal spikes. Most tickets are the same handful of questions: where's my order, I'd like a refund, how do I return this. During peaks the queue blew out and replies slipped to the next morning.",
      "Hiring temps for the busy months never really worked. By the time they were trained, the rush was over, and quality dipped in the meantime.",
    ],
    approach: [
      "The support lead, who doesn't code, described the triage rules and refund policy the team already followed. harnesst built agents that look up the order, draft the reply, and process refunds up to a set limit — handing anything unusual straight to a person.",
      "The rules are hers to change. When the return policy shifts, she edits the agent that afternoon instead of filing a request and waiting.",
    ],
    agents: [
      { name: "order-lookup", does: "answers “where is my order” from the live status" },
      { name: "refund-desk", does: "refunds within policy, escalates the rest" },
      { name: "returns-guide", does: "walks a customer through a return start to finish" },
      { name: "escalation-router", does: "hands the tricky 20% to the right human" },
    ],
    result: [
      "First response dropped from the next morning to a few minutes, even at peak. The human team stopped drowning in “where's my order” and spent its time on the cases that need a person.",
      "Last holiday season the crew didn't hire a single temp — and, in their words, didn't dread Mondays.",
    ],
    stats: [
      { value: "80%", label: "of tickets resolved before a human looks" },
      { value: "0", label: "seasonal temps hired last peak" },
      { value: "minutes", label: "to first response, even at peak" },
    ],
    quote: {
      text: "My team used to dread Mondays. Now the agent has cleared the easy stuff overnight and we handle the cases that actually need a human. Same team, better week.",
      name: "Renata Alvarez",
      role: "Head of Support, Tidewater Goods",
    },
  },
  {
    slug: "accounting",
    industry: "Accounting",
    company: "Ledgerline",
    headline: "Accountants doing the judgment, not the data entry.",
    dek: "Month-end close went from two weeks of grind to a couple of days, and the team moved onto the advisory work clients pay a premium for.",
    image: "/img/case-studies/accounting.jpg",
    imageAlt: "An accountant reviewing charts on a tablet at a desk",
    credit: "Towfiqu barbhuiya",
    creditUrl: "https://unsplash.com/@towfiqu999999",
    highlight: { value: "2 weeks → 2 days", label: "month-end close" },
    challenge: [
      "Ledgerline's month-end close was two weeks of reconciliations, invoice chasing, expense categorising and report prep. Careful, repetitive, and easy to get wrong when everyone's tired and the deadline is Friday.",
      "The firm's best people spent that fortnight on data entry instead of the advice clients actually value.",
    ],
    approach: [
      "A finance manager described the reconciliation and chase-up rules the team ran by hand. Agents now pull the statements, match transactions, send the reminders and draft the report — and stop for approval before anything touches a client's books.",
      "The manager isn't waiting on IT to change a rule. When a client's process is different, she edits the agent herself and it's live the same day.",
    ],
    agents: [
      { name: "reconciler", does: "matches statements against the ledger" },
      { name: "invoice-chaser", does: "sends the reminder cadence, tracks replies" },
      { name: "expense-sorter", does: "categorises spend, flags the odd ones" },
      { name: "close-report", does: "drafts the month-end pack for review" },
    ],
    result: [
      "Close dropped from two weeks to two days and the error rate fell with it. No one lost a job — the same accountants got their evenings back and moved onto advisory work.",
      "That advisory work is what clients happily pay more for, so the firm grew revenue without growing headcount.",
    ],
    stats: [
      { value: "2 weeks → 2 days", label: "to close the month" },
      { value: "~90%", label: "less manual data entry" },
      { value: "0", label: "client books changed without approval" },
    ],
    quote: {
      text: "We didn't add headcount and we didn't cut anyone. We gave the team we already have their evenings back, and pointed them at the work clients actually thank us for.",
      name: "Tom Whitfield",
      role: "Partner, Ledgerline",
    },
  },
];

export function getCaseStudy(slug: string): CaseStudy | undefined {
  return caseStudies.find((c) => c.slug === slug);
}
