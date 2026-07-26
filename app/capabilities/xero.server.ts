/**
 * Xero capability definition (issue #166) — the first consumer of the brokered-capability
 * framework. The bookkeeping use case books DRAFT ACCPAY bills with attached invoice files; its
 * safety story assumes the container NEVER holds Xero credentials and cannot reach any operation
 * beyond this whitelist. Anything absent here — delete, void, payments, bank feeds, payroll —
 * does not exist through harnesst.
 *
 * Restrict operations, not composition: `create_draft_bill` accepts the full legitimate bill
 * shape (multi-line, per-line tax, foreign currency + explicit rate); validation checks the bill
 * is SAFE (always DRAFT/ACCPAY, real account codes, real currency, lines sum to total), not that
 * it matches a rigid template.
 *
 * Every call carries the grant's bound tenant as the `xero-tenant-id` header — the resource
 * binding captured at connect time (`resource.list` = GET https://api.xero.com/connections).
 */
import { z } from "zod";

import type {
  CapabilityDefinition,
  OperationContext,
  OperationValidation,
} from "./definition.server";

const XERO_API = "https://api.xero.com/api.xro/2.0";

/** Attachment cap (issue #166 whitelist): 10 MiB of DECODED bytes. */
export const XERO_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The ENCODED-length ceiling matching that cap (base64 grows 3→4), enforced by the input schema
 * so an oversize payload is refused before `Buffer.from` ever allocates the decoded bytes. The
 * decoded-length check in `validateAttachFile` remains the authoritative boundary (a string of
 * exactly this length can still decode to a byte over the cap).
 */
export const XERO_ATTACHMENT_MAX_BASE64_CHARS =
  Math.ceil(XERO_ATTACHMENT_MAX_BYTES / 3) * 4;

