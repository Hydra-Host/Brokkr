import { Body, Container, Heading, Hr, Html, Text } from '@react-email/components';
import { BRAND_NAME } from '../branding';

interface EmailVerificationEmailProps {
  code: string;
  expirationDate: string;
  firstName: string;
}

const styles = {
  body: {
    backgroundColor: 'white',
    color: 'black',
    fontFamily: 'sans-serif',
  },
  container: {
    padding: '32px',
  },
  heading: {
    fontSize: '30px',
    fontWeight: 'bold',
    marginBottom: '16px',
  },
  text: {
    marginBottom: '8px',
  },
  code: {
    fontSize: '36px',
    fontWeight: 'bold',
    color: '#5A4CFF',
    textAlign: 'center' as const,
    padding: '16px',
    margin: '24px 0',
    backgroundColor: '#f0f0f0',
    borderRadius: '8px',
  },
  hr: {
    margin: '24px 0',
  },
  signature: {
    color: '',
    fontSize: '20px',
    fontWeight: 'bold',
  },
};

export function EmailVerificationEmail({ code, expirationDate, firstName }: EmailVerificationEmailProps) {
  return (
    <Html>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <div>
            <Heading style={styles.heading}>Please Verify Your Email 🔐</Heading>

            <Text style={styles.text}>Hello {firstName},</Text>

            <Text style={styles.text}>
              This email was recently used with {BRAND_NAME}. Please verify your account with the following two factor
              authentication code:
            </Text>

            <div style={styles.code}>{code}</div>

            <Text style={styles.text}>
              This code will expire on {expirationDate}. If you didn't request this code, please ignore this email.
            </Text>

            <Hr style={styles.hr} />

            <Text style={styles.text}>
              For security reasons, never share this code with anyone. The {BRAND_NAME} team will never ask for your 2FA
              code.
            </Text>

            <Text style={styles.text}>
              If you're having trouble logging in or have any questions, please don't hesitate to contact our support
              team.
            </Text>

            <Text style={styles.signature}>- The {BRAND_NAME} Team</Text>
          </div>
        </Container>
      </Body>
    </Html>
  );
}

export default function EmailVerificationEmailPreview() {
  return <EmailVerificationEmail code="123456" firstName="Alex" expirationDate="June 15, 2023 at 3:45 PM UTC" />;
}
