import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/tee-environment')({
  component: DocsTeeEnvironment,
});

function DocsTeeEnvironment() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} FAQ</DocPage.SectionTitle>
        <DocPage.PageTitle>Getting Started with Confidential AI on {BRAND_NAME} (Intel TDX)</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <p>
          This guide walks you from selecting a TEE-capable server to running confidential AI workloads, using{' '}
          {BRAND_NAME}'s fully automated Intel TDX support.
        </p>

        <p>{BRAND_NAME} handles the hard parts (BIOS, host OS, validation). You focus on your workload.</p>

        <h2>1. Find TEE-capable servers</h2>

        <p>In the {BRAND_NAME} console:</p>

        <ul>
          <li>Find servers marked "TEE Capable"</li>
          <li>
            These servers support hardware-enforced confidential computing using Intel Trust Domain Extensions (TDX)
          </li>
        </ul>

        <p>
          <strong>If a server is not marked TEE-capable, Intel TDX cannot be enabled later.</strong>
        </p>

        <h3>What {BRAND_NAME} already did for you</h3>

        <ul>
          <li>Validated CPU, platform firmware, and memory configuration</li>
          <li>Ensured the platform supports Intel TDX at the silicon level</li>
        </ul>

        <h2>2. Provision with a TEE operating system</h2>

        <p>When provisioning the server, select one of the TEE OS images:</p>

        <ul>
          <li>
            <strong>Ubuntu Noble 24.04 LTS (TEE)</strong>
            <br />
            Stable, long-term support, recommended for production
          </li>
          <li>
            <strong>Ubuntu Plucky 25.04 (TEE)</strong>
            <br />
            Newer kernel and TDX features, ideal for cutting-edge AI workloads
          </li>
        </ul>

        <p>
          <strong>Provisioning can take up to 60 minutes. This is expected.</strong>
        </p>

        <p>During this time, {BRAND_NAME}:</p>

        <ul>
          <li>Applies a validated TDX BIOS configuration</li>
          <li>Performs required multi-stage reboots</li>
          <li>Installs a Canonical-based TDX host stack</li>
          <li>Verifies the TDX module is fully initialized</li>
        </ul>

        <p>The server is only marked ready after all checks pass.</p>

        <h2>3. Verify that TDX is active</h2>

        <p>Once the server is ready, SSH in and confirm that Intel TDX is enabled:</p>

        <pre className="bg-muted/50 rounded px-4 py-2">
          <code>sudo dmesg | grep -i tdx</code>
        </pre>

        <p>You should see output indicating:</p>

        <ul>
          <li>BIOS support is enabled</li>
          <li>The TDX module is loaded</li>
          <li>The module is initialized</li>
        </ul>

        <p>You can also check:</p>

        <pre className="bg-muted/50 rounded px-4 py-2">
          <code>cat /sys/module/kvm_intel/parameters/tdx</code>
        </pre>

        <p>Expected value:</p>

        <pre className="bg-muted/50 rounded px-4 py-2">
          <code>Y</code>
        </pre>

        <p>
          <strong>If these checks fail, do not proceed. Contact {BRAND_NAME} support.</strong>
        </p>

        <h2>4. Create and configure your Trust Domain (TD)</h2>

        <p>At this point, {BRAND_NAME}'s responsibility ends and guest-level configuration begins.</p>

        <p>Follow Canonical's official Intel TDX documentation starting at:</p>

        <p>
          <strong>"5. Create TD Image"</strong>
        </p>

        <p>
          <a
            href="https://github.com/canonical/tdx?tab=readme-ov-file#5-create-td-image"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary/80 underline"
          >
            https://github.com/canonical/tdx?tab=readme-ov-file#5-create-td-image
          </a>
        </p>

        <p>This includes:</p>

        <ul>
          <li>Creating a TD guest image</li>
          <li>Launching a Trust Domain VM</li>
          <li>Optional: configuring remote attestation and key release</li>
        </ul>

        <p>
          We intentionally link to Canonical's documentation to ensure you always have the latest, authoritative TDX
          instructions.
        </p>

        <h2>5. Run your confidential AI workloads</h2>

        <p>Inside the Trust Domain VM, you can now:</p>

        <ul>
          <li>Run standard Linux workloads (no app changes required)</li>
          <li>Attach and use NVIDIA GPUs via passthrough</li>
          <li>Deploy PyTorch, TensorFlow, vLLM, Kubernetes, etc.</li>
          <li>Gate secrets or keys on successful TDX attestation</li>
        </ul>

        <p>At this stage:</p>

        <ul>
          <li>VM memory and CPU state are hardware-encrypted</li>
          <li>The host OS, hypervisor, and provider operators cannot inspect your workload</li>
          <li>You can cryptographically prove where your code is running</li>
        </ul>

        <h2>Critical notes (do not skip)</h2>

        <h3>What TDX protects</h3>

        <ul>
          <li>VM memory contents</li>
          <li>CPU state</li>
          <li>Isolation from host OS and hypervisor</li>
        </ul>

        <h3>What TDX does not automatically protect</h3>

        <ul>
          <li>Your application logic</li>
          <li>Network-level exposure</li>
          <li>Data you explicitly send outside the Trust Domain</li>
          <li>Secrets you load without attestation checks</li>
        </ul>

        <p>
          <strong>
            Confidential computing strengthens your trust boundary — it does not replace good security design.
          </strong>
        </p>

        <h2>Where to go next</h2>

        <p>Canonical's Intel TDX reference docs:</p>

        <p>
          <a
            href="https://github.com/canonical/tdx"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary/80 underline"
          >
            https://github.com/canonical/tdx
          </a>
        </p>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/nvidia-driver-and-cuda-toolkit">
          NVIDIA Driver and CUDA Toolkit
        </DocPage.PreviousLink>
      </DocPage.Footer>
    </DocPage>
  );
}
