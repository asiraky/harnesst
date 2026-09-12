/** Rendered layout audit through agent-browser. Run after signing into the preview. */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const session = process.env.AGENT_BROWSER_SESSION || "mobile-omniplex";
const origin = process.env.MOBILE_PREVIEW_ORIGIN || "http://localhost:5293";
const widths = (process.env.MOBILE_WIDTHS || "320,390,768,1280")
  .split(",")
  .map(Number);
const output = resolve("artifacts/mobile-sweep");
mkdirSync(output, { recursive: true });
function browser(...args) {
  return execFileSync(
    "npx",
    ["--yes", "agent-browser", "--session", session, ...args],
    { encoding: "utf8", timeout: 60000 },
  ).trim();
}
const conversationRoutes = JSON.parse(
  readFileSync("/tmp/harnesst-mobile-routes.json", "utf8"),
);
const runRoutes = JSON.parse(
  readFileSync("/tmp/harnesst-mobile-run-routes.json", "utf8"),
);
const routes = [
  "/",
  "/dashboard",
  "/connect",
  "/org/settings",
  "/org/members",
  "/workspaces",
  "/marketplace",
  "/marketplace/agent/designer",
  "/marketplace/agent/designer/install",
  "/marketplace/tool/extract-pdf-text",
  "/marketplace/tool/extract-pdf-text/install",
  "/repos/customer-operations",
  "/repos/customer-operations/deployment",
  "/repos/customer-operations/agents/ivy",
  "/repos/customer-operations/agents/ivy/sub/fact-checker",
  "/repos/daily-research",
  ...[
    "deployment",
    "settings",
    "playground",
    "runs",
    "artifacts",
    "assistant",
    "assistant/config",
    "sessions/archived",
    ...[
      "tools",
      "skills",
      "schedules",
      "channels",
      "subagents",
      "connections",
      "hooks",
    ].map((c) => `resources/${c}`),
    "edit/instructions",
    "edit/schedule?path=agent/schedules/weekly-report.md",
    "edit?path=agent/tools/search-customer-records.ts",
  ].map((p) => `/repos/daily-research/${p}`),
  conversationRoutes[0].split("/s/")[0],
  conversationRoutes[0],
  "/t/customer-operations/activity",
  ...runRoutes.slice(0, 2),
];
const measure = `JSON.stringify({url:location.href,title:document.title,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(e=>{
  const r=e.getBoundingClientRect(); if(!r.width || (r.right<=innerWidth+1 && r.left>=-1)) return false;
  for(let p=e.parentElement;p&&p!==document.body;p=p.parentElement){const c=getComputedStyle(p); if((['auto','scroll'].includes(c.overflowX)&&p.scrollWidth>p.clientWidth)||c.textOverflow==='ellipsis'||p.dataset.slot==='select-value')return false;}
  return getComputedStyle(e).position!=='fixed';
}).slice(0,10).map(e=>({tag:e.tagName,text:e.textContent?.trim().slice(0,80),className:typeof e.className==='string'?e.className:''})),error:!!document.querySelector('vite-error-overlay')||/Unexpected error|Application Error/.test(document.body.innerText)})`;
const report = [];
for (const width of widths) {
  browser("set", "viewport", String(width), width < 768 ? "844" : "900");
  for (const [index, path] of routes.entries()) {
    browser("open", origin + path);
    const result = JSON.parse(JSON.parse(browser("eval", measure)));
    const screenshot = `${width}-final-${String(index).padStart(2, "0")}.png`;
    browser("screenshot", resolve(output, screenshot));
    const row = {
      path,
      ...result,
      screenshot,
      redirected:
        new URL(result.url).pathname !== new URL(path, origin).pathname,
    };
    report.push(row);
    console.log(
      width,
      path,
      result.scrollWidth,
      result.overflow.length,
      result.error ? "ERROR" : "",
    );
    writeFileSync(
      resolve(output, `results-${widths.join("-")}.json`),
      JSON.stringify(report, null, 2),
    );
  }
}
const failures = report.filter(
  (r) =>
    r.scrollWidth > r.width + 1 || r.overflow.length || r.error || r.redirected,
);
console.log(
  `${report.length} rendered pages; ${failures.length} require inspection.`,
);
if (failures.length) process.exitCode = 1;
