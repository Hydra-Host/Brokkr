import { Body, Container, Heading, Hr, Html, Link, Text } from '@react-email/components';
import { BRAND_NAME } from '../branding';

interface MagicPasswordLinkEmailProps {
  expirationInMinutes: string;
  firstName: string;
  magicLinkUrl: string;
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
  buttonWrapper: {
    marginTop: '24px',
    textAlign: 'center' as const,
  },
  button: {
    backgroundColor: '#5A4CFF',
    color: 'white',
    padding: '8px 24px',
    borderRadius: '8px',
    fontWeight: 'bold',
    fontSize: '12px',
    display: 'inline-block',
    textDecoration: 'none',
    width: '200px',
  },
  hr: {
    margin: '24px 0',
  },
  signature: {
    color: '',
    fontSize: '12px',
    fontWeight: 'bold',
  },
};

export function MagicPasswordLinkEmail({ magicLinkUrl, expirationInMinutes, firstName }: MagicPasswordLinkEmailProps) {
  return (
    <Html>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <div>
            <Heading style={styles.heading}>Your magic link is here!</Heading>

            <Text style={styles.text}>{firstName ? `Hello ${firstName},` : 'Hello,'}</Text>

            <Text style={styles.text}>
              This email was recently used with {BRAND_NAME}. Please verify your account by clicking the following magic
              link:
            </Text>

            <div style={styles.buttonWrapper}>
              <Link href={magicLinkUrl} style={styles.button}>
                Magic link
              </Link>
              <Text style={styles.text}>{magicLinkUrl}</Text>
            </div>

            <Text style={styles.text}>
              This link will be valid for {expirationInMinutes} minutes. If you didn’t request this code, please ignore
              this emal.
            </Text>

            <Hr style={styles.hr} />

            <Text style={styles.text}>
              If you’re having trouble logging in or have any questions, please don’t hesitate to contact our support
              team.
            </Text>

            <Text style={styles.signature}>The {BRAND_NAME} Team</Text>
          </div>
        </Container>
      </Body>
    </Html>
  );
}

export default function MagicPasswordLinkEmailPreview() {
  return (
    <MagicPasswordLinkEmail magicLinkUrl="https://example.com/magic-link" expirationInMinutes="30" firstName="Alex" />
  );
}
