import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/brokkr-mfa')({
  component: DocsBrokkrMfa,
});

function DocsBrokkrMfa() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} Security</DocPage.SectionTitle>
        <DocPage.PageTitle>{BRAND_NAME} Multi Factor Authentication</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <p>
          {BRAND_NAME} Marketplace provides access to bare-metal resources with root-level control. To protect these
          resources, we require Multi-Factor Authentication (MFA) for all {BRAND_NAME} users. You will be prompted to
          set up MFA when you first sign in. If you need to reset your MFA or require any assistance, please contact
          your {BRAND_NAME} operator.
        </p>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/brokkr-security">{BRAND_NAME} Security Documentation</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/disk-encryption">Disk Encryption</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
