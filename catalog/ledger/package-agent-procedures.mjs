// Reproducible packaging: upstream bytes are frozen; environment bindings are separate.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vendor = resolve(root, 'catalog/vendor/matt-pocock');
const manifest = JSON.parse(readFileSync(resolve(vendor, 'manifest.json'), 'utf8'));
const check = process.argv.includes('--check');
const outputs = new Map();
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
for (const [file, hash] of Object.entries(manifest.files)) {
  const bytes = readFileSync(resolve(vendor, file));
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw Error(`Upstream file changed: ${file}`);
}
const paths = Object.keys(manifest.files);
function source(name) { return paths.find((p) => p.endsWith(`/${name}/SKILL.md`)); }
function body(name) { return readFileSync(resolve(vendor, source(name)), 'utf8'); }
function emit(path, content) { outputs.set(path, content); }
function procedure(role, names) {
  return read(`catalog/ledger/agent-bindings/${role}.md`) + '\n' + names.map((name) =>
    `<!-- BEGIN VERBATIM ${source(name)} @ ${manifest.commit} -->\n` + body(name)
    + `<!-- END VERBATIM ${source(name)} -->\n`).join('\n');
}
function references(base, names) {
  for (const name of names) {
    const prefix = source(name).slice(0, -'SKILL.md'.length);
    for (const file of paths.filter((p) => p.startsWith(prefix)))
      emit(`${base}/skills/matt-pocock-${name}/${file.slice(prefix.length) === 'SKILL.md' ? 'SOURCE.md' : file.slice(prefix.length)}`, readFileSync(resolve(vendor, file)));
    emit(`${base}/skills/matt-pocock-${name}/LICENSE`, readFileSync(resolve(vendor, 'LICENSE')));
    emit(`${base}/skills/matt-pocock-${name}/SKILL.md`, `---\ndescription: Read when the incorporated ${name} procedure calls for its reference material.\n---\n\nThe unchanged upstream procedure is in [SOURCE.md](SOURCE.md). Its invocation metadata is archival; execute the procedure through the agent's HARNESST binding. Relative references resolve in this directory.\n`);
  }
}
function ticketFiles(base) {
  emit(`${base}/skills/issue-tickets/SKILL.md`, read('catalog/ledger/agent-bindings/ticket-plan.md'));
  emit(`${base}/skills/issue-tickets/ticket-plan.mjs`, read('catalog/ledger/ticket-plan.mjs'));
}
const agentModule = (description) => `import { defineAgent } from "eve";\nexport default defineAgent({\n  description: ${JSON.stringify(description)},\n  model: "anthropic/claude-sonnet-5",\n  modelContextWindowTokens: 200_000,\n});\n`;
// Eve subagents have independent sandboxes. Give these readers only GitHub-related environment entries.
const sandbox = read('catalog/ledger/agent-bindings/review-sandbox.ts')
  .replace('.filter(Boolean)', '.filter((name) => name.startsWith("GITHUB_APP_") || name === "GH_TOKEN")');
