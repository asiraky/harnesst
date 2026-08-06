# PDF invoice evidence workflow

This is the operator migration for `jadendigital/agent-team`, specifically the bookkeeping parent
and its `reader` subagent. Marketplace updates change newly installed source; they do not rewrite an
agent's authored instructions or output schema. Update and redeploy that agent after this harnesst
release is live.

## Install or update

On the bookkeeping parent, install or update:

- Xero 0.2 or later.

On `agents/bookkeeping/agent/subagents/reader`, install or update:

- AgentMail 0.2 or later.
- Extract PDF Text 0.2 or later.
- Publish Artifact 0.4 or later.

Declared subagents have isolated sandboxes. A `/workspace/home/...` path created by the reader is
not readable by the parent, so the reader must stage, inspect and publish the PDF itself. The
immutable `artifactVersionId` returned by Publish Artifact is the cross-agent evidence handle. PDF
bytes travel only between tools and harnesst's control plane; they do not enter either model's
context.

## Reader instructions and schema

In `agents/bookkeeping/agent/subagents/reader/instructions.md`, expand the opening capability
restriction to allow `extract-pdf-text` and `publish-artifact` in addition to the three AgentMail
tools. The mailbox remains read-only: writing an attachment into the run's sandbox and publishing
evidence do not mutate the mailbox.

Replace the instruction that fetches attachments with `includeAttachmentContent: true` with this
flow:

1. Fetch the selected attachment with `saveAttachmentToHome: true` and an appropriate
   `maxAttachmentBytes`. Do not request `includeAttachmentContent`.
2. Require an `ok: true` response containing `attachment.path`, `filename`, `contentType`, `size`
   and `sha256`.
3. Call `extract-pdf-text` with that exact path.
4. Derive invoice identity and financial fields only from the extracted document text. If the tool
   reports `no_extractable_text`, return a stable parse/OCR error; do not infer values from the
   filename, email body or a separate receipt.
5. Call `publish-artifact` from the reader with the same path, `kind: "document"`, and a title that
   identifies the vendor and invoice number. Require its `sha256` to equal the AgentMail attachment
   `sha256`; a mismatch means the published evidence is not the file that was inspected.
6. A publish failure or hash mismatch is an infrastructure/evidence error and must not produce a
   usable `found` result.

Keep the prohibition on returning presigned URLs, but replace the base64 output requirement. A
successful `found.attachment_ref` should be:

```ts
const attachmentRefSchema = z.object({
  message_id: z.string(),
  attachment_id: z.string(),
  filename: z.string(),
  mime_type: z.string(),
  byte_size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifact_id: z.string(),
  artifact_version_id: z.string(),
  artifact_url: z.string(),
});
```

Do not return `path` or `content_base64`; neither is an appropriate cross-agent transport. Add
`extract-pdf-text` and `publish-artifact` to `attemptedToolSchema`, its enum, and the documented
`attempted_tools` behavior. The existing invoice fields need not otherwise change.

## Parent instructions

In `agents/bookkeeping/agent/instructions.md`, expand the `found` handling under “Getting the
invoice”:

1. Treat `attachment_ref.artifact_version_id` as the immutable identity of the exact PDF the reader
   inspected. Do not request, read, quote or reconstruct its bytes or the reader's sandbox path.
2. Retain the artifact ID, version ID, URL and SHA-256 in the run's action/evidence summary.
3. Continue the existing duplicate checks and accounting validation only after the reader returns a
   successful, published evidence reference.
4. Create the draft bill, then call `xero-attach-file-to-bill` with the bill's `invoiceId` and
   `artifactVersionId: attachment_ref.artifact_version_id`. Harnesst resolves the stored bytes and
   original file name server-side, restricted to artifacts owned by this agent.
5. Treat attachment failure as a failed bookkeeping run and do not advance the spreadsheet. Do not
   replace the source invoice with the separate receipt.
6. Include `attachment_ref.artifact_url` in the completion message and action log so an authorized
   user can open the exact evidence used for the decision.

Recommended successful ordering:

1. Reader stages, extracts and publishes the PDF, then verifies the hashes match.
2. Parent checks Xero for duplicates and validates accounting fields.
3. Parent creates the draft bill.
4. Parent attaches the published artifact version to the bill.
5. Parent advances the sheet only after bill creation and attachment both succeed.

Publishing must happen while the parent is handling a live Front of House turn. A publish invoked
by the reader still lands in that parent conversation. The artifact URL is authenticated and
version-specific; it is not a public bearer link, so the person opening it must be signed into
harnesst and authorized to view the conversation.
