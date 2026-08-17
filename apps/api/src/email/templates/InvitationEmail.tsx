import { Body, Container, Head, Heading, Html, Link, Text } from '@react-email/components';
import { BRAND_NAME } from '../branding';

interface InvitationEmailProps {
  baseUrl: string;
  inviterName: string;
  organizationName: string;
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
  hr: {
    margin: '24px 0',
  },
  link: {
    color: '#5A4CFF',
    fontWeight: 'bold',
  },
  signature: {
    color: '',
    fontSize: '20px',
    fontWeight: 'bold',
  },
};

export function InvitationEmail({ baseUrl, inviterName, organizationName }: InvitationEmailProps) {
  return (
    <Html>
      <Head>
        <title>
          You're invited to join {organizationName} on {BRAND_NAME}!
        </title>
      </Head>

      <Body style={styles.body}>
        <Container style={styles.container}>
          <div>
            <Heading style={styles.heading}>Join your team on {BRAND_NAME}! 🎉</Heading>

            <Text style={styles.text}>
              {inviterName} has invited you to join {organizationName} on {BRAND_NAME}.
            </Text>

            <Text style={styles.text}>
              With {BRAND_NAME}, you can collaborate with your team to manage deployments, explore our inventory, and
              oversee your infrastructure efficiently.
            </Text>

            <div style={styles.buttonWrapper}>
              <Link href={`${baseUrl}/login`} style={styles.button}>
                Accept Invitation
              </Link>
            </div>

            <Text style={styles.text}>
              If you have any questions about this invitation, please contact {inviterName} or reach out to our support
              team.
            </Text>

            <Text style={styles.signature}>- The {BRAND_NAME} Team</Text>
          </div>
        </Container>
      </Body>
    </Html>
  );
}

export default function InvitationEmailPreview() {
  return <InvitationEmail baseUrl="http://localhost:3000" inviterName="Alice" organizationName="Acme Corp" />;
}
