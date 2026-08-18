---
name: Google Sheets usage
description: How to read and write Google Sheets correctly with the google_sheets__* tools.
---

# Working with Google Sheets

This agent has a Google Sheets connection: each Sheets API operation is exposed as a tool named
`google_sheets__<operationId>` (for example `google_sheets__spreadsheets_values_get`). Discover the
exact tools and their parameters with the connection's tool search before calling — do not guess
parameter names.

## Identifying a spreadsheet

- A spreadsheet is identified by its **spreadsheetId** — the long token in the URL:
  `https://docs.google.com/spreadsheets/d/<spreadsheetId>/edit`.
- A **range** uses **A1 notation**: `Sheet1!A1:C10`. If the sheet/tab name contains spaces or
  non-alphanumeric characters, wrap it in single quotes: `'Q1 Budget'!A1:C10`.
- Open-ended ranges are allowed: `Sheet1!A:A` (a whole column), `Sheet1!2:2` (a whole row),
  `Sheet1` (the whole sheet).

## Read before you write

ALWAYS read the current state before mutating:

1. Call `google_sheets__spreadsheets_get` (optionally with `ranges` / `includeGridData`) to learn
   the sheet names, ids, and dimensions.
2. Call `google_sheets__spreadsheets_values_get` (or `_batchGet` for several ranges at once) to see
   the current cell values.

Only then update. Writing blind — to the wrong tab, or over existing data — is the most common
failure. Confirm the target range with the user when it isn't obvious.

## Writing values: RAW vs USER_ENTERED

Both `spreadsheets_values_update` and `spreadsheets_values_append` require `valueInputOption`:

- **`USER_ENTERED`** — values are parsed as if typed in the UI: `"=SUM(A1:A3)"` becomes a formula,
  `"1/2/2025"` becomes a date, `"$5.00"` a currency number. Use this for anything a human would type.
- **`RAW`** — values are stored verbatim as strings/numbers, no parsing. Use this to write literal
  text that must not be interpreted (e.g. a string that starts with `=` or looks like a date).

`values` is an **array of rows**, each row an **array of cell values**:
`[["Name", "Total"], ["Alice", 42]]`.

## append vs update

- **`spreadsheets_values_append`** finds the existing table under the given range and adds rows
  **after** the last row of data. Use it to log/add new rows without overwriting. `insertDataOption`
  controls whether it overwrites trailing cells (`OVERWRITE`) or inserts new rows (`INSERT_ROWS`).
- **`spreadsheets_values_update`** writes to the **exact** range you specify, overwriting whatever
  is there. Use it to set known cells.
- **`spreadsheets_values_batchUpdate`** writes several ranges in one call (an array of `ValueRange`).
- **`spreadsheets_values_clear`** empties a range (values only; formatting stays).

## Structural changes: spreadsheets_batchUpdate

`spreadsheets_values_*` only touch cell **data**. For structure and formatting use
`google_sheets__spreadsheets_batchUpdate`, whose body is `{ "requests": [ ... ] }` — an array of
**request union** objects, one kind of change each. Common requests:

- `{ "addSheet": { "properties": { "title": "New Tab" } } }` — add a tab.
- `{ "deleteSheet": { "sheetId": <id> } }` — remove a tab (get the id from `spreadsheets_get`).
- `{ "updateSheetProperties": { "properties": { "sheetId": <id>, "title": "Renamed" }, "fields": "title" } }`.
- `{ "updateCells": { ... } }` — write cell values AND formatting together (advanced).

Each request needs the correct nested shape and, for update-style requests, a `fields` mask naming
what to change. When unsure, prefer the `values_*` tools for plain data and reserve `batchUpdate`
for genuine structural edits.

## Limits and failure modes

- Read/write in reasonable chunks; a single call returning an enormous grid is slow — request only
  the ranges you need.
- A first call in a session may pause for human approval (the connection is approval-gated by
  default); that is expected, not an error.

### Always check `status` — a failed call still looks like a successful tool result

Every `google_sheets__*` call returns `{ status, statusText, body }`. A failure is **not** raised as
a tool error: on a bad call `body` holds Google's error object instead of data, and the result
otherwise looks exactly like a successful one. Read `status` before you read `body`. Treating an
error body as data is how a broken run turns into a confidently wrong answer.

- **`401`** — the credential is bad or expired. Reconnect Google from the agent's Deployment tab.
  This, not a `5xx`, is what an expired token actually looks like.
- **`403`** — the **connected Google account** doesn't have access to that spreadsheet. Share the
  sheet with that account (or connect an account that already has access) — the agent can only
  reach spreadsheets its connected identity can open.
- **`404`** — wrong `spreadsheetId`, or a sheet/tab name that doesn't exist — re-check with
  `spreadsheets_get`.
- **`400`** — a malformed range or request body. Fix the call; retrying it unchanged will not help.

### Transient failures: `429` and `5xx`

`429`, `500`, `502`, `503`, and `504` — including a body of
`{"error":{"status":"UNAVAILABLE","message":"The service is currently unavailable."}}` — mean Google
is rate-limiting or briefly down. **The call was not answered, so its outcome is unknown.** These
clear on their own, usually within minutes.

Retry with real backoff, and give the outage time to end: wait ~30s before the second attempt, ~1
minute before the third, ~2 minutes before the fourth. Two attempts fired back-to-back is not a
retry — the whole sequence lands inside the same handful of seconds, which is exactly the window
that is still broken.

**Retry reads freely; never blind-retry a write.** `spreadsheets_values_get` / `_batchGet` /
`spreadsheets_get` change nothing, so repeating one is always safe. A write that returns `5xx` may
still have been applied — Google can fail on the way back to you — and retrying it blindly is how
`spreadsheets_values_append` ends up adding the same rows twice, or `addSheet` creating a duplicate
tab. After a failed `_append` / `_update` / `_clear` / `batchUpdate`:

1. wait out the backoff;
2. **re-read** the target range and check whether the write actually landed;
3. only repeat the write if it did not.

`_update` to an exact range is naturally idempotent once you have re-read and confirmed the target;
`_append` is not, and is the one that silently duplicates.

If the calls still fail after backing off, **stop the task and report it as failed**, naming the
status and the operation. Do not carry on as if the read had returned nothing:

- a `5xx` on a read means **unknown**, never **empty**;
- never publish a report, summary, or "0 processed / 0 found" message built on a failed read — that
  is indistinguishable from a genuine nothing-to-do run, and a human will read it as one;
- never write to a spreadsheet based on a read that failed. Read-before-write (above) is only a
  safeguard when the read actually succeeded.
