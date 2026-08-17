import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/brokkr-api-inventory')({
  component: DocsBrokkrApiInventory,
});

function DocsBrokkrApiInventory() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} API</DocPage.SectionTitle>
        <DocPage.PageTitle>Inventory</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <h2>Inventory</h2>

        <p>The inventory endpoints allow any user to view and claim hardware from our inventory.</p>

        <p>
          View the Inventory endpoints and specs{' '}
          <a href="/api/swagger" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
            here
          </a>
          .
        </p>

        <h3>Core Concepts</h3>

        <ul>
          <li>
            <strong>Categories</strong>: A category is a grouping of hardware, typically by GPU model.
          </li>
          <li>
            <strong>Listings</strong>: A listing is an individual piece of hardware that is available for purchase.
          </li>
          <li>
            <strong>Provisioning</strong>: A provisioning is an action that will provision a machine from a listing. It
            will create a deployment on your organization's account.
          </li>
        </ul>

        <h3>Notes</h3>

        <ul>
          <li>You must have a valid billing method on file with your organization to claim a machine.</li>
        </ul>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/brokkr-api-deployments">Deployments</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/brokkr-api-reservations">Reservations</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
