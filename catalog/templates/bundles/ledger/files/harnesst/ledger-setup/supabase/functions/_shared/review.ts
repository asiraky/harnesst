type Json = Record<string, any>;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/** Render only the immutable action snapshot, never the current mutable item. */
export function reviewBody(action: Json, supersedesApprovalId: string | null = null) {
  const input = action.input, spec = input.spec ?? {};
  const title = text(input.title).replace(/[\r\n]+/g, ' ').slice(0, 200) || 'Review proposed work';
  const sections = [
    `# ${title}`,
    `## Decision requested\nReview the proposed ${String(input.stage).replaceAll('-', ' ')}. Approval moves this work to **${input.approve_to}**. Requesting changes returns it to **${input.reject_to}**.`,
    text(spec.body) ? `## Specification\n${text(spec.body)}` : `## Problem\n${text(spec.problem) || 'No problem description supplied.'}`,
  ];
  if (text(spec.review_markdown)) sections.push('## Engineering review\n' + text(spec.review_markdown));
  for (const [key, label] of Object.entries({decisions:'Proposal and rationale',acceptance_criteria:'Acceptance criteria',out_of_scope:'Out of scope',open_questions:'Open questions'})) {
    const values = spec[key];
    if (Array.isArray(values) && values.length) sections.push(`## ${label}\n${values.map(v => `- ${text(v) || JSON.stringify(v)}`).join('\n')}`);
  }
  if (Array.isArray(spec.proposed_children) && spec.proposed_children.length)
    sections.push('## Proposed work\n' + spec.proposed_children.map((c: Json) => `### ${text(c.title)}\n${text(c.spec?.problem)}`).join('\n\n'));
  if (Array.isArray(input.artifacts) && input.artifacts.length)
    sections.push('## Supporting links\n' + input.artifacts.map((a: Json) => `- ${a.type}: ${a.value}`).join('\n'));
  if (Array.isArray(input.evidence) && input.evidence.length)
    sections.push('## Verification and evidence\n```json\n' + JSON.stringify(input.evidence, null, 2) + '\n```');
  sections.push(`## Revision\nWork item: ${input.item_id}\n\nRevision: ${input.binding}\n\nApproval generation: ${input.epoch}`);
  const reviewMarkdown = sections.join('\n\n');
  if (reviewMarkdown.length > 100000) throw new Error('Review document exceeds May I limit; shorten the proposal or evidence');
  return { title, explanation: `Review ${title}. Approve to proceed to ${input.approve_to}, or request changes with feedback.`, reviewMarkdown,
    ...(supersedesApprovalId ? { supersedesApprovalId } : {}) };
}
export async function reviewDigest(body: Json): Promise<string> {
  // Contract: sorted keys, compact JSON, null for absent optional fields.
  const canonical = JSON.stringify({explanation:body.explanation ?? null,reviewMarkdown:body.reviewMarkdown ?? null,title:body.title ?? null,v:1});
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), n=>n.toString(16).padStart(2,'0')).join('');
}
export function receiptReviewDigest(receipt: string): string | null {
  // This is read only from an authenticated May I GET response. Not a standalone
  // receipt verifier: callback signatures and authoritative action matching remain mandatory.
  try { const parts = receipt.split('.'); if(parts.length!==3) return null;
    return JSON.parse(atob(parts[1].replaceAll('-','+').replaceAll('_','/'))).review_digest ?? null;
  } catch {return null;}
}
