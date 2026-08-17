import { Body, Container, Head, Heading, Html, Link, Text } from '@react-email/components';
import { BRAND_NAME } from '../branding';

interface ReservationInvitationEmailProps {
  baseUrl: string;
  reservationEndDate: string;
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

export function ReservationInvitationEmail({ baseUrl, reservationEndDate }: ReservationInvitationEmailProps) {
  return (
    <Html>
      <Head>
        <title>You've been sent a device reservation!</title>
      </Head>

      <Body style={styles.body}>
        <Container style={styles.container}>
          <div>
            <Heading style={styles.heading}>Accept your reservation on {BRAND_NAME}! 🎉</Heading>

            <Text style={styles.text}>You have been sent a device reservation on {BRAND_NAME}.</Text>

            <Text style={styles.text}>This reservation invitation is valid until {reservationEndDate}.</Text>

            <div style={styles.buttonWrapper}>
              <Link href={`${baseUrl}/deployments`} style={styles.button}>
                Accept Reservation
              </Link>
            </div>

            <Text style={styles.text}>
              If you have any questions about this reservation, please reach out to our support team.
            </Text>

            <Text style={styles.signature}>- The {BRAND_NAME} Team</Text>
          </div>
        </Container>
      </Body>
    </Html>
  );
}

export default function ReservationInvitationEmailPreview() {
  return <ReservationInvitationEmail baseUrl="http://localhost:3000" reservationEndDate="1/1/25" />;
}
