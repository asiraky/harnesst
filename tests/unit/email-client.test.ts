import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  postmarkSend: vi.fn(),
  smtpSend: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: mocks.createTransport,
  },
}));

vi.mock("postmark", () => ({
  ServerClient: class {
    sendEmail = mocks.postmarkSend;
  },
  Models: { LinkTrackingOptions: { None: "None" } },
}));

const saved = {
  NODE_ENV: process.env.NODE_ENV,
  SMTP_URL: process.env.SMTP_URL,
  POSTMARK_SERVER_TOKEN: process.env.POSTMARK_SERVER_TOKEN,
  FROM_EMAIL: process.env.FROM_EMAIL,
  MAILBOX_DIR: process.env.MAILBOX_DIR,
};

function restore(name: keyof typeof saved) {
  const value = saved[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function freshClient() {
  vi.resetModules();
  return import("~/lib/email-client.server");
}

describe("transactional email client", () => {
  beforeEach(() => {
    mocks.createTransport.mockReset();
    mocks.postmarkSend.mockReset();
    mocks.smtpSend.mockReset();
    mocks.createTransport.mockReturnValue({ sendMail: mocks.smtpSend });
    delete process.env.SMTP_URL;
    delete process.env.POSTMARK_SERVER_TOKEN;
    delete process.env.FROM_EMAIL;
    delete process.env.MAILBOX_DIR;
  });

  afterEach(() => {
    restore("NODE_ENV");
    restore("SMTP_URL");
    restore("POSTMARK_SERVER_TOKEN");
    restore("FROM_EMAIL");
    restore("MAILBOX_DIR");
    vi.restoreAllMocks();
  });

  it("uses development SMTP ahead of Postmark for local email capture", async () => {
    process.env.NODE_ENV = "development";
    process.env.SMTP_URL = "smtp://127.0.0.1:1025";
    process.env.POSTMARK_SERVER_TOKEN = "postmark-token";
    process.env.FROM_EMAIL = "harnesst <noreply@example.com>";
    const { sendEmail } = await freshClient();

    await sendEmail({
      to: "member@example.com",
      subject: "Invite",
      html: "<p>Join</p>",
    });

    expect(mocks.createTransport).toHaveBeenCalledWith("smtp://127.0.0.1:1025");
    expect(mocks.smtpSend).toHaveBeenCalledWith({
      from: "harnesst <noreply@example.com>",
      to: "member@example.com",
      subject: "Invite",
      html: "<p>Join</p>",
    });
    expect(mocks.postmarkSend).not.toHaveBeenCalled();
  });

  it("maps production messages to Postmark", async () => {
    process.env.NODE_ENV = "production";
    process.env.POSTMARK_SERVER_TOKEN = "postmark-token";
    process.env.FROM_EMAIL = "harnesst <noreply@example.com>";
    const { sendEmail } = await freshClient();

    await sendEmail({
      to: "person@example.com",
      subject: "Reset",
      html: "<p>Reset</p>",
    });

    expect(mocks.postmarkSend).toHaveBeenCalledWith({
      From: "harnesst <noreply@example.com>",
      To: "person@example.com",
      Subject: "Reset",
      HtmlBody: "<p>Reset</p>",
      TrackLinks: "None",
      TrackOpens: false,
    });
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it("fails during production startup when Postmark is not configured", async () => {
    process.env.NODE_ENV = "production";
    await expect(freshClient()).rejects.toThrow(
      "POSTMARK_SERVER_TOKEN is required in production.",
    );
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.postmarkSend).not.toHaveBeenCalled();
  });

  it("is a nonthrowing no-op when no development provider is configured", async () => {
    process.env.NODE_ENV = "development";
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { sendEmail } = await freshClient();

    await expect(
      sendEmail({
        to: "person@example.com",
        subject: "Reset",
        html: "<p>Reset</p>",
      }),
    ).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.postmarkSend).not.toHaveBeenCalled();
  });

  describe("MAILBOX_DIR file mailbox", () => {
    let baseDir: string;

    beforeEach(async () => {
      baseDir = await mkdtemp(join(tmpdir(), "harnesst-mailbox-"));
    });

    afterEach(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it("writes each email to a JSON file, creating the directory", async () => {
      process.env.NODE_ENV = "development";
      // Nested + nonexistent to verify the recursive mkdir.
      process.env.MAILBOX_DIR = join(baseDir, "nested", "mailbox");
      const { sendEmail } = await freshClient();

      await sendEmail({
        to: "invitee@example.com",
        subject: "Invite",
        html: "<p>Join</p>",
      });

      const files = await readdir(process.env.MAILBOX_DIR);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d+-[a-z0-9]+\.json$/);
      const body = JSON.parse(
        await readFile(join(process.env.MAILBOX_DIR, files[0]), "utf8"),
      );
      expect(body).toEqual({
        to: "invitee@example.com",
        subject: "Invite",
        html: "<p>Join</p>",
      });
      expect(mocks.createTransport).not.toHaveBeenCalled();
      expect(mocks.postmarkSend).not.toHaveBeenCalled();
    });

    it("wins over SMTP_URL in non-production", async () => {
      process.env.NODE_ENV = "development";
      process.env.MAILBOX_DIR = baseDir;
      process.env.SMTP_URL = "smtp://127.0.0.1:1025";
      process.env.POSTMARK_SERVER_TOKEN = "postmark-token";
      const { sendEmail } = await freshClient();

      await sendEmail({
        to: "member@example.com",
        subject: "Invite",
        html: "<p>Join</p>",
      });

      expect(await readdir(baseDir)).toHaveLength(1);
      expect(mocks.createTransport).not.toHaveBeenCalled();
      expect(mocks.smtpSend).not.toHaveBeenCalled();
      expect(mocks.postmarkSend).not.toHaveBeenCalled();
    });

    it("is ignored in production: Postmark is still chosen", async () => {
      process.env.NODE_ENV = "production";
      process.env.MAILBOX_DIR = baseDir;
      process.env.POSTMARK_SERVER_TOKEN = "postmark-token";
      process.env.FROM_EMAIL = "harnesst <noreply@example.com>";
      const { sendEmail } = await freshClient();

      await sendEmail({
        to: "person@example.com",
        subject: "Reset",
        html: "<p>Reset</p>",
      });

      expect(mocks.postmarkSend).toHaveBeenCalledTimes(1);
      expect(await readdir(baseDir)).toHaveLength(0);
    });

    it("is ignored in production: startup still fails without Postmark", async () => {
      process.env.NODE_ENV = "production";
      process.env.MAILBOX_DIR = baseDir;
      await expect(freshClient()).rejects.toThrow(
        "POSTMARK_SERVER_TOKEN is required in production.",
      );
      expect(await readdir(baseDir)).toHaveLength(0);
    });
  });
});
