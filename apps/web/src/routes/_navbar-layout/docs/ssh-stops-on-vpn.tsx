import { BRAND_NAME, COMPANY_NAME, SUPPORT_EMAIL } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/ssh-stops-on-vpn')({
  component: DocsSshStopsOnVpn,
});

function DocsSshStopsOnVpn() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} FAQ</DocPage.SectionTitle>
        <DocPage.PageTitle>Why does SSH stop working after setting up a VPN?</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <p>I lost SSH access to my {BRAND_NAME} server after setting up a VPN. What should I do?</p>

        <h2>Solution</h2>

        <p>
          This is a common issue when using VPNs like NordVPN, as they can change your iptables and disrupt SSH access.
          Follow these steps to resolve it:
        </p>

        <h3>1. Check your VPN configuration</h3>

        <ul>
          <li>
            <strong>Is NordVPN configured to auto-connect on boot?</strong> If so, disabling auto-connect might prevent
            the issue.
          </li>
          <li>
            <strong>Which VPN protocol are you using?</strong> OpenVPN is known to cause this issue more frequently than
            other protocols. Try switching to UDP or TCP and see if the problem persists.
          </li>
        </ul>

        <h3>2. Restart your NordVPN client</h3>

        <ul>
          <li>This can often restore SSH access without needing further steps.</li>
        </ul>

        <h3>3. Whitelist the SSH port in iptables</h3>

        <ul>
          <li>
            This requires some technical knowledge, but it allows you to specifically allow SSH traffic through the VPN
            tunnel.
          </li>
          <li>You can find detailed instructions on how to do this in the resources section below.</li>
        </ul>

        <h3>4. Contact Support</h3>

        <p>
          If none of the above steps work, please contact {COMPANY_NAME} support at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary hover:text-primary/80 underline">
            {SUPPORT_EMAIL}
          </a>
        </p>

        <h2>Additional Resources</h2>

        <ul>
          <li>
            <a
              href="https://serverfault.com/questions/1146190/ssh-to-the-same-server-of-openvpn-tries-to-connect-with-original-ip-instead-of"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 underline"
            >
              Stack Exchange thread on OpenVPN SSH connectivity
            </a>
          </li>
          <li>
            <a
              href="https://nordvpn.com/contact-us/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 underline"
            >
              NordVPN Support
            </a>
          </li>
        </ul>

        <h2>Important Tips</h2>

        <ul>
          <li>Always back up your server data before making any significant configuration changes</li>
          <li>When using a VPN, be aware of potential security risks and take appropriate precautions</li>
        </ul>

        <p>
          By following these steps, you should be able to restore SSH access to your {BRAND_NAME} server after setting
          up a VPN.
        </p>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/disk-encryption">Disk Encryption</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/ssh-keys-with-brokkr">SSH Keys with {BRAND_NAME}</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
