import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/brokkr-api-deployments')({
  component: DocsBrokkrApiDeployments,
});

function DocsBrokkrApiDeployments() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} API</DocPage.SectionTitle>
        <DocPage.PageTitle>Deployments</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <h2>Deployments</h2>

        <p>The deployments endpoints allow any user to view and manage their deployments.</p>

        <p>
          View the Deployments endpoints and specs{' '}
          <a href="/api/swagger" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
            here
          </a>
          .
        </p>

        <h3>Core Concepts</h3>

        <ul>
          <li>
            <strong>Deployment</strong>: A deployment is a baremetal server or virtual machine that is being managed by
            your organization.
          </li>
          <li>
            <strong>Rebooting</strong>: A reboot is an action that will restart the server.
          </li>
          <li>
            <strong>Reprovisioning</strong>: A reprovision is an action that will wipe the deployment and reinstall the
            operating system.
          </li>
        </ul>

        <h3>Notes</h3>

        <ul>
          <li>
            Deployments are created either by claiming a machine from the marketplace or provisioning a machine
            internally.
          </li>
        </ul>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/brokkr-api-dcim">DCIM</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/brokkr-api-inventory">Inventory</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
