import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/nvidia-driver-and-cuda-toolkit')({
  component: DocsNvidiaDriverAndCudaToolkit,
});

function DocsNvidiaDriverAndCudaToolkit() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} FAQ</DocPage.SectionTitle>
        <DocPage.PageTitle>How do I configure the NVIDIA driver and CUDA toolkit?</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <p>I want to configure the NVIDIA driver and CUDA toolkit on my {BRAND_NAME} server. How do I do that?</p>

        <h2>Solution</h2>

        <p>With proper system and environment setup we can install everything you need on your {BRAND_NAME} server.</p>

        <h3>System Requirements</h3>

        <ul>
          <li>
            <strong>Operating System:</strong> Ubuntu 22.04 LTS or Ubuntu 24.04 LTS
          </li>
          <li>
            <strong>NVIDIA GPU:</strong> Any supported NVIDIA GPU. Note below for GH200.
          </li>
        </ul>

        <h3>Environment Configuration</h3>

        <p>
          After installation, the following environment variables are configured to ensure proper functionality of CUDA
          tools:
        </p>

        <ul>
          <li>
            <strong>PATH</strong>: Includes{' '}
            <code className="bg-muted/50 rounded px-2 py-1">/usr/local/cuda-12.2/bin</code> for easy access to CUDA
            binaries.
          </li>
          <li>
            <strong>LD_LIBRARY_PATH</strong>: Set to{' '}
            <code className="bg-muted/50 rounded px-2 py-1">/usr/local/cuda-12.2/lib64</code> for linking CUDA
            libraries.
          </li>
        </ul>

        <p>
          These settings are automatically applied from{' '}
          <code className="bg-muted/50 rounded px-2 py-1">/etc/environment</code> and do not require user intervention.
        </p>

        <h3>Usage</h3>

        <p>
          Once the system is configured, you can start utilizing CUDA-dependent applications. Ensure that your
          application configurations use the correct paths if they require manual setup.
        </p>

        <h2>Notes</h2>

        <p>
          <strong>Special Case for NVIDIA GH200 480GB Systems</strong>
        </p>

        <ul>
          <li>
            <strong>Kernel Requirement</strong>: Ubuntu 22.04 LTS uses the{' '}
            <code className="bg-muted/50 rounded px-2 py-1">linux-nvidia-64k-hwe</code> kernel package specifically for
            compatibility with this GPU model.
          </li>
          <li>
            <strong>Drivers</strong>: NVIDIA driver version 535 and CUDA version 12.2 are installed.
          </li>
        </ul>

        <h2>Support</h2>

        <p>
          For any issues related to the NVIDIA drivers or CUDA functionality, please contact your system administrator
          or refer to the official NVIDIA documentation for troubleshooting guidance.
        </p>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/nvidia-smi-not-working">Troubleshooting NVIDIA SMI</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/tee-environment">Trusted Execution Environment</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
