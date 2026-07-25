import { sendEmail } from "~/lib/email-client.server";
import { renderEmailVerificationEmail } from "./templates/email-verification";

type SendEmailVerificationOptions = {
  verificationUrl: string;
  userEmail: string;
};

export async function sendEmailVerification({
  verificationUrl,
  userEmail,
}: SendEmailVerificationOptions): Promise<void> {
  const html = await renderEmailVerificationEmail({
    verificationUrl,
    userEmail,
  });
  await sendEmail({
    to: userEmail,
    subject: "Verify your email to join a harnesst workspace",
    html,
  });
}
