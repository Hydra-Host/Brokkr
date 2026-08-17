import { BRAND_NAME, COMPANY_NAME, SECURITY_URL } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/brokkr-security')({
  component: DocsBrokkrSecurity,
});

function DocsBrokkrSecurity() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} Security</DocPage.SectionTitle>
        <DocPage.PageTitle>{BRAND_NAME} Security</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <p>Please see our security documentation contained in our Governance, Risk, and Compliance provider Vanta.</p>

        <p>
          <a
            href={SECURITY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary/80 underline"
          >
            Trust Center - {COMPANY_NAME}
          </a>
        </p>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/installation-overview">Installation Overview</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/brokkr-mfa">{BRAND_NAME} Multi-Factor Authentication</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
