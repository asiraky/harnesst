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

type OrganizationInvitationEmailProps = {
  invitationUrl: string;
  inviterEmail: string;
  inviterName: string;
  organizationName: string;
};

export default function OrganizationInvitationEmail({
  invitationUrl,
  inviterEmail,
  inviterName,
  organizationName,
}: OrganizationInvitationEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Join {organizationName} on harnesst</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Text style={styles.brand}>
            <span style={styles.brandAccent}>h</span>arnesst
          </Text>
          <Heading style={styles.heading}>Join {organizationName}</Heading>
          <Text style={styles.text}>
            {inviterName} ({inviterEmail}) invited you to join{" "}
            {organizationName} on harnesst.
          </Text>
          <Button href={invitationUrl} style={styles.button}>
            Accept invitation
          </Button>
          <Text style={styles.muted}>
            If you were not expecting this invitation, you can ignore this
            email.
          </Text>
          <Hr style={styles.rule} />
          <Text style={styles.footer}>
            If the button does not work, copy and paste this URL into your
            browser:
          </Text>
          <Text style={styles.link}>{invitationUrl}</Text>
        </Container>
      </Body>
    </Html>
  );
}

export function renderOrganizationInvitationEmail(
  props: OrganizationInvitationEmailProps,
): Promise<string> {
  return render(<OrganizationInvitationEmail {...props} />);
}
