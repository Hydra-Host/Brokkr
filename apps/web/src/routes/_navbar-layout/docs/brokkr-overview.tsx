import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/brokkr-overview')({
  component: DocsBrokkrOverview,
});

function DocsBrokkrOverview() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>Introduction to {BRAND_NAME}</DocPage.SectionTitle>
        <DocPage.PageTitle>{BRAND_NAME} Overview</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <h2>Welcome to {BRAND_NAME}</h2>

        <p>
          Welcome to {BRAND_NAME}, a platform designed to improve the way data centers provision and monetize GPU &
          compute resources. In this introductory article, we will provide an overview of {BRAND_NAME}, its features,
          and the benefits it brings to data centers and their customers. This is the first article in our technical
          documentation collection, aimed at helping you better understand the capabilities and potential of{' '}
          {BRAND_NAME}.
        </p>

        <h2>Overview of {BRAND_NAME}</h2>

        <p>
          {BRAND_NAME} is a bare metal provisioning and marketplace platform that simplifies the deployment that allows
          any DC to offer their compute as Bare Metal Cloud (BMC) or bare metal as a service (BMaaS) on the {BRAND_NAME}{' '}
          marketplace. As a fully managed and supported SaaS solution, {BRAND_NAME} enables DCs to outsource the
          provisioning and application layers of BMaaS, allowing them to instead focus on what they do best while still
          offering customers robust infrastructure capabilities.
        </p>

        <h2>{BRAND_NAME} Key Features</h2>

        <ul>
          <li>
            Provisioning & Lifecycle Management: {BRAND_NAME} fully automates the complete lifecycle of machines,
            allowing end users to deploy and manage hardware resources with ease and reducing manual overhead for the
            data center.
          </li>

          <li>
            User-friendly Interface & Self Service: {BRAND_NAME} features an intuitive on-boarding interface, making it
            easy for end users to on-board and self-serve bare metal resources using the {BRAND_NAME} Marketplace.
          </li>

          <li>
            Comprehensive API: The {BRAND_NAME} API allows for programmatic control of infrastructure and supports
            popular Infrastructure as Code (IaC) tooling. This improves the competitiveness of data centers by enabling
            them to offer cloud-like capabilities to their clients.
          </li>

          <li>
            Scalability: {BRAND_NAME} is designed to scale efficiently, allowing data centers to grow their BMaaS
            offerings without significant capital investment in additional infrastructure or personnel.
          </li>

          <li>
            Comprehensive Security: {BRAND_NAME} emphasizes security, adding additional hardening and security-oriented
            features to protect the platform, customer, and end-user data.
          </li>

          <li>
            White-label: {BRAND_NAME} can be tailored to your DC's branding, giving you an instant boost in brand
            positioning and credibility.
          </li>
        </ul>

        <h2>Benefits of {BRAND_NAME}</h2>

        <p>By leveraging {BRAND_NAME}, data centers can enjoy several advantages:</p>

        <ul>
          <li>
            Revenue Generation: {BRAND_NAME} enables data centers to monetize their underutilized hardware resources,
            creating new revenue streams, further optimizing their return on investment.
          </li>

          <li>
            Operational Efficiency: Automation and streamlined workflows lead to reduced manual intervention, resulting
            in increased operational efficiency and cost savings.
          </li>

          <li>
            Customer Satisfaction: {BRAND_NAME}'s user-friendly interface and modern API capabilities ensure a positive
            experience for end-users, leading to greater customer satisfaction and retention.
          </li>
        </ul>

        <p>
          {BRAND_NAME} is a practical platform that enhances data center provisioning and monetization, offering value
          to both data centers and their customers. As you explore our technical documentation collection, you'll gain a
          deeper understanding of {BRAND_NAME}'s capabilities and learn how to leverage its full potential to improve
          your data center operations. Welcome to the world of efficient data center provisioning with {BRAND_NAME}!
        </p>
      </DocPage.Content>

      <DocPage.Footer>
        <div />
        <DocPage.NextLink href="/docs/brokkr-components">{BRAND_NAME} Components</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