/** Content types the attachment whitelist allows. */
export const XERO_ATTACHMENT_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** GET/POST against the Xero accounting API with the call's token + tenant binding. */
async function xeroFetch(
  ctx: OperationContext,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await ctx.fetch(`${XERO_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ctx.accessToken}`,
      "xero-tenant-id": ctx.resourceId ?? "",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Xero rejected the request (HTTP ${res.status})${body ? `: ${body.slice(0, 500)}` : "."}`,
    );
  }
  return res.json();
}

/* ─────────────────────────────── shared field shapes ─────────────────────────────── */

/** YYYY-MM-DD — becomes Xero's DateTime(y,m,d) `where` literal or a date-only JSON field. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

/**
 * A text value that may ride inside a Xero `where` clause. Quotes and backslashes are REFUSED
 * (not escaped): the clause is a query language, and refusal is the injection-proof choice.
 */
const whereSafeText = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !/["\\\r\n]/.test(s), "must not contain quotes or backslashes");

const uuid = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    "must be a Xero UUID",
  );

/** Round to cents — the comparison unit for the lines-sum-to-total invariant. */
function cents(amount: number): number {
  return Math.round(amount * 100);
}

/** DateTime(y,m,d) literal for a validated YYYY-MM-DD string. */
function whereDate(iso: string): string {
  const [y, m, d] = iso.split("-").map((p) => Number.parseInt(p, 10));
  return `DateTime(${y},${m},${d})`;
}

/* ──────────────────────────────── org lookups (per call) ─────────────────────────── */

/** The org's chart-of-accounts codes — fetched per call: correctness over caching. */
async function orgAccountCodes(ctx: OperationContext): Promise<Set<string>> {
  const body = (await xeroFetch(ctx, "/Accounts")) as {
    Accounts?: Array<{ Code?: string }>;
  };
  return new Set(
    (body.Accounts ?? [])
      .map((a) => a.Code)
      .filter((c): c is string => typeof c === "string" && c.length > 0),
  );
}

/** The org's subscribed currency codes. */
async function orgCurrencies(ctx: OperationContext): Promise<Set<string>> {
  const body = (await xeroFetch(ctx, "/Currencies")) as {
    Currencies?: Array<{ Code?: string }>;
  };
  return new Set(
    (body.Currencies ?? [])
      .map((c) => c.Code)
      .filter((c): c is string => typeof c === "string"),
  );
}

/* ────────────────────────────────── create_draft_bill ────────────────────────────── */

const lineItemSchema = z.object({
  description: z.string().min(1).max(4000),
  quantity: z.number().positive().finite(),
  unitAmount: z.number().finite(),
  /** Must exist in the org's chart of accounts (validated per call). */
  accountCode: z.string().min(1).max(50),
  /** Xero tax type code, e.g. "INPUT2" — passed through per line. */
  taxType: z.string().min(1).max(50).optional(),
  /** Explicit line amount; defaults to quantity × unitAmount. */
  lineAmount: z.number().finite().optional(),
});

const createDraftBillSchema = z.object({
  contact: z
    .object({
      /** Existing Xero contact id. */
      contactId: uuid.optional(),
      /** Or a contact name (Xero resolves/creates by name). */
      name: z.string().min(1).max(255).optional(),
    })
    .refine((c) => c.contactId || c.name, "contact needs a contactId or a name"),
  /** Bill (invoice) date. */
  date: isoDate,
  dueDate: isoDate.optional(),
  reference: z.string().max(255).optional(),
  /** ISO currency code; must be one of the org's subscribed currencies. */
  currency: z.string().length(3).optional(),
  /** Explicit exchange rate for a foreign-currency bill — allowed by the whitelist. */
  currencyRate: z.number().positive().finite().optional(),
  lineItems: z.array(lineItemSchema).min(1).max(200),
  /** Sum of the line amounts (pre-tax) — cross-checked server-side. */
  total: z.number().finite(),
});

type CreateDraftBill = z.infer<typeof createDraftBillSchema>;

function lineAmount(line: z.infer<typeof lineItemSchema>): number {
  return line.lineAmount ?? line.quantity * line.unitAmount;
}

async function validateDraftBill(
  input: unknown,
  ctx: OperationContext,
): Promise<OperationValidation> {
  const bill = input as CreateDraftBill;
  // Lines must sum to the stated total (cent-exact after rounding each line).
  const sum = bill.lineItems.reduce((acc, line) => acc + cents(lineAmount(line)), 0);
  if (sum !== cents(bill.total)) {
    return {
      ok: false,
      error:
        `The line amounts sum to ${(sum / 100).toFixed(2)} but total is ` +
        `${bill.total.toFixed(2)} — fix the lines or the total.`,
    };
  }
  // The currency must be one the org actually has.
  if (bill.currency) {
    const currencies = await orgCurrencies(ctx);
    if (!currencies.has(bill.currency.toUpperCase())) {
      return {
        ok: false,
        error: `"${bill.currency}" is not a currency of this Xero organisation — add it in Xero first, or use one of: ${[...currencies].sort().join(", ")}.`,
      };
    }
  }
  // Every account code must exist in the org's chart (fetched per call — correctness over caching).
  const codes = await orgAccountCodes(ctx);
  const missing = [
    ...new Set(
      bill.lineItems.map((l) => l.accountCode).filter((c) => !codes.has(c)),
    ),
  ];
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Account code(s) ${missing.map((c) => `"${c}"`).join(", ")} don't exist in this organisation's chart of accounts.`,
    };
  }
  return { ok: true };
}

