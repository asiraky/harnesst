/**
 * The Xero capability definition (issue #166) — every server-side invariant in the whitelist,
 * exercised through the REAL orchestration (`executeCapabilityCall` with the real xeroCapability)
 * against a fake Xero API, so the tests prove what an agent can and cannot make harnesst do:
 *
 *  - bills are ALWAYS created DRAFT/ACCPAY — client-sent Status/Type are stripped, never read;
 *  - line amounts must sum to the total; account codes and the currency must exist in the org;
 *  - attachments: ACCPAY target only, whitelisted content types, ≤ 10 MiB decoded, plain filename;
 *  - searches are pinned to ACCPAY and refuse where-clause injection (quotes/backslashes);
 *  - create_contact whitelists name+details — bank-account fields cannot ride through;
 *  - every call is audited with the redacted digest (sizes and totals, never bytes or lines).
 */
import { describe, expect, it } from "vitest";

import type { CapabilityCallRecord } from "~/capabilities/audit.server";
import type { CapabilityExecuteDeps } from "~/capabilities/execute.server";
import {
  executeCapabilityCall,
  type CapabilityCaller,
} from "~/capabilities/execute.server";
import { getCapability } from "~/capabilities/registry.server";
import {
  billsWhereClause,
  resolveXeroAttachment,
  XERO_ATTACHMENT_MAX_BASE64_CHARS,
  XERO_ATTACHMENT_MAX_BYTES,
  xeroCapability,
} from "~/capabilities/xero.server";

const CALLER: CapabilityCaller = {
  deploymentId: "dep_1",
  agent: {
    id: "agntabcdefgh",
    projectId: "projabcdefgh",
    name: "books",
    root: "roster/books",
  },
};

const BILL_ID = "11111111-2222-3333-4444-555555555555";
const SALES_ID = "99999999-8888-7777-6666-555555555555";

