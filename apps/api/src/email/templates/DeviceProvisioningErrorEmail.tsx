import {
  Body,
  Column,
  Container,
  Font,
  Head,
  Heading,
  Html,
  Preview,
  Row,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';
import { BRAND_NAME } from '../branding';

interface DeviceProvisioningErrorEmailProps {
  deviceName: string;
  userName: string;
}

export function DeviceProvisioningErrorEmail({ deviceName, userName }: DeviceProvisioningErrorEmailProps) {
  return (
    <Html>
      <Head>
        <title>Device Provisioning Error</title>

        <Font
          fontFamily="Roboto"
          fallbackFontFamily="Verdana"
          webFont={{
            url: 'https://fonts.gstatic.com/s/roboto/v27/KFOmCnqEu92Fr1Mu4mxKKTU1Kg.woff2',
            format: 'woff2',
          }}
          fontWeight={400}
          fontStyle="normal"
        />
      </Head>

      <Preview>There was an error provisioning your device on {BRAND_NAME}</Preview>

      <Tailwind
        // @ts-ignore
        config={{
          theme: {
            extend: {
              colors: {
                background: '#030712',
                foreground: '#f9fafb',
                button: '#5b4cff',
                white: '#ffffff',
              },
            },
          },
        }}
      >
        <Body className="bg-background text-foreground">
          <Container>
            <Section>
              <Row>
                <Column>
                  <Heading className="text-xl">Hello {userName},</Heading>

                  <Heading as="h2" className="text-lg font-normal">
                    We encountered an issue while provisioning your device.
                  </Heading>

                  <Text>
                    There was an error while setting up your device "{deviceName}". Our support team has been notified
                    and is working to resolve the issue.
                  </Text>

                  <Text>
                    We've automatically created a support ticket for this issue. You can track the progress using the
                    link below.
                  </Text>

                  <Text>
                    We apologize for any inconvenience. Our team will work to resolve this as quickly as possible.
                    Someone from our team will be in touch with you shortly.
                  </Text>

                  <Text>
                    If you have any questions or need further assistance, please contact your {BRAND_NAME} operator.
                  </Text>
                </Column>
              </Row>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

export default function DeviceProvisioningErrorEmailPreview() {
  return <DeviceProvisioningErrorEmail deviceName="Test Device" userName="John" />;
}