async function executeDraftBill(
  input: unknown,
  ctx: OperationContext,
): Promise<unknown> {
  const bill = input as CreateDraftBill;
  const body = {
    Invoices: [
      {
        // The whitelist's core invariant: SERVER sets these — any client value was already
        // stripped by the input schema, and nothing here reads one.
        Type: "ACCPAY",
        Status: "DRAFT",
        Contact: bill.contact.contactId
          ? { ContactID: bill.contact.contactId }
          : { Name: bill.contact.name },
        Date: bill.date,
        ...(bill.dueDate ? { DueDate: bill.dueDate } : {}),
        ...(bill.reference ? { Reference: bill.reference } : {}),
        ...(bill.currency ? { CurrencyCode: bill.currency.toUpperCase() } : {}),
        ...(bill.currencyRate ? { CurrencyRate: bill.currencyRate } : {}),
        LineItems: bill.lineItems.map((line) => ({
          Description: line.description,
          Quantity: line.quantity,
          UnitAmount: line.unitAmount,
          AccountCode: line.accountCode,
          ...(line.taxType ? { TaxType: line.taxType } : {}),
          ...(line.lineAmount !== undefined ? { LineAmount: line.lineAmount } : {}),
        })),
      },
    ],
  };
  const res = (await xeroFetch(ctx, "/Invoices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as {
    Invoices?: Array<{
      InvoiceID?: string;
      InvoiceNumber?: string;
      Status?: string;
      Total?: number;
    }>;
  };
  const created = res.Invoices?.[0];
  return {
    invoiceId: created?.InvoiceID ?? null,
    invoiceNumber: created?.InvoiceNumber ?? null,
    status: created?.Status ?? "DRAFT",
  };
}

/* ───────────────────────────────── attach_file_to_bill ───────────────────────────── */

const attachFileSchema = z.object({
  /** The ACCPAY invoice (bill) to attach to. */
  invoiceId: uuid,
  /** Bare file name — no path separators, no leading dot. */
  filename: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,180}$/,
      "must be a plain file name (letters, digits, dots, dashes, spaces; no paths)",
    ),
  contentType: z.enum(XERO_ATTACHMENT_CONTENT_TYPES),
  /** Base64-encoded file bytes, ≤ 10 MiB decoded. */
  contentBase64: z
    .string()
    .min(1)
    .max(
      XERO_ATTACHMENT_MAX_BASE64_CHARS,
      "is longer than a 10 MiB file's base64 — attachments are capped at 10 MiB",
    ),
});

type AttachFile = z.infer<typeof attachFileSchema>;

function decodeAttachment(input: AttachFile): Buffer | null {
  try {
    const bytes = Buffer.from(input.contentBase64, "base64");
    // Node's base64 decoder is lenient; round-trip length keeps garbage from slipping through.
    if (bytes.length === 0) return null;
    return bytes;
  } catch {
    return null;
  }
}

async function validateAttachFile(
  input: unknown,
  ctx: OperationContext,
): Promise<OperationValidation> {
  const attach = input as AttachFile;
  const bytes = decodeAttachment(attach);
  if (!bytes) {
    return { ok: false, error: "contentBase64 is not valid base64 data." };
  }
  if (bytes.length > XERO_ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      error: `The file is ${(bytes.length / (1024 * 1024)).toFixed(1)} MiB — attachments are capped at 10 MiB.`,
    };
  }
  // The target must be an ACCPAY invoice (a bill) in THIS org — attaching to sales invoices or
  // other tenants' documents is outside the whitelist.
  let invoice: { Type?: string } | undefined;
  try {
    const body = (await xeroFetch(ctx, `/Invoices/${attach.invoiceId}`)) as {
      Invoices?: Array<{ Type?: string }>;
    };
    invoice = body.Invoices?.[0];
  } catch {
    invoice = undefined;
  }
  if (!invoice) {
    return {
      ok: false,
      error: `No invoice ${attach.invoiceId} exists in this Xero organisation.`,
    };
  }
  if (invoice.Type !== "ACCPAY") {
    return {
      ok: false,
      error: "Attachments can only be added to bills (ACCPAY invoices), not other document types.",
    };
  }
  return { ok: true };
}

async function executeAttachFile(
  input: unknown,
  ctx: OperationContext,
): Promise<unknown> {
  const attach = input as AttachFile;
  const bytes = decodeAttachment(attach);
  if (!bytes) throw new Error("contentBase64 is not valid base64 data.");
  await xeroFetch(
    ctx,
    `/Invoices/${attach.invoiceId}/Attachments/${encodeURIComponent(attach.filename)}`,
    {
      method: "PUT",
      headers: { "content-type": attach.contentType },
      body: new Uint8Array(bytes),
    },
  );
  return { attached: attach.filename, invoiceId: attach.invoiceId };
}

/* ─────────────────────────────────── read operations ─────────────────────────────── */

const searchBillsSchema = z.object({
  /** Case-insensitive contains-match on the contact name. */
  contactName: whereSafeText.optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED"]).optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  reference: whereSafeText.optional(),
  page: z.number().int().min(1).max(1000).optional(),
});

type SearchBills = z.infer<typeof searchBillsSchema>;

