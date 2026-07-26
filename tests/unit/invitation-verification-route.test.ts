import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  handler: vi.fn(),
  dbUpdate: vi.fn(),
  dbWhere: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  requireSession: mocks.requireSession,
  sessionLoader: vi.fn(),
}));

vi.mock("~/lib/auth.server", () => ({
  auth: {
    api: {
      getInvitation: mocks.getInvitation,
      acceptInvitation: mocks.acceptInvitation,
    },
    handler: mocks.handler,
  },
}));

vi.mock("~/db/client.server", () => ({
  db: { update: mocks.dbUpdate },
}));

const EMAIL = "invitee@example.com";
const INVITATION_ID = "invitation-123";
const KEY = Buffer.alloc(32, 7);

function verificationRequest() {
  return new Request(
    `https://harnesst.example.com/accept-invitation/${INVITATION_ID}`,
    {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=test-cookie",
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://harnesst.example.com",
        "x-real-ip": "203.0.113.10",
      },
      body: new URLSearchParams({
        intent: "send-verification",
        invitationId: INVITATION_ID,
      }),
    },
  );
}

function actionArgs(request: Request) {
  return {
    request,
    url: new URL(request.url),
    pattern: "/accept-invitation/:invitationId",
    params: { invitationId: INVITATION_ID },
    context: {} as never,
  };
}

describe("invitation verification route", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.HARNESST_SECRETS_KEY = KEY.toString("hex");
    mocks.requireSession.mockReset().mockResolvedValue({
      user: { id: "user-1", email: EMAIL, emailVerified: false },
      requestHeaders: new Headers(),
    });
    mocks.getInvitation.mockReset().mockRejectedValue({
      body: { code: "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION" },
    });
    mocks.acceptInvitation.mockReset();
    mocks.handler.mockReset();
    mocks.dbWhere.mockReset().mockResolvedValue(undefined);
    mocks.dbUpdate.mockReset().mockImplementation(() => ({
      set: () => ({ where: mocks.dbWhere }),
    }));
  });

  it("sends through Better Auth's rate-limited handler endpoint", async () => {
    mocks.handler.mockResolvedValue(
      Response.json({ status: true }, { status: 200 }),
    );
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    await expect(action(actionArgs(verificationRequest()))).resolves.toEqual({
      verificationSent: true,
    });
    expect(mocks.handler).toHaveBeenCalledOnce();

    const forwarded = mocks.handler.mock.calls[0][0] as Request;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe(
      "https://harnesst.example.com/api/auth/send-verification-email",
    );
    expect(forwarded.headers.get("content-type")).toBe("application/json");
    expect(forwarded.headers.get("origin")).toBe("https://harnesst.example.com");
    expect(forwarded.headers.get("cookie")).toBe(
      "better-auth.session_token=test-cookie",
    );
    expect(forwarded.headers.get("x-real-ip")).toBe("203.0.113.10");
    await expect(forwarded.json()).resolves.toEqual({
      email: EMAIL,
      callbackURL: `https://harnesst.example.com/accept-invitation/${INVITATION_ID}`,
    });
  });

  it("surfaces Better Auth's endpoint throttle without sending again", async () => {
    mocks.handler.mockResolvedValue(
      Response.json(
        { message: "Too many requests. Please try again later." },
        { status: 429 },
      ),
    );
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    await expect(action(actionArgs(verificationRequest()))).resolves.toEqual({
      error:
        "Too many verification emails. Please wait a minute and try again.",
    });
    expect(mocks.handler).toHaveBeenCalledOnce();
  });

  it("does not expose an unexpected handler error", async () => {
    mocks.handler.mockRejectedValue(
      new Error("select token from verification where secret = $1"),
    );
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    await expect(action(actionArgs(verificationRequest()))).resolves.toEqual({
      error: "Could not send the verification email.",
    });
  });

  function acceptRequest(fields: Record<string, string>) {
    return new Request(
      `https://harnesst.example.com/accept-invitation/${INVITATION_ID}`,
      {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=test-cookie",
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://harnesst.example.com",
        },
        body: new URLSearchParams({
          invitationId: INVITATION_ID,
          ...fields,
        }),
      },
    );
  }

  async function mintToken(invitationId: string, email: string) {
    const { mintInvitationToken } = await import(
      "~/auth/invitation-token.server"
    );
    return mintInvitationToken(invitationId, email, KEY);
  }

  it("redeems an emailed delivery token as mailbox proof and accepts", async () => {
    mocks.acceptInvitation.mockResolvedValue({});
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    const request = acceptRequest({
      token: await mintToken(INVITATION_ID, EMAIL),
    });
    let response: Response | undefined;
    try {
      await action(actionArgs(request));
    } catch (error) {
      if (error instanceof Response) response = error;
      else throw error;
    }

    expect(mocks.dbUpdate).toHaveBeenCalledOnce();
    expect(mocks.dbWhere).toHaveBeenCalledOnce();
    expect(mocks.acceptInvitation).toHaveBeenCalledOnce();
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("/");
  });

  it("ignores a delivery token bound to a different invitation", async () => {
    mocks.acceptInvitation.mockRejectedValue({
      body: {
        code: "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION",
      },
      statusCode: 403,
    });
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    const request = acceptRequest({
      token: await mintToken("other-invitation", EMAIL),
    });
    const result = await action(actionArgs(request));

    expect(mocks.dbUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ verificationRequired: true });
  });

  it("ignores a delivery token minted for a different email address", async () => {
    mocks.acceptInvitation.mockRejectedValue({
      body: {
        code: "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION",
      },
      statusCode: 403,
    });
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    const request = acceptRequest({
      token: await mintToken(INVITATION_ID, "someone-else@example.com"),
    });
    const result = await action(actionArgs(request));

    expect(mocks.dbUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ verificationRequired: true });
  });

  it("does not touch the verified flag for an already-verified account", async () => {
    mocks.requireSession.mockResolvedValue({
      user: { id: "user-1", email: EMAIL, emailVerified: true },
      requestHeaders: new Headers(),
    });
    mocks.acceptInvitation.mockResolvedValue({});
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    const request = acceptRequest({
      token: await mintToken(INVITATION_ID, EMAIL),
    });
    let response: Response | undefined;
    try {
      await action(actionArgs(request));
    } catch (error) {
      if (error instanceof Response) response = error;
      else throw error;
    }

    expect(mocks.dbUpdate).not.toHaveBeenCalled();
    expect(response?.headers.get("location")).toBe("/");
  });
});