function tools(base) {
  emit(`${base}/sandbox/sandbox.ts`, sandbox);
  for (const name of ['dev-toolchain', 'github-app-auth'])
    emit(`${base}/skills/${name}.md`, read(`catalog/templates/skills/${name}/files/skills/${name}.md`));
}
function subagent(id, name, description, instruction, refs = []) {
  const template = `catalog/templates/subagents/${id}`;
  const base = `${template}/files/subagents/${name}`;
  emit(`${base}/agent.ts`, agentModule(description));
  emit(`${base}/instructions.md`, instruction);
  tools(base); references(base, refs);
  emit(`${template}/assistant-skill.md`, `---\ndescription: Install or troubleshoot ${name}.\n---\n\n${description}\n\nInstructions contain preserved upstream procedures and separately identified HARNESST bindings. Subagents return questions to their parent; they cannot contact the human.\n`);
  return { template, base, id, name, description };
}
const planner = subagent('ledger-planner', 'planner', 'Break one settled issue specification into internal tickets and dependencies; return unresolved decisions to intake.', procedure('planner', ['to-tickets']), ['to-tickets','triage','grilling','domain-modeling','setup-matt-pocock-skills','codebase-design']);
ticketFiles(planner.base);
const reviewer = subagent('ledger-code-review', 'reviewer', 'Execute the verbatim two-axis code-review procedure on supplied committed base/head revisions and scope.', procedure('reviewer', ['code-review']), ['code-review','setup-matt-pocock-skills']);
const reviewText = body('code-review');
const baseline = reviewText.slice(reviewText.indexOf('- **Mysterious Name**'), reviewText.indexOf('\n### 4. Spawn'));
const standardsBrief = reviewText.match(/The brief: "(Report, per file\/hunk[^\n]+)"/)[1];
const specBrief = reviewText.match(/The brief: "(Report: \(a\)[^\n]+)"/)[1];
for (const [name, brief] of [['standards', standardsBrief + '\n\n' + baseline], ['spec', specBrief]]) {
  const base = `${reviewer.base}/subagents/${name}`;
  emit(`${base}/agent.ts`, agentModule(`Perform only the ${name} axis of the supplied code review; return findings to reviewer.`));
  emit(`${base}/instructions.md`, `# HARNESST binding: ${name} review leaf\n\nUse the supplied diff command, committed revisions and source documents. Return missing context to reviewer. You cannot contact the human. Perform this review directly: do not invoke code-review or spawn additional agents. Make no code changes.\n\n# Verbatim upstream review brief\n\n${brief}\n`);
  tools(base);
}
const researcher = subagent('ledger-researcher', 'researcher', 'Investigate a bounded codebase question for intake; report file references, facts and unknowns without making product decisions.', '# Researcher\n\nRead the supplied repository and investigate the assigned factual question. Return evidence with file references and distinguish observed behaviour from inference. You cannot contact the human: return missing context to intake. Do not change code or decide requirements.\n');
for (const entry of [planner, reviewer, researcher]) {
  const files = [...outputs.keys()].filter((p) => p.startsWith(`${entry.template}/files/`)).map((p) => p.slice(`${entry.template}/files/`.length)).sort();
  emit(`${entry.template}/template.json`, json({id:entry.id,type:'subagent',name:entry.name,description:entry.description,version:'0.1.0',eve:'>=0.22.0',subagentCompatible:true,files,assistantSkill:'assistant-skill.md'}));
}
const intake = 'catalog/templates/agents/ledger-intake/files';
emit(`${intake}/instructions.md`, procedure('intake', ['grill-with-docs','grilling','domain-modeling','to-spec']));
references(intake, ['grill-with-docs','grilling','domain-modeling','to-spec','setup-matt-pocock-skills','codebase-design']);
ticketFiles(intake);
const implementer = 'catalog/templates/agents/ledger-implementer/files';
emit(`${implementer}/instructions.md`, procedure('implementer', ['implement','tdd']));
references(implementer, ['implement','tdd','codebase-design']); ticketFiles(implementer);
const defect = `${implementer}/subagents/defect-reviewer`;
emit(`${defect}/agent.ts`, agentModule('Independently find correctness, failure-handling and security defects in the supplied ticket or integrated issue diff.'));
emit(`${defect}/instructions.md`, '# Defect reviewer\n\nReview the supplied committed diff and specification for concrete correctness and security defects, failure paths and regressions. Verify each finding against the code and report file locations, reproduction or reasoning, impact, and unverified areas. Return findings to implementer. You cannot contact the human or grant human approval. Make no code changes; do not delegate. State the base/head SHAs and the scope reviewed.\n');
tools(defect);
for (const [role, includes] of [
  ['intake', [{type:'bundle',id:'ledger'},{type:'skill',id:'dev-toolchain'},{type:'subagent',id:'ledger-planner'},{type:'subagent',id:'ledger-researcher'}]],
  ['implementer', [{type:'bundle',id:'ledger'},{type:'bundle',id:'github-bundle'},{type:'skill',id:'dev-toolchain'},{type:'skill',id:'building-cloudflare-apps'},{type:'subagent',id:'ledger-code-review'}]],
]) {
  const template = `catalog/templates/agents/ledger-${role}`;
  const original = JSON.parse(read(`${template}/template.json`));
  const files = new Set(original.files.filter((p) => !p.startsWith('subagents/reviewer/') && !p.endsWith('/matt-pocock-LICENSE')));
  for (const p of outputs.keys()) if (p.startsWith(`${template}/files/`)) files.add(p.slice(`${template}/files/`.length));
  emit(`${template}/template.json`, json({...original,version:'0.2.0',files:[...files].sort(),includes}));
}
let failures = 0;
for (const [file, content] of outputs) {
  const target = resolve(root,file);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (check) {
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) { console.error(`Generated file out of date: ${file}`); failures++; }
  } else { mkdirSync(dirname(target),{recursive:true}); writeFileSync(target,bytes); }
}
if (failures) process.exitCode=1;
else console.log(`${check ? 'Verified' : 'Generated'} ${outputs.size} files; upstream bytes match ${manifest.commit}.`);
