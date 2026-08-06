---
description: Load when an agent needs to read a PDF supplied as base64, including an attachment
  returned by another installed tool.
---

# Extract PDF Text (installed tool)

Extracts embedded text from a base64-encoded PDF entirely inside the agent process. It does not
upload the document, use the network, or require a secret. Pass the raw base64 string from the
source tool as `contentBase64`; for example, pass an AgentMail attachment's `contentBase64` value
without modification.

This is text extraction, not OCR. A scan or image-only PDF returns `no_extractable_text`; do not
invent values from it or claim the document was verified. Invalid, encrypted, oversized, and
malformed PDFs also return explicit errors. Output may be truncated at `maxTextChars`, so check
`truncated` before assuming the returned text covers the whole document.
