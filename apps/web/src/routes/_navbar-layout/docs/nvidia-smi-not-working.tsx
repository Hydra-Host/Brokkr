import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/nvidia-smi-not-working')({
  component: DocsNvidiaSmiNotWorking,
});

function DocsNvidiaSmiNotWorking() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} FAQ</DocPage.SectionTitle>
        <DocPage.PageTitle>Why is the nvidia-smi command not working?</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <p>How do I auto install the NVIDIA drivers?</p>

        <h2>Solution</h2>

        <p>
          Enter this command in your SSH session and it will automatically install the newest Nvidia drivers for the
          system. After the installation is complete, the nvidia-smi command will output the GPU information.
        </p>

        <pre className="bg-muted/50 overflow-x-auto rounded-lg p-4">
          <code>sudo ubuntu-drivers autoinstall</code>
        </pre>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/ssh-keys-with-brokkr">SSH Keys with {BRAND_NAME}</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/nvidia-driver-and-cuda-toolkit">NVIDIA Driver and CUDA Toolkit</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
