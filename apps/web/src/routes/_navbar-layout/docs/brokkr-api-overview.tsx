import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/brokkr-api-overview')({
  component: DocsBrokkrApiOverview,
});

function DocsBrokkrApiOverview() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} API</DocPage.SectionTitle>
        <DocPage.PageTitle>API Overview</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <p>
          The {BRAND_NAME} API allows you to view and manage {BRAND_NAME} resources.
        </p>

        <p>
          You&apos;re able to explore our marketplace programmatically to monitor available resources and claim them for
          yourself. Once those devices are claimed, you can use the API to manage them.
        </p>

        <p>
          As a supplier, you can also use the API to manage your resources. We give you the ability to update your
          inventory, programmatically update your pricing, and more.
        </p>

        <p>
          You can view the API endpoints and specs{' '}
          <a href="/api/redoc" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
            here
          </a>
          .
        </p>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/brokkr-tos">{BRAND_NAME} Terms of Service</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/brokkr-api-authentication">Authentication</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
