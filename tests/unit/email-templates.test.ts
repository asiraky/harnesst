import { describe, expect, it } from "vitest";

import { renderEmailVerificationEmail } from "~/email/templates/email-verification";
import { renderOrganizationInvitationEmail } from "~/email/templates/organization-invitation";
import { renderPasswordResetEmail } from "~/email/templates/password-reset";

describe("transactional email templates", () => {
  it("renders the Better Auth password-reset URL and account context", async () => {
    const resetUrl =
      "https://eden.example.com/api/auth/reset-password/reset-token?callbackURL=https%3A%2F%2Feden.example.com%2Freset-password";
    const html = await renderPasswordResetEmail({
      userEmail: "person@example.com",
      resetUrl,
    });

    expect(html).toContain("Reset your password");
    expect(html).toContain("person@example.com");
    expect(html).toContain("reset-token");
    expect(html).toContain("expires in one hour");
  });

  it("renders the organization invitation with inviter and workspace context", async () => {
    const html = await renderOrganizationInvitationEmail({
      invitationUrl: "https://eden.example.com/accept-invitation/invite-id",
      inviterEmail: "owner@example.com",
      inviterName: "Olivia Owner",
      organizationName: "harnesst Team",
    });

    expect(html).toContain("Join harnesst Team");
    expect(html).toContain("Olivia Owner");
    expect(html).toContain("owner@example.com");
    expect(html).toContain("/accept-invitation/invite-id");
  });

  it("renders the Better Auth verification URL for invitation recipients", async () => {
    const verificationUrl =
      "https://eden.example.com/api/auth/verify-email?token=verification-token&callbackURL=https%3A%2F%2Feden.example.com%2Faccept-invitation%2Finvite-id";
    const html = await renderEmailVerificationEmail({
      userEmail: "invitee@example.com",
      verificationUrl,
    });

    expect(html).toContain("Verify your email");
    expect(html).toContain("invitee@example.com");
    expect(html).toContain("verification-token");
    expect(html).toContain("expires in one hour");
  });
});
