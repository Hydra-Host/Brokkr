import { Body, Container, Head, Heading, Hr, Html, Link, Text } from '@react-email/components';
import { BRAND_NAME } from '../branding';

interface SupplierDeploymentProvisionSuccessEmailProps {
  orgName: string;
  deviceId: string;
  primaryIp: string;
  reservationType: 'Customer Rental' | 'Self-Provisioned';
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

export function SupplierDeploymentProvisionSuccessEmail({
  orgName,
  deviceId,
  primaryIp,
  reservationType,
  baseUrl,
}: SupplierDeploymentProvisionSuccessEmailProps) {
  return (
    <Html>
      <Head>
        <title>Server Successfully Provisioned - {BRAND_NAME}</title>
      </Head>

      <Body style={styles.body}>
        <Container style={styles.container}>
          <div>
            <Heading style={styles.heading}>Server Provisioned Successfully!</Heading>

            <Text style={styles.text}>Hi {orgName} Team,</Text>

            <Text style={styles.text}>
              Great news, your server has been successfully provisioned as {reservationType}.
            </Text>

            <Text style={styles.text}>
              • <strong>Device ID:</strong> {deviceId}
              <br />• <strong>IP:</strong> {primaryIp}
            </Text>

            <Text style={styles.text}>To view all devices in your {BRAND_NAME} inventory:</Text>

            <div style={styles.buttonWrapper}>
              <Link href={`${baseUrl}/dcim/devices`} style={styles.button}>
                View Devices
              </Link>
            </div>

            <Hr style={styles.hr} />

            <Text style={styles.text}>Best regards,</Text>

            <Text style={styles.signature}>The {BRAND_NAME} Team</Text>
          </div>
        </Container>
      </Body>
    </Html>
  );
}

export default function SupplierDeploymentProvisionSuccessEmailPreview() {
  return (
    <SupplierDeploymentProvisionSuccessEmail
      orgName="Acme Corp"
      deviceId="550e8400-e29b-41d4-a716-446655440000"
      primaryIp="192.168.1.100"
      reservationType="Customer Rental"
      baseUrl="https://example.com"
    />
  );
}
