import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sha = /^[0-9a-f]{40}$/;
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const fail = (message) => { throw new Error(message); };

// This checks a work plan and its evidence, not authorization or execution leases.
export function validatePlan(plan) {
  if (plan?.version !== 1 || !text(plan.issueId) || !text(plan.specRevision))
    fail('version 1, issueId and specRevision are required');
  if (!Array.isArray(plan.tickets) || !plan.tickets.length) fail('At least one ticket is required');
  const byId = new Map();
  for (const ticket of plan.tickets) {
    if (!text(ticket.id) || byId.has(ticket.id)) fail('Ticket IDs must be nonempty and unique');
    if (!text(ticket.title)) fail(`${ticket.id}: title required`);
    if (!Array.isArray(ticket.blockedBy) || !ticket.blockedBy.every(text)
      || new Set(ticket.blockedBy).size !== ticket.blockedBy.length) fail(`${ticket.id}: invalid blockedBy`);
    if (!Array.isArray(ticket.acceptanceCriteria) || !ticket.acceptanceCriteria.length
      || !ticket.acceptanceCriteria.every(text)) fail(`${ticket.id}: acceptanceCriteria required`);
    if (!['pending', 'verified'].includes(ticket.status)) fail(`${ticket.id}: invalid status`);
    byId.set(ticket.id, ticket);
  }
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) fail(`Dependency cycle at ${id}`);
    if (visited.has(id)) return;
    const ticket = byId.get(id);
    if (!ticket) fail(`Unknown prerequisite ${id}`);
    visiting.add(id);
    for (const dependency of ticket.blockedBy) visit(dependency);
    visiting.delete(id); visited.add(id);
    if (ticket.status === 'verified') {
      if (ticket.blockedBy.some((dependency) => byId.get(dependency).status !== 'verified'))
        fail(`${id}: prerequisite is not verified`);
      if (!sha.test(ticket.headSha ?? '')) fail(`${id}: full verified head SHA required`);
      if (!Array.isArray(ticket.checks) || !ticket.checks.length
        || !ticket.checks.every((check) => text(check.command) && check.result === 'passed'))
        fail(`${id}: successful checks required`);
      if (ticket.review?.headSha !== ticket.headSha
        || !['standards', 'spec', 'defects'].every((axis) => ticket.review?.[axis] === 'passed'))
        fail(`${id}: independent reviews must pass at the verified head`);
      if (ticket.review.specRevision !== plan.specRevision) fail(`${id}: review uses a stale specification`);
      if (!text(ticket.evidenceUrl)) fail(`${id}: durable evidenceUrl required`);
    }
  }
  for (const id of byId.keys()) visit(id);
  return plan;
}

export function nextTickets(plan) {
  validatePlan(plan);
  const verified = new Set(plan.tickets.filter((t) => t.status === 'verified').map((t) => t.id));
  return plan.tickets.filter((t) => t.status === 'pending' && t.blockedBy.every((id) => verified.has(id)));
}

export function assertIssueReady(plan, head, isAncestor) {
  validatePlan(plan);
  if (!sha.test(head ?? '')) fail('Full integrated head SHA required');
  for (const ticket of plan.tickets) {
    if (ticket.status !== 'verified') fail(`${ticket.id}: not verified`);
    if (!isAncestor(ticket.headSha, head)) fail(`${ticket.id}: verified commit is not in the integrated revision`);
  }
  return { issueId: plan.issueId, headSha: head, tickets: plan.tickets.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, file, head] = process.argv.slice(2);
    if (!['validate', 'next', 'ready'].includes(command) || !file)
      fail('Usage: node ticket-plan.mjs validate|next|ready tickets.json [integration-head-sha]');
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    const result = command === 'ready' ? assertIssueReady(plan, head, (ancestor, descendant) => {
      try { execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'pipe' }); return true; }
      catch { return false; }
    }) : command === 'next' ? nextTickets(plan) : { valid: !!validatePlan(plan) };
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
