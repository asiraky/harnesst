---
description:
  Load when an agent needs to read a PDF staged by another installed tool or supplied
  as compatibility base64.
---

# Extract PDF Text (installed tool)

Extracts embedded text from a PDF entirely inside the agent process. It does not upload the
document, use the network, or require a secret. Prefer a `path` under `/workspace/home` returned by
the source tool; for example, have AgentMail save an attachment to home and pass that path without
modification. This keeps the document bytes out of model context. `contentBase64` remains available
for sources that cannot stage a file, but do not request base64 merely to pass it between tools.

This is text extraction, not OCR. A scan or image-only PDF returns `no_extractable_text`; do not
invent values from it or claim the document was verified. Invalid, encrypted, oversized, and
malformed PDFs also return explicit errors. Output may be truncated at `maxTextChars`, so check
`truncated` before assuming the returned text covers the whole document.
