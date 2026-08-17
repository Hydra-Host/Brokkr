import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/brokkr-api-reservations')({
  component: DocsBrokkrApiReservations,
});

function DocsBrokkrApiReservations() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} API</DocPage.SectionTitle>
        <DocPage.PageTitle>Reservations</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <p className="font-semibold">Reservations are only available to {BRAND_NAME} marketplace partners.</p>

        <h2>Reservations</h2>

        <p>The reservations endpoints allow any user to view and manage their reservations.</p>

        <p>
          View the Reservations endpoints and specs{' '}
          <a href="/api/swagger" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
            here
          </a>
          .
        </p>

        <h3>Core Concepts</h3>

        <ul>
          <li>
            <strong>Reservations</strong>: A reservation is a commitment to purchase a machine from the marketplace.
          </li>
        </ul>

        <h3>Notes</h3>

        <ul>
          <li>Reservations temporarily reserve a machine from the marketplace for your organization.</li>
          <li>
            If the invited user does not claim the reservation within 24 hours, it will be released back to the
            marketplace.
          </li>
        </ul>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/brokkr-api-inventory">Inventory</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/installation-overview">Installation Overview</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
