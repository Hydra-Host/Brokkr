import { BRAND_NAME, COMPANY_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/brokkr-components')({
  component: DocsBrokkrComponents,
});

function DocsBrokkrComponents() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>Introduction To {BRAND_NAME}</DocPage.SectionTitle>
        <DocPage.PageTitle>{BRAND_NAME} Components</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <h2>Introduction</h2>

        <p>
          {BRAND_NAME} is a fully managed SaaS platform that enables data centers to offer Bare Metal as a Service
          (BMaaS) through the {BRAND_NAME} Marketplace. This guide outlines the core components of the {BRAND_NAME}{' '}
          system architecture.
        </p>

        <h2>Core Components</h2>

        <h3>Control Plane</h3>

        <p>The Control Plane serves as the central orchestrator of the {BRAND_NAME} system:</p>

        <ul>
          <li>Deployed on {COMPANY_NAME}-operated infrastructure</li>
          <li>Manages lifecycle, inventory, and user operations</li>
          <li>Hosts the {BRAND_NAME} UI and API endpoints</li>
        </ul>

        <h3>{BRAND_NAME} Bridge</h3>

        <p>The {BRAND_NAME} Bridge acts as a hardware proxy for machine management:</p>

        <ul>
          <li>Handles machine discovery and lifecycle management</li>
          <li>Configures network settings</li>
          <li>Manages DHCP services</li>
          <li>Facilitates OS installations within data centers</li>
          <li>Ensures secure and efficient operations at scale</li>
        </ul>

        <h3>Inventory Pool</h3>

        <p>The Inventory Pool maintains the hardware resource collection:</p>

        <ul>
          <li>Tracks all available hardware resources</li>
          <li>Continuously monitored by the Control Plane</li>
          <li>Provides real-time resource availability status</li>
        </ul>

        <h3>{BRAND_NAME} Marketplace</h3>

        <p>The Marketplace provides real-time access to available servers:</p>

        <ul>
          <li>Lists all available servers from the inventory pool</li>
          <li>Displays servers available for rent from DC providers</li>
          <li>
            Features advanced filtering options:
            <ul>
              <li>Price</li>
              <li>CPU/GPU cores</li>
              <li>Additional hardware specifications</li>
              <li>Availability status</li>
            </ul>
          </li>
        </ul>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/brokkr-overview">{BRAND_NAME} Overview</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/brokkr-tos">Terms of Service</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
