import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/brokkr-api-dcim')({
  component: DocsBrokkrApiDcim,
});

function DocsBrokkrApiDcim() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} API</DocPage.SectionTitle>
        <DocPage.PageTitle>DCIM</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <h2>DCIM (Data Center Inventory Management)</h2>

        <p>
          The DCIM endpoints allow you to view and manage your data center inventory. These endpoints are only available
          to your organization if it is a registered supplier with {BRAND_NAME}.
        </p>

        <p>
          View the DCIM endpoints and specs{' '}
          <a href="/api/swagger" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
            here
          </a>
          .
        </p>

        <h3>Core Concepts</h3>

        <ul>
          <li>
            <strong>Baremetal</strong>: A physical server your {BRAND_NAME} Bridge controls.
          </li>
          <li>
            <strong>Listing</strong>: The marketplace listing for a given piece of hardware.
          </li>
          <li>
            <strong>Provisioning</strong>: Internally provisioning a server under your own account.
          </li>
        </ul>

        <h3>Notes</h3>

        <ul>
          <li>
            The DCIM endpoints are only available to your organization if it is a registered supplier with {BRAND_NAME}.
          </li>
        </ul>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/brokkr-api-authentication">Authentication</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/brokkr-api-deployments">Deployments</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