/** A fake Xero accounting API: org with two account codes, AUD+USD, one bill, one sales invoice. */
function fakeXero() {
  const requests: Array<{
    method: string;
    url: string;
    body?: unknown;
    contentType?: string;
  }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const entry: (typeof requests)[number] = { method, url };
    if (typeof init?.body === "string") entry.body = JSON.parse(init.body);
    const headers = new Headers(init?.headers);
    entry.contentType = headers.get("content-type") ?? undefined;
    requests.push(entry);

    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.endsWith("/Accounts") && method === "GET") {
      return json({ Accounts: [{ Code: "400" }, { Code: "620" }] });
    }
    if (url.endsWith("/Currencies")) {
      return json({ Currencies: [{ Code: "AUD" }, { Code: "USD" }] });
    }
    if (url.includes("/Invoices/") && method === "GET") {
      if (url.includes(BILL_ID))
        return json({ Invoices: [{ Type: "ACCPAY" }] });
      if (url.includes(SALES_ID))
        return json({ Invoices: [{ Type: "ACCREC" }] });
      return json({ Invoices: [] });
    }
    if (url.endsWith("/Invoices") && method === "POST") {
      return json({
        Invoices: [
          { InvoiceID: BILL_ID, InvoiceNumber: "BILL-1", Status: "DRAFT" },
        ],
      });
    }
    if (url.includes("/Attachments/") && method === "PUT") {
      return json({ Attachments: [] });
    }
    if (url.includes("/Contacts") && method === "POST") {
      return json({ Contacts: [{ ContactID: BILL_ID, Name: "New Supplier" }] });
    }
    if (url.includes("/Invoices?") || url.includes("/Contacts?")) {
      return json({ Invoices: [], Contacts: [] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function xeroDeps(fetchImpl: typeof fetch): {
  deps: CapabilityExecuteDeps;
  audits: CapabilityCallRecord[];
} {
  const audits: CapabilityCallRecord[] = [];
  return {
    audits,
    deps: {
      getCapability: (provider) =>
        provider === "xero" ? xeroCapability : null,
      enabledGroups: async () =>
        xeroCapability.operationGroups.map((g) => g.id),
      findGrant: async () => ({ resourceId: "tenant-1" }),
      accessToken: async () => ({
        ok: true,
        accessToken: "at_1",
        expiresAt: Date.now() + 1_800_000,
      }),
      record: async (record) => {
        audits.push(record);
      },
      begin: async (record) => {
        audits.push({ ...record, outcome: "pending", error: null });
        return String(audits.length - 1);
      },
      finalize: async (id, outcome, error) => {
        audits[Number(id)] = { ...audits[Number(id)], outcome, error };
      },
      fetchImpl,
    },
  };
}

function call(operation: string, body: unknown, deps: CapabilityExecuteDeps) {
  return executeCapabilityCall(
    { provider: "xero", operation, caller: CALLER, body },
    deps,
  );
}

const GOOD_BILL = {
  contact: { name: "Acme Supplies" },
  date: "2026-07-01",
  dueDate: "2026-07-31",
  reference: "INV-1234",
  lineItems: [
    { description: "Widgets", quantity: 2, unitAmount: 10, accountCode: "400" },
    { description: "Freight", quantity: 1, unitAmount: 5, accountCode: "620" },
  ],
  total: 25,
};

describe("xero create_draft_bill", () => {
  it("is registered as the xero capability", () => {
    expect(getCapability("xero")).toBe(xeroCapability);
  });

  it("creates the bill DRAFT/ACCPAY with the tenant header — client Status/Type are ignored", async () => {
    const { fetchImpl, requests } = fakeXero();
    const { deps } = xeroDeps(fetchImpl);
    const out = await call(
      "create_draft_bill",
      // A misbehaving agent tries to authorise a sales invoice — the schema strips both keys.
      { ...GOOD_BILL, Status: "AUTHORISED", Type: "ACCREC" },
      deps,
    );
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(out.body.result).toMatchObject({
      invoiceId: BILL_ID,
      status: "DRAFT",
    });
    const post = requests.find(
      (r) => r.method === "POST" && r.url.endsWith("/Invoices"),
    )!;
    const invoice = (post.body as { Invoices: Array<Record<string, unknown>> })
      .Invoices[0];
    expect(invoice.Status).toBe("DRAFT");
    expect(invoice.Type).toBe("ACCPAY");
    expect(invoice.LineItems).toHaveLength(2);
  });

  it("refuses a bill whose line amounts don't sum to the total", async () => {
    const { fetchImpl, requests } = fakeXero();
    const { deps, audits } = xeroDeps(fetchImpl);
    const out = await call(
      "create_draft_bill",
      { ...GOOD_BILL, total: 26 },
      deps,
    );
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toMatch(/sum to 25\.00 but total is 26\.00/);
    expect(requests.find((r) => r.method === "POST")).toBeUndefined();
    expect(audits[0].outcome).toBe("refused");
  });

  it("refuses an account code that doesn't exist in the org's chart", async () => {
    const { fetchImpl, requests } = fakeXero();
    const { deps } = xeroDeps(fetchImpl);
    const out = await call(
      "create_draft_bill",
      {
        ...GOOD_BILL,
        lineItems: [
          {
            description: "Widgets",
            quantity: 1,
            unitAmount: 25,
            accountCode: "999",
          },
        ],
      },
      deps,
    );
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toMatch(/"999" don't exist/);
    expect(requests.find((r) => r.method === "POST")).toBeUndefined();
  });

  it("refuses a currency the org doesn't have, allows a real one with an explicit rate", async () => {
    const { fetchImpl } = fakeXero();
    const { deps } = xeroDeps(fetchImpl);
    const refused = await call(
      "create_draft_bill",
      { ...GOOD_BILL, currency: "EUR" },
      deps,
    );
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error).toMatch(/"EUR" is not a currency/);

    const { fetchImpl: fetch2, requests } = fakeXero();
    const { deps: deps2 } = xeroDeps(fetch2);
    const allowed = await call(
      "create_draft_bill",
      { ...GOOD_BILL, currency: "USD", currencyRate: 0.65 },
      deps2,
    );
    expect(allowed.body.ok).toBe(true);
    const post = requests.find((r) => r.method === "POST")!;
    const invoice = (post.body as { Invoices: Array<Record<string, unknown>> })
      .Invoices[0];
    expect(invoice.CurrencyCode).toBe("USD");
    expect(invoice.CurrencyRate).toBe(0.65);
  });

  it("audits the redacted digest — contact/total/currency/line count, never the line contents", async () => {
    const { fetchImpl } = fakeXero();
    const { deps, audits } = xeroDeps(fetchImpl);
    await call("create_draft_bill", GOOD_BILL, deps);
    expect(audits[0]).toMatchObject({
      outcome: "ok",
      groupId: "bills-draft",
      inputSummary: {
        contact: "Acme Supplies",
        total: 25,
        currency: null,
        lineCount: 2,
      },
    });
    expect(JSON.stringify(audits[0].inputSummary)).not.toContain("Widgets");
  });
});

describe("xero attach_file_to_bill", () => {
  const pdf = Buffer.from("%PDF-1.4 tiny").toString("base64");

  it("resolves an immutable PDF artifact owned by the calling agent", async () => {
    const bytes = Buffer.from("%PDF-1.7 published evidence");
    const resolved = await resolveXeroAttachment(
      { invoiceId: BILL_ID, artifactVersionId: "version-1" },
      CALLER.agent.id,
      {
        find: async ({ agentId, versionId }) => {
          expect(agentId).toBe(CALLER.agent.id);
          expect(versionId).toBe("version-1");
          return {
            artifact: { kind: "document", name: "supplier-invoice.pdf" },
            version: {
              contentType: "application/pdf",
              storagePath: "ab/abcdef",
            },
          } as never;
        },
        read: async (storagePath) => {
          expect(storagePath).toBe("ab/abcdef");
          return bytes;
        },
      },
    );

    expect(resolved).toEqual({
      bytes,
      filename: "supplier-invoice.pdf",
      contentType: "application/pdf",
    });
  });

  it("refuses an artifact version that is missing or not owned by the calling agent", async () => {
    const resolved = await resolveXeroAttachment(
      { invoiceId: BILL_ID, artifactVersionId: "someone-elses-version" },
      CALLER.agent.id,
      {
        find: async () => null,
        read: async () => {
          throw new Error("must not read unauthorized bytes");
        },
      },
    );

    expect(resolved).toBeNull();
  });

  it("attaches a small pdf to an ACCPAY invoice with the whitelisted content type", async () => {
    const { fetchImpl, requests } = fakeXero();
    const { deps } = xeroDeps(fetchImpl);
    const out = await call(
      "attach_file_to_bill",
      {
        invoiceId: BILL_ID,
        filename: "invoice-1234.pdf",
        contentType: "application/pdf",
        contentBase64: pdf,
      },
      deps,
    );
    expect(out.body.ok).toBe(true);
    const put = requests.find((r) => r.method === "PUT")!;
    expect(put.url).toContain(
      `/Invoices/${BILL_ID}/Attachments/invoice-1234.pdf`,
    );
    expect(put.contentType).toBe("application/pdf");
  });

  it("refuses an attachment over 10 MiB decoded", async () => {
    const { fetchImpl, requests } = fakeXero();
    const { deps } = xeroDeps(fetchImpl);
    const oversize = Buffer.alloc(XERO_ATTACHMENT_MAX_BYTES + 1).toString(
      "base64",
    );
    const out = await call(
      "attach_file_to_bill",
      {
        invoiceId: BILL_ID,
        filename: "big.pdf",
        contentType: "application/pdf",
        contentBase64: oversize,
      },
      deps,
    );
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toMatch(/capped at 10 MiB/);
    expect(requests.find((r) => r.method === "PUT")).toBeUndefined();
  });

  it("refuses an over-long base64 string at the SCHEMA — before any decode allocates the bytes", async () => {
    const { fetchImpl, requests } = fakeXero();
    const { deps } = xeroDeps(fetchImpl);
    const oversize = "A".repeat(XERO_ATTACHMENT_MAX_BASE64_CHARS + 4);
    const out = await call(
      "attach_file_to_bill",
      {
        invoiceId: BILL_ID,
        filename: "big.pdf",
        contentType: "application/pdf",
        contentBase64: oversize,
      },
      deps,
    );
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toMatch(/Invalid input: contentBase64/);
    expect(out.body.error).toMatch(/capped at 10 MiB/);
    // Refused at the shape step: Xero was never consulted.
    expect(requests).toHaveLength(0);
  });

  it("refuses a non-whitelisted content type at the schema (zip never reaches Xero)", async () => {
    const { fetchImpl, requests } = fakeXero();
    const { deps } = xeroDeps(fetchImpl);
    const out = await call(
      "attach_file_to_bill",
      {
        invoiceId: BILL_ID,
        filename: "x.zip",
        contentType: "application/zip",
        contentBase64: pdf,
      },
      deps,
    );
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toMatch(/Invalid input: contentType/);
    expect(requests).toHaveLength(0);
  });

  it("refuses a path-shaped filename at the schema", async () => {
    const { fetchImpl } = fakeXero();
    const { deps } = xeroDeps(fetchImpl);
    for (const filename of ["../../etc/passwd", "a/b.pdf", ".hidden"]) {
      const out = await call(
        "attach_file_to_bill",
        {
          invoiceId: BILL_ID,
          filename,
          contentType: "application/pdf",
          contentBase64: pdf,
        },
        deps,
      );
      expect(out.body.ok).toBe(false);
      expect(out.body.error).toMatch(/Invalid input: filename/);
    }
  });

  it("refuses attaching to a sales invoice (ACCREC) or a nonexistent invoice", async () => {
    const { fetchImpl, requests } = fakeXero();
    const { deps } = xeroDeps(fetchImpl);
    const sales = await call(
      "attach_file_to_bill",
      {
        invoiceId: SALES_ID,
        filename: "x.pdf",
        contentType: "application/pdf",
        contentBase64: pdf,
      },
      deps,
    );
    expect(sales.body.ok).toBe(false);
    expect(sales.body.error).toMatch(/only be added to bills/);

    const missing = await call(
      "attach_file_to_bill",
      {
        invoiceId: "00000000-0000-4000-8000-000000000000",
        filename: "x.pdf",
        contentType: "application/pdf",
        contentBase64: pdf,
      },
      deps,
    );
    expect(missing.body.ok).toBe(false);
    expect(missing.body.error).toMatch(/No invoice/);
    expect(requests.find((r) => r.method === "PUT")).toBeUndefined();
  });

  it("audits the file SIZE in the digest, never the bytes", async () => {
    const { fetchImpl } = fakeXero();
    const { deps, audits } = xeroDeps(fetchImpl);
    await call(
      "attach_file_to_bill",
      {
        invoiceId: BILL_ID,
        filename: "invoice.pdf",
        contentType: "application/pdf",
        contentBase64: pdf,
      },
      deps,
    );
    expect(audits[0].inputSummary).toMatchObject({
      invoiceId: BILL_ID,
      filename: "invoice.pdf",
      bytes: Buffer.from(pdf, "base64").length,
    });
    expect(JSON.stringify(audits[0].inputSummary)).not.toContain(pdf);
  });
});

describe("xero searches and contacts", () => {
  it("pins every bills search to ACCPAY and encodes the filters into the where clause", () => {
    expect(billsWhereClause({})).toBe('Type=="ACCPAY"');
    expect(
      billsWhereClause({
        contactName: "Acme",
        status: "DRAFT",
        dateFrom: "2026-07-01",
        dateTo: "2026-07-31",
        reference: "INV-1",
      }),
    ).toBe(
      'Type=="ACCPAY" AND Status=="DRAFT" AND Contact.Name.ToLower().Contains("acme") ' +
        'AND Reference=="INV-1" AND Date>=DateTime(2026,7,1) AND Date<=DateTime(2026,7,31)',
    );
  });

  it("refuses where-clause injection: quotes and backslashes never reach the query language", async () => {
    const { fetchImpl, requests } = fakeXero();
    const { deps } = xeroDeps(fetchImpl);
    const out = await call(
      "search_bills",
      { contactName: '") OR Type=="ACCREC" OR Contact.Name.Contains("' },
      deps,
    );
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toMatch(/Invalid input: contactName/);
    expect(requests).toHaveLength(0);
  });

  it("create_contact whitelists fields — bank-account details cannot ride through", async () => {
    const { fetchImpl, requests } = fakeXero();
    const { deps } = xeroDeps(fetchImpl);
    const out = await call(
      "create_contact",
      {
        name: "New Supplier",
        email: "ap@supplier.example",
        BankAccountDetails: "12-3456-7890123-00",
        bankAccountDetails: "12-3456-7890123-00",
      },
      deps,
    );
    expect(out.body.ok).toBe(true);
    const post = requests.find((r) => r.method === "POST")!;
    expect(JSON.stringify(post.body)).not.toContain("12-3456-7890123-00");
    expect(JSON.stringify(post.body)).not.toMatch(/BankAccount/i);
  });
});
