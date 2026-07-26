import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  render,
  Text,
} from "@react-email/components";

import { emailStyles as styles } from "./styles";

type EmailVerificationEmailProps = {
  userEmail: string;
  verificationUrl: string;
};

export default function EmailVerificationEmail({
  userEmail,
  verificationUrl,
}: EmailVerificationEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Verify your email to join a harnesst workspace</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Text style={styles.brand}>
            <span style={styles.brandAccent}>h</span>arnesst
          </Text>
          <Heading style={styles.heading}>Verify your email</Heading>
          <Text style={styles.text}>
            Confirm that {userEmail} belongs to you before accepting the
            harnesst workspace invitation.
          </Text>
          <Button href={verificationUrl} style={styles.button}>
            Verify email
          </Button>
          <Text style={styles.muted}>
            If you were not trying to join a workspace, you can ignore this
            email. This link expires in one hour.
          </Text>
          <Hr style={styles.rule} />
          <Text style={styles.footer}>
            If the button does not work, copy and paste this URL into your
            browser:
          </Text>
          <Text style={styles.link}>{verificationUrl}</Text>
        </Container>
      </Body>
    </Html>
  );
}

export function renderEmailVerificationEmail(
  props: EmailVerificationEmailProps,
): Promise<string> {
  return render(<EmailVerificationEmail {...props} />);
}