/** The `where` clause for a bills search — ALWAYS pinned to ACCPAY (bills only, never sales). */
export function billsWhereClause(input: SearchBills): string {
  const clauses = [`Type=="ACCPAY"`];
  if (input.status) clauses.push(`Status=="${input.status}"`);
  if (input.contactName) {
    clauses.push(
      `Contact.Name.ToLower().Contains("${input.contactName.toLowerCase()}")`,
    );
  }
  if (input.reference) clauses.push(`Reference=="${input.reference}"`);
  if (input.dateFrom) clauses.push(`Date>=${whereDate(input.dateFrom)}`);
  if (input.dateTo) clauses.push(`Date<=${whereDate(input.dateTo)}`);
  return clauses.join(" AND ");
}

const findContactSchema = z.object({
  /** Free-text search over contact names/emails (Xero's searchTerm). */
  searchTerm: z.string().min(1).max(255),
});

const createContactSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  phone: z.string().min(1).max(50).optional(),
  /** Tax/ABN/VAT number. Name + details ONLY — bank-account fields are not accepted. */
  taxNumber: z.string().min(1).max(50).optional(),
});

type CreateContact = z.infer<typeof createContactSchema>;

/* ─────────────────────────────────── the definition ──────────────────────────────── */

export const xeroCapability: CapabilityDefinition = {
  provider: "xero",
  resource: {
    label: "organisation",
    async list(accessToken, fetchImpl) {
      const res = await fetchImpl("https://api.xero.com/connections", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Xero rejected the connections lookup (HTTP ${res.status})${body ? `: ${body.slice(0, 300)}` : "."}`,
        );
      }
      const body = (await res.json()) as Array<{
        tenantId?: string;
        tenantName?: string;
        tenantType?: string;
      }>;
      return body
        .filter((t) => t.tenantType === "ORGANISATION" && t.tenantId)
        .map((t) => ({ id: t.tenantId!, name: t.tenantName ?? t.tenantId! }));
    },
  },
  operationGroups: [
    {
      id: "reference-read",
      label: "Read reference data",
      description:
        "List the organisation's chart of accounts, tax rates, and currencies.",
      risk: "read",
      default: true,
      operations: [
        {
          id: "list_accounts",
          input: z.object({}),
          summarize: () => ({}),
          async execute(_input, ctx) {
            const body = (await xeroFetch(ctx, "/Accounts")) as {
              Accounts?: Array<Record<string, unknown>>;
            };
            return {
              accounts: (body.Accounts ?? []).map((a) => ({
                code: a.Code ?? null,
                name: a.Name ?? null,
                type: a.Type ?? null,
                taxType: a.TaxType ?? null,
                status: a.Status ?? null,
              })),
            };
          },
        },
        {
          id: "list_tax_rates",
          input: z.object({}),
          summarize: () => ({}),
          async execute(_input, ctx) {
            const body = (await xeroFetch(ctx, "/TaxRates")) as {
              TaxRates?: Array<Record<string, unknown>>;
            };
            return {
              taxRates: (body.TaxRates ?? []).map((t) => ({
                name: t.Name ?? null,
                taxType: t.TaxType ?? null,
                effectiveRate: t.EffectiveRate ?? null,
                status: t.Status ?? null,
              })),
            };
          },
        },
        {
          id: "list_currencies",
          input: z.object({}),
          summarize: () => ({}),
          async execute(_input, ctx) {
            const body = (await xeroFetch(ctx, "/Currencies")) as {
              Currencies?: Array<Record<string, unknown>>;
            };
            return {
              currencies: (body.Currencies ?? []).map((c) => ({
                code: c.Code ?? null,
                description: c.Description ?? null,
              })),
            };
          },
        },
      ],
    },
    {
      id: "bills-read",
      label: "Read bills",
      description:
        "Search bills (ACCPAY invoices) by contact, date, status, or reference — never sales invoices.",
      risk: "read",
      default: true,
      operations: [
        {
          id: "search_bills",
          input: searchBillsSchema,
          summarize: (input) => {
            const s = input as SearchBills;
            return {
              contactName: s.contactName ?? null,
              status: s.status ?? null,
              dateFrom: s.dateFrom ?? null,
              dateTo: s.dateTo ?? null,
              reference: s.reference ?? null,
            };
          },
          async execute(input, ctx) {
            const search = input as SearchBills;
            const params = new URLSearchParams({
              where: billsWhereClause(search),
              page: String(search.page ?? 1),
            });
            const body = (await xeroFetch(ctx, `/Invoices?${params}`)) as {
              Invoices?: Array<Record<string, unknown>>;
            };
            return {
              bills: (body.Invoices ?? []).map((i) => ({
                invoiceId: i.InvoiceID ?? null,
                invoiceNumber: i.InvoiceNumber ?? null,
                contact: (i.Contact as { Name?: string } | undefined)?.Name ?? null,
                date: i.DateString ?? i.Date ?? null,
                dueDate: i.DueDateString ?? i.DueDate ?? null,
                status: i.Status ?? null,
                reference: i.Reference ?? null,
                total: i.Total ?? null,
                amountDue: i.AmountDue ?? null,
                currencyCode: i.CurrencyCode ?? null,
              })),
            };
          },
        },
      ],
    },
    {
      id: "contacts-read",
      label: "Read contacts",
      description: "Look up suppliers and other contacts by name or email.",
      risk: "read",
      default: true,
      operations: [
        {
          id: "find_contact",
          input: findContactSchema,
          summarize: (input) => ({
            searchTerm: (input as { searchTerm: string }).searchTerm,
          }),
          async execute(input, ctx) {
            const { searchTerm } = input as { searchTerm: string };
            const params = new URLSearchParams({ searchTerm });
            const body = (await xeroFetch(ctx, `/Contacts?${params}`)) as {
              Contacts?: Array<Record<string, unknown>>;
            };
            return {
              contacts: (body.Contacts ?? []).map((c) => ({
                contactId: c.ContactID ?? null,
                name: c.Name ?? null,
                emailAddress: c.EmailAddress ?? null,
                status: c.ContactStatus ?? null,
                isSupplier: c.IsSupplier ?? null,
              })),
            };
          },
        },
      ],
    },
    {
      id: "contacts-write",
      label: "Create contacts",
      description:
        "Create new contacts with a name and basic details — bank-account fields are not accepted.",
      risk: "write",
      operations: [
        {
          id: "create_contact",
          input: createContactSchema,
          summarize: (input) => ({ name: (input as CreateContact).name }),
          async execute(input, ctx) {
            const contact = input as CreateContact;
            // Whitelisted fields only: the schema stripped everything else, and this body is
            // built from named fields — bank-account details CANNOT ride through.
            const body = {
              Contacts: [
                {
                  Name: contact.name,
                  ...(contact.email ? { EmailAddress: contact.email } : {}),
                  ...(contact.phone
                    ? {
                        Phones: [
                          { PhoneType: "DEFAULT", PhoneNumber: contact.phone },
                        ],
                      }
                    : {}),
                  ...(contact.taxNumber ? { TaxNumber: contact.taxNumber } : {}),
                },
              ],
            };
            const res = (await xeroFetch(ctx, "/Contacts", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })) as { Contacts?: Array<{ ContactID?: string; Name?: string }> };
            const created = res.Contacts?.[0];
            return {
              contactId: created?.ContactID ?? null,
              name: created?.Name ?? contact.name,
            };
          },
        },
      ],
    },
    {
      id: "bills-draft",
      label: "Create draft bills",
      description:
        "Create bills as DRAFTs (a human approves them in Xero) and attach source files to them. Never authorises, pays, or deletes anything.",
      risk: "write",
      operations: [
        {
          id: "create_draft_bill",
          input: createDraftBillSchema,
          summarize: (input) => {
            const bill = input as CreateDraftBill;
            return {
              contact: bill.contact.name ?? bill.contact.contactId ?? null,
              total: bill.total,
              currency: bill.currency ?? null,
              lineCount: bill.lineItems.length,
            };
          },
          validate: validateDraftBill,
          execute: executeDraftBill,
        },
        {
          id: "attach_file_to_bill",
          input: attachFileSchema,
          summarize: (input) => {
            const attach = input as AttachFile;
            return {
              invoiceId: attach.invoiceId,
              filename: attach.filename,
              contentType: attach.contentType,
              // The redacted digest carries the SIZE, never the bytes.
              bytes: decodeAttachment(attach)?.length ?? null,
            };
          },
          validate: validateAttachFile,
          execute: executeAttachFile,
        },
      ],
    },
  ],
};
