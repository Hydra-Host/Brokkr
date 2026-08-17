import { Body, Container, Head, Heading, Html, Text } from '@react-email/components';
import { formatMilliseconds } from 'src/utils/time-conversions';
import { BRAND_NAME } from '../branding';

interface InterruptionQueuedEmailProps {
  deploymentName: string;
  deviceId: string;
  delayInMs: number;
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

export function InterruptionQueuedEmail({ deploymentName, deviceId, delayInMs }: InterruptionQueuedEmailProps) {
  return (
    <Html>
      <Head>
        <title>Interruption Request Queued on {BRAND_NAME}</title>
      </Head>

      <Body style={styles.body}>
        <Container style={styles.container}>
          <div>
            <Heading style={styles.heading}>Interruption Request Queued ⏳</Heading>

            <Text style={styles.text}>
              Your interruption request has been issued. Provisioning will begin in approximately{' '}
              {formatMilliseconds(delayInMs)}.
            </Text>

            <Text style={styles.text}>
              <strong>Deployment Name:</strong> {deploymentName}
            </Text>

            <Text style={styles.text}>
              <strong>Device ID:</strong> {deviceId}
            </Text>

            <Text style={styles.text}>We will notify you again once provisioning has started.</Text>

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

export default function InterruptionQueuedEmailPreview() {
  return <InterruptionQueuedEmail deploymentName="my-gpu-deployment" deviceId={'123'} delayInMs={7200000} />;
}
