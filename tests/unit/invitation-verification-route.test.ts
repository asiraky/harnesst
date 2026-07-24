import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getSessionAuth: vi.fn(),
  getInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  signOut: vi.fn(),
  handler: vi.fn(),
  dbUpdate: vi.fn(),
  dbWhere: vi.fn(),
  dbSelect: vi.fn(),
  dbSelectLimit: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  requireSession: mocks.requireSession,
  getSessionAuth: mocks.getSessionAuth,
  signupPath: (_request: Request, returnTo: string) =>
    `/signup?returnTo=${encodeURIComponent(returnTo)}`,
  sessionLoader: vi.fn(),
}));

vi.mock("~/lib/auth.server", () => ({
  auth: {
    api: {
      getInvitation: mocks.getInvitation,
      acceptInvitation: mocks.acceptInvitation,
      signOut: mocks.signOut,
    },
    handler: mocks.handler,
  },
}));

vi.mock("~/db/client.server", () => ({
  db: { update: mocks.dbUpdate, select: mocks.dbSelect },
}));

const EMAIL = "invitee@example.com";
const OTHER_EMAIL = "someone-else@example.com";
const INVITATION_ID = "invitation-123";
const KEY = Buffer.alloc(32, 7);

function verificationRequest() {
  return new Request(
    `https://eden.example.com/accept-invitation/${INVITATION_ID}`,
    {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=test-cookie",
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://eden.example.com",
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
    process.env.EDEN_SECRETS_KEY = KEY.toString("hex");
    const session = {
      user: { id: "user-1", email: EMAIL, emailVerified: false },
      requestHeaders: new Headers(),
    };
    mocks.requireSession.mockReset().mockResolvedValue(session);
    mocks.getSessionAuth.mockReset().mockResolvedValue(session);
    mocks.getInvitation.mockReset().mockRejectedValue({
      body: { code: "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION" },
    });
    mocks.acceptInvitation.mockReset();
    mocks.signOut.mockReset().mockResolvedValue(
      new Response(null, {
        headers: { "set-cookie": "better-auth.session_token=; Max-Age=0" },
      }),
    );
    mocks.handler.mockReset();
    mocks.dbWhere.mockReset().mockResolvedValue(undefined);
    mocks.dbUpdate.mockReset().mockImplementation(() => ({
      set: () => ({ where: mocks.dbWhere }),
    }));
    // No account exists for the invited address unless a test says otherwise.
    mocks.dbSelectLimit.mockReset().mockResolvedValue([]);
    mocks.dbSelect.mockReset().mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: mocks.dbSelectLimit }) }),
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
      "https://eden.example.com/api/auth/send-verification-email",
    );
    expect(forwarded.headers.get("content-type")).toBe("application/json");
    expect(forwarded.headers.get("origin")).toBe("https://eden.example.com");
    expect(forwarded.headers.get("cookie")).toBe(
      "better-auth.session_token=test-cookie",
    );
    expect(forwarded.headers.get("x-real-ip")).toBe("203.0.113.10");
    await expect(forwarded.json()).resolves.toEqual({
      email: EMAIL,
      callbackURL: `https://eden.example.com/accept-invitation/${INVITATION_ID}`,
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
      `https://eden.example.com/accept-invitation/${INVITATION_ID}`,
      {
        method: "POST",
        headers: {
          cookie: "better-auth.session_token=test-cookie",
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://eden.example.com",
        },
        body: new URLSearchParams({
          invitationId: INVITATION_ID,
          ...fields,
        }),
      },
    );
  }

  async function mintToken(invitationId: string, email: string) {
    const { mintInvitationToken } =
      await import("~/auth/invitation-token.server");
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

  async function expectResponse(run: () => Promise<unknown>) {
    try {
      await run();
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
    throw new Error("expected a Response to be thrown");
  }

  it("signs the wrong account out rather than accepting for it (issue #220)", async () => {
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    // The token names OTHER_EMAIL; the session is EMAIL. Better Auth would reject this outright,
    // so end the session and hand the invitee a sign-in for the address the invite is for.
    const request = acceptRequest({
      token: await mintToken(INVITATION_ID, OTHER_EMAIL),
    });
    const response = await expectResponse(() => action(actionArgs(request)));

    expect(mocks.acceptInvitation).not.toHaveBeenCalled();
    // Never redeem a foreign token as this account's mailbox proof.
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!, "http://x");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("email")).toBe(OTHER_EMAIL);
    expect(location.searchParams.get("returnTo")).toContain(
      `/accept-invitation/${INVITATION_ID}`,
    );
    // The sign-out cookie deletion has to ride along or the redirect lands signed in again.
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("offers the account switch when Better Auth rejects the recipient", async () => {
    mocks.acceptInvitation.mockRejectedValue({
      body: { code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION" },
      statusCode: 403,
    });
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    // No delivery token, so the mismatch only surfaces from Better Auth's own check.
    const result = await action(actionArgs(acceptRequest({})));

    expect(result).toEqual({ wrongAccount: true });
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("switch-account signs out and returns to the invitation", async () => {
    const { action } = await import("~/routes/accept-invitation.$invitationId");

    const token = await mintToken(INVITATION_ID, OTHER_EMAIL);
    const response = await expectResponse(() =>
      action(actionArgs(acceptRequest({ intent: "switch-account", token }))),
    );

    expect(mocks.signOut).toHaveBeenCalledOnce();
    const location = new URL(response.headers.get("location")!, "http://x");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("email")).toBe(OTHER_EMAIL);
    // The token has to survive the round-trip, or the invitee has to verify by email instead.
    expect(location.searchParams.get("returnTo")).toBe(
      `/accept-invitation/${INVITATION_ID}?token=${encodeURIComponent(token)}`,
    );
  });

  describe("signed-out routing", () => {
    function loaderArgs(search = "") {
      const request = new Request(
        `https://eden.example.com/accept-invitation/${INVITATION_ID}${search}`,
      );
      return {
        request,
        url: new URL(request.url),
        pattern: "/accept-invitation/:invitationId",
        params: { invitationId: INVITATION_ID },
        context: {} as never,
      };
    }

    beforeEach(() => {
      mocks.getSessionAuth.mockResolvedValue({
        user: null,
        session: null,
        organizationId: null,
      });
    });

    it("sends an invitee who already has an account to sign-in", async () => {
      mocks.dbSelectLimit.mockResolvedValue([{ id: "user-9" }]);
      const { loader } =
        await import("~/routes/accept-invitation.$invitationId");

      const token = await mintToken(INVITATION_ID, EMAIL);
      const response = await expectResponse(() =>
        loader(loaderArgs(`?token=${encodeURIComponent(token)}`)),
      );

      const location = new URL(response.headers.get("location")!, "http://x");
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("email")).toBe(EMAIL);
      expect(location.searchParams.get("returnTo")).toBe(
        `/accept-invitation/${INVITATION_ID}?token=${token}`,
      );
    });

    it("sends a brand-new invitee to sign-up with the address prefilled", async () => {
      const { loader } =
        await import("~/routes/accept-invitation.$invitationId");

      const token = await mintToken(INVITATION_ID, EMAIL);
      const response = await expectResponse(() =>
        loader(loaderArgs(`?token=${encodeURIComponent(token)}`)),
      );

      const location = new URL(response.headers.get("location")!, "http://x");
      expect(location.pathname).toBe("/signup");
      expect(location.searchParams.get("email")).toBe(EMAIL);
    });

    it("does not answer the account question without a valid delivery token", async () => {
      mocks.dbSelectLimit.mockResolvedValue([{ id: "user-9" }]);
      const { loader } =
        await import("~/routes/accept-invitation.$invitationId");

      // An enumerable invitation id alone must not become an account-existence oracle.
      const response = await expectResponse(() => loader(loaderArgs()));

      const location = new URL(response.headers.get("location")!, "http://x");
      expect(location.pathname).toBe("/signup");
      expect(location.searchParams.get("email")).toBeNull();
      expect(mocks.dbSelect).not.toHaveBeenCalled();
    });

    it("does not answer it for a token bound to another invitation either", async () => {
      mocks.dbSelectLimit.mockResolvedValue([{ id: "user-9" }]);
      const { loader } =
        await import("~/routes/accept-invitation.$invitationId");

      const token = await mintToken("other-invitation", EMAIL);
      const response = await expectResponse(() =>
        loader(loaderArgs(`?token=${encodeURIComponent(token)}`)),
      );

      expect(
        new URL(response.headers.get("location")!, "http://x").pathname,
      ).toBe("/signup");
      expect(mocks.dbSelect).not.toHaveBeenCalled();
    });
  });

  it("shows the account-switch screen to a signed-in stranger", async () => {
    const { loader } = await import("~/routes/accept-invitation.$invitationId");

    const token = await mintToken(INVITATION_ID, OTHER_EMAIL);
    const request = new Request(
      `https://eden.example.com/accept-invitation/${INVITATION_ID}?token=${encodeURIComponent(token)}`,
    );
    const result = await loader({
      request,
      url: new URL(request.url),
      pattern: "/accept-invitation/:invitationId",
      params: { invitationId: INVITATION_ID },
      context: {} as never,
    });

    expect(result).toMatchObject({
      wrongAccount: true,
      invitedEmail: OTHER_EMAIL,
    });
    // A GET must not end a session as a side effect — the switch is an explicit POST.
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.getInvitation).not.toHaveBeenCalled();
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
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
