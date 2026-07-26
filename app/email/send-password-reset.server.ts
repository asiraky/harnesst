import { sendEmail } from "~/lib/email-client.server";
import { renderPasswordResetEmail } from "./templates/password-reset";

type SendPasswordResetEmailOptions = {
  resetUrl: string;
  userEmail: string;
};

export async function sendPasswordResetEmail({
  resetUrl,
  userEmail,
}: SendPasswordResetEmailOptions): Promise<void> {
  const html = await renderPasswordResetEmail({ resetUrl, userEmail });
  await sendEmail({
    to: userEmail,
    subject: "Reset your harnesst password",
    html,
  });
}
