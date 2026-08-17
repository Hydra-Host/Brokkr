import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/ssh-keys-with-brokkr')({
  component: DocsSshKeysWithBrokkr,
});

function DocsSshKeysWithBrokkr() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} FAQ</DocPage.SectionTitle>
        <DocPage.PageTitle>How do I use my SSH keys with {BRAND_NAME}?</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <p>I have an SSH key that I want to use with my {BRAND_NAME} server. How do I do that?</p>

        <h2>Solution</h2>

        <p>
          When you create a {BRAND_NAME} account, you can upload an SSH key. This associates it with your user. When you
          provision a server, you can select the key from the list of keys associated with your user.
        </p>

        <p>If you don't have an SSH key, you can create one by running the following command:</p>

        <pre className="bg-muted/50 overflow-x-auto rounded-lg p-4">
          <code>ssh-keygen -t rsa -b 2048</code>
        </pre>

        <p>
          When prompted, provide a name for the key pair. We also recommend using the default location for the key. A
          passphrase is optional, but recommended for added security.
        </p>

        <h2>SSH Notes</h2>

        <ul>
          <li>{BRAND_NAME} is compatible with multiple key formats, like RSA, ECDSA, and ED25519.</li>
          <li>
            To check if your SSH agent has access to your key, you can use:
            <pre className="bg-muted/50 mt-2 overflow-x-auto rounded-lg p-4">
              <code>ssh-add -L</code>
            </pre>
            If your key doesn't show up, you can add it with:
            <pre className="bg-muted/50 mt-2 overflow-x-auto rounded-lg p-4">
              <code>ssh-add ~/.ssh/nameofprivatekey</code>
            </pre>
          </li>
        </ul>

        <h2>IPV4 and IPV6</h2>

        <ul>
          <li>
            If you see a message "No route to host" when trying to SSH, you may be on IPV4 trying to access an IPV6
            machine.
          </li>
          <li>
            To resolve, you can get an IPV6 address by downloading Cloudflare app here:{' '}
            <a
              href="https://one.one.one.one"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 underline"
            >
              https://one.one.one.one
            </a>
            . This can be helpful when you're on an IPV4-only network.
          </li>
          <li>
            You can verify you have an IPV6 address by using:{' '}
            <a
              href="https://www.myipaddress.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 underline"
            >
              https://www.myipaddress.com
            </a>
          </li>
        </ul>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/ssh-stops-on-vpn">SSH Connectivity on VPN</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/nvidia-smi-not-working">Troubleshooting NVIDIA SMI</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
