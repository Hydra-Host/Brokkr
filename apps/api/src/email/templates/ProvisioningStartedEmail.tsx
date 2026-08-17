import { Body, Container, Head, Heading, Html, Link, Text } from '@react-email/components';
import { BRAND_NAME } from '../branding';

interface ProvisioningStartedEmailProps {
  deploymentName: string;
  deploymentId: string;
  baseUrl: string;
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

export function ProvisioningStartedEmail({ deploymentName, deploymentId, baseUrl }: ProvisioningStartedEmailProps) {
  return (
    <Html>
      <Head>
        <title>Provisioning Started on {BRAND_NAME}</title>
      </Head>

      <Body style={styles.body}>
        <Container style={styles.container}>
          <div>
            <Heading style={styles.heading}>Provisioning Started 🚀</Heading>

            <Text style={styles.text}>
              <strong>Deployment Name:</strong> {deploymentName}
            </Text>

            <Text style={styles.text}>
              <strong>Deployment ID:</strong> {deploymentId}
            </Text>

            <div style={styles.buttonWrapper}>
              <Link href={`${baseUrl}/deployments/${deploymentId}`} style={styles.button}>
                View Deployment Details
              </Link>
            </div>

            <Text style={styles.text}>
              If you have any questions, please don't hesitate to reach out to our support team through your{' '}
              {BRAND_NAME} dashboard.
            </Text>

            <Text style={styles.signature}>- The {BRAND_NAME} Team</Text>
          </div>
        </Container>
      </Body>
    </Html>
  );
}

export default function ProvisioningStartedEmailPreview() {
  return (
    <ProvisioningStartedEmail deploymentName="my-gpu-deployment" deploymentId="abc-123" baseUrl="https://example.com" />
  );
}
