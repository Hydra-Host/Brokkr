import { Body, Container, Head, Heading, Html, Text } from '@react-email/components';
import { formatMilliseconds } from 'src/utils/time-conversions';
import { BRAND_NAME } from '../branding';

interface InterriptubleInitiatedEmailProps {
  deploymentName: string;
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

export function InterruptibleInitiatedEmail({ deploymentName, delayInMs }: InterriptubleInitiatedEmailProps) {
  return (
    <Html>
      <Head>
        <title>Deployment Interruption Notice on {BRAND_NAME}</title>
      </Head>

      <Body style={styles.body}>
        <Container style={styles.container}>
          <div>
            <Heading style={styles.heading}>Deployment Interruption Notice 🗑️</Heading>

            <Text style={styles.text}>
              {`A deployment will be deleted from your ${BRAND_NAME} account in approximately ${formatMilliseconds(delayInMs)}`}
            </Text>

            <Text style={styles.text}>
              <strong>Deployment Name:</strong> {deploymentName}
            </Text>

            <Text style={styles.text}>
              If you have any questions or concerns about this deletion, please don't hesitate to reach out to our
              support team through your {BRAND_NAME} dashboard.
            </Text>

            <Text style={styles.signature}>- The {BRAND_NAME} Team</Text>
          </div>
        </Container>
      </Body>
    </Html>
  );
}

export default function InterruptibleInitiatedEmailPreview() {
  return <InterruptibleInitiatedEmail deploymentName="Beta Server Cluster" delayInMs={50000} />;
}
