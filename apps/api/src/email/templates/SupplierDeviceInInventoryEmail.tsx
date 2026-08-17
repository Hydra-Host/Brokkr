import { Body, Container, Head, Heading, Hr, Html, Link, Text } from '@react-email/components';
import { BRAND_NAME } from '../branding';

interface SupplierDeviceInInventoryEmailProps {
  orgName: string;
  deviceId: string;
  primaryIp: string;
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
    color: '#FFFFFF !important',
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
  signature: {
    color: '',
    fontSize: '20px',
    fontWeight: 'bold',
  },
};

export function SupplierDeviceInInventoryEmail({
  orgName,
  deviceId,
  primaryIp,
  baseUrl,
}: SupplierDeviceInInventoryEmailProps) {
  return (
    <Html>
      <Head>
        <title>Device Moved to Inventory - {BRAND_NAME}</title>
      </Head>

      <Body style={styles.body}>
        <Container style={styles.container}>
          <div>
            <Heading style={styles.heading}>Device Available for Rental</Heading>

            <Text style={styles.text}>Hi {orgName} Team,</Text>

            <Text style={styles.text}>
              Just a heads up, your server has just been moved to Inventory status and is available to be rented out.
            </Text>

            <Text style={styles.text}>
              • <strong>Device ID:</strong> {deviceId}
              <br />• <strong>IP:</strong> {primaryIp}
            </Text>

            <Text style={styles.text}>
              If this is the first time we're listing this server, please log in to your inventory, add listing price
              and turn Monetization flag on.
            </Text>

            <div style={styles.buttonWrapper}>
              <Link href={`${baseUrl}/dcim/devices/${deviceId}/settings`} style={styles.button}>
                Update Monetization
              </Link>
            </div>

            <Text style={styles.text}>
              If this server has been previously rented, now is a great time to review the listing price to keep it up
              to date - the device is already ready to be rented.
            </Text>

            <Hr style={styles.hr} />

            <Text style={styles.text}>Best regards,</Text>

            <Text style={styles.signature}>The {BRAND_NAME} Team</Text>
          </div>
        </Container>
      </Body>
    </Html>
  );
}

export default function SupplierDeviceInInventoryEmailPreview() {
  return (
    <SupplierDeviceInInventoryEmail
      orgName="Acme Corp"
      deviceId="550e8400-e29b-41d4-a716-446655440000"
      primaryIp="192.168.1.100"
      baseUrl="https://example.com"
    />
  );
}
