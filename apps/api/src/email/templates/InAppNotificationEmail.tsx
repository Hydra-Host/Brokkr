import { Body, Container, Head, Heading, Html, Link, Text } from '@react-email/components';
import { BRAND_NAME } from '../branding';

interface InAppNotificationEmailProps {
  title: string;
  body: string;
  linkUrl?: string;
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
  button: {
    backgroundColor: '#5A4CFF',
    color: 'white',
    padding: '8px 24px',
    borderRadius: '8px',
    fontWeight: 'bold',
    fontSize: '12px',
    display: 'inline-block',
    textDecoration: 'none',
  },
  buttonWrapper: {
    marginTop: '24px',
  },
  signature: {
    fontSize: '20px',
    fontWeight: 'bold',
  },
};

export function InAppNotificationEmail({ title, body, linkUrl }: InAppNotificationEmailProps) {
  return (
    <Html>
      <Head>
        <title>
          {title} — {BRAND_NAME}
        </title>
      </Head>

      <Body style={styles.body}>
        <Container style={styles.container}>
          <div>
            <Heading style={styles.heading}>{title}</Heading>

            <Text style={styles.text}>{body}</Text>

            {linkUrl ? (
              <div style={styles.buttonWrapper}>
                <Link href={linkUrl} style={styles.button}>
                  Open in {BRAND_NAME}
                </Link>
              </div>
            ) : null}

            <Text style={styles.signature}>- The {BRAND_NAME} Team</Text>
          </div>
        </Container>
      </Body>
    </Html>
  );
}

export default function InAppNotificationEmailPreview() {
  return (
    <InAppNotificationEmail
      title="New provisioning request awaiting approval"
      body="A provisioning request is awaiting your approval."
      linkUrl="https://example.com/plugins/operator-hub/provision-approvals"
    />
  );
}
