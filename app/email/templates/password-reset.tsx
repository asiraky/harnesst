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

type PasswordResetEmailProps = {
  userEmail: string;
  resetUrl: string;
};

export default function PasswordResetEmail({
  userEmail,
  resetUrl,
}: PasswordResetEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Reset your harnesst password</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Text style={styles.brand}>
            <span style={styles.brandAccent}>h</span>arnesst
          </Text>
          <Heading style={styles.heading}>Reset your password</Heading>
          <Text style={styles.text}>
            We received a request to reset the password for {userEmail}. Use
            the button below to choose a new password.
          </Text>
          <Button href={resetUrl} style={styles.button}>
            Reset password
          </Button>
          <Text style={styles.muted}>
            If you did not request this, you can ignore this email. This link
            expires in one hour.
          </Text>
          <Hr style={styles.rule} />
          <Text style={styles.footer}>
            If the button does not work, copy and paste this URL into your
            browser:
          </Text>
          <Text style={styles.link}>{resetUrl}</Text>
        </Container>
      </Body>
    </Html>
  );
}

export function renderPasswordResetEmail(
  props: PasswordResetEmailProps,
): Promise<string> {
  return render(<PasswordResetEmail {...props} />);
}
