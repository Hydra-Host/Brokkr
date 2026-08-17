import { Body, Container, Heading, Hr, Html, Link, Text } from '@react-email/components';
import { BRAND_NAME } from '../branding';

interface ForgotPasswordEmailProps {
  firstName: string;
  url: string;
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

export function ForgotPasswordEmailEmail({ url, firstName }: ForgotPasswordEmailProps) {
  return (
    <Html>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <div>
            <Heading style={styles.heading}>Reset your password</Heading>

            <Text style={styles.text}>Hello {firstName}</Text>

            <Text style={styles.text}>
              A request was recently made to reset your password. Please click the following link to reset your
              password:
            </Text>

            <div style={styles.buttonWrapper}>
              <Link href={url} style={styles.button}>
                Reset password
              </Link>
              <Text style={styles.text}>{url}</Text>
            </div>

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

export default function ForgotPasswordEmailEmailPreview() {
  return <ForgotPasswordEmailEmail url="https://example.com/reset-password" firstName="Alex" />;
}
