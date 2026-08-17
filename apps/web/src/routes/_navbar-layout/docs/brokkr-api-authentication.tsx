import { BRAND_NAME, COMPANY_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/brokkr-api-authentication')({
  component: DocsBrokkrApiAuthentication,
});

function DocsBrokkrApiAuthentication() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} API</DocPage.SectionTitle>
        <DocPage.PageTitle>Authentication</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <p className="font-semibold">
          Key creation is guarded and you need to reach out to {COMPANY_NAME} to get access.
        </p>

        <h2>API Keys</h2>

        <p>
          Keys are scoped to an organization. You can create multiple keys for different users. We recommend setting an
          expiration date on your keys to limit the impact of a key being compromised.
        </p>

        <h3>Creating a Key</h3>

        <p>To create a key, you can visit the API Keys section of your {BRAND_NAME} organization.</p>

        <p>
          Given a name and an optional expiration date, you can create a key. It will be shown once and cannot be
          retrieved later.
        </p>

        <h3>Using a Key</h3>

        <p>
          To authenticate any requests to the {BRAND_NAME} API, you need to pass the key in the header of your request.
        </p>

        <pre>
          <code>X-API-KEY: your_api_key_here</code>
        </pre>

        <h3>Deleting a Key</h3>

        <p>You can delete a key by clicking the trash icon next to the key in your {BRAND_NAME} account.</p>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/brokkr-api-overview">API Overview</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/brokkr-api-dcim">DCIM</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
