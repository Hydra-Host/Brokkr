import { BRAND_NAME, COMPANY_NAME, COMPANY_URL } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/installation-overview')({
  component: DocsInstallationOverview,
});

function DocsInstallationOverview() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} Bridge</DocPage.SectionTitle>
        <DocPage.PageTitle>Installation Overview</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <p>
          The {BRAND_NAME} Bridge installation is facilitated by the data center, following the hardware delivery. This
          document provides an overview of the installation process to help users understand what to expect during each
          phase.
        </p>

        <h2>1. Kick-off</h2>

        <p>
          Completion of the {BRAND_NAME} contract starts the {BRAND_NAME} deployment phase. This begins with the{' '}
          {COMPANY_NAME} team and the data center (DC) team conducting an in-depth validation that the DC's
          infrastructure meets {BRAND_NAME} technical requirements. Then we will collaboratively agree on delivery scope
          and timelines.
        </p>

        <p>Key objectives include:</p>

        <ul>
          <li>
            <strong>Requirements review</strong>: Ensure all information necessary to deploy {BRAND_NAME} on the DC
            infrastructure is provided and understood.
          </li>
          <li>
            <strong>DC infrastructure review</strong>: Assess the existing DC infrastructure to determine its
            suitability for the {BRAND_NAME} Bridge deployment.
          </li>
          <li>
            <strong>Q/A</strong>: Resolve outstanding issues or questions.
          </li>
          <li>
            <strong>Comms</strong>: Agree on the primary means of communication and primary points of contact (
            {COMPANY_NAME} uses Mattermost, Teams, Slack, and Signal).
          </li>
        </ul>

        <h2>2. Delivery and Validation</h2>

        <p>
          In this phase, the {COMPANY_NAME} team will ship the DC team a {BRAND_NAME} Bridge kit. The kit will contain
          two small form factor servers, rack mounts, and AC adapters. Once received, the kit should be installed into
          the datacenter on the network(s) where the marketplace servers reside. The DC will receive the {BRAND_NAME}{' '}
          Bridge kit with the preconfigured static IPs received during kick off. The DC will then need to connect the{' '}
          {BRAND_NAME} Bridges ports according to the {BRAND_NAME} installation guide.
        </p>

        <p>Key steps include:</p>

        <ul>
          <li>
            <strong>Gathering necessary information</strong>: Collect and provide all required data, such as network
            configurations and access credentials.
          </li>
          <li>
            <strong>Validation</strong>: The {COMPANY_NAME} team will verify the provided information, network setup,
            and ensure it meets the necessary requirements for {BRAND_NAME} deployment.
          </li>
        </ul>

        <h2>3. Testing & Tuning</h2>

        <p>
          After the deployment, the {COMPANY_NAME} team will perform thorough testing and tuning to ensure that the{' '}
          {BRAND_NAME} system is functioning correctly.
        </p>

        <p>Key activities include:</p>

        <ul>
          <li>
            <strong>Verification</strong> of the appropriate installation of all components.
          </li>
          <li>
            <strong>Networking tests</strong> to ensure proper communication between {BRAND_NAME} Bridges, the{' '}
            {BRAND_NAME} servers, and the marketplace servers.
          </li>
          <li>
            <strong>Functionality tests</strong> to confirm that the system is working as expected and life cycle of
            marketplace machines is fully managed by {BRAND_NAME}.
          </li>
          <li>
            <strong>Tuning and optimization</strong> of the system based on test results.
          </li>
        </ul>

        <h2>4. Account Creation</h2>

        <p>
          After testing to ensure the {BRAND_NAME} Bridge and server inventory is operating correctly, the DC
          administrators will create an account at {COMPANY_URL}. Once created, the {COMPANY_NAME} team will link their
          account to their inventory for management in the "inventory" tab, where the admin can manage:
        </p>

        <ul>
          <li>Pricing</li>
          <li>Adding or removing inventory from the marketplace</li>
          <li>Monitoring usage of servers</li>
        </ul>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/brokkr-api-reservations">Reservations</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/brokkr-security">{BRAND_NAME} Security Documentation</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
