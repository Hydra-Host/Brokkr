import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/disk-encryption')({
  component: DocsDiskEncryption,
});

function DocsDiskEncryption() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} Security</DocPage.SectionTitle>
        <DocPage.PageTitle>Disk Encryption</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <p>
          {BRAND_NAME} supports optional LUKS2 disk encryption for data volumes. When enabled during provisioning, your
          data disks are encrypted at rest using Linux Unified Key Setup (LUKS2), providing protection against
          unauthorized physical access to your storage.
        </p>

        <h2>How It Works</h2>

        <p>
          During provisioning, {BRAND_NAME} creates LUKS2 encrypted containers on your data disk logical volumes. A
          temporary encryption key is generated to set up the container and is immediately discarded after the disk
          layout is applied.
        </p>

        <p>
          <strong>{BRAND_NAME} does not store, retain, or have access to any encryption keys.</strong> You are solely
          responsible for setting and managing your LUKS passphrase. If you lose your passphrase, the encrypted data
          cannot be recovered.
        </p>

        <h2>What Gets Encrypted</h2>

        <ul>
          <li>
            <strong>Data disks only.</strong> System mountpoints (<code>/</code>, <code>/home</code>, <code>/tmp</code>,{' '}
            <code>/usr</code>, <code>/var</code>) are never encrypted. Encryption is available for additional data disks
            such as <code>/data</code>.
          </li>
          <li>
            Encryption can be enabled per disk group during provisioning by checking the <strong>Encrypt</strong> option
            in the disk layout selector.
          </li>
          <li>Encryption works with LVM, RAID, and direct disk configurations.</li>
        </ul>

        <h2>Helper Scripts</h2>

        <p>
          When encryption is enabled, {BRAND_NAME} installs three helper scripts on your server at{' '}
          <code>/usr/local/bin/</code>, available system-wide:
        </p>

        <h3>luks-rekey</h3>

        <p>
          Sets up your LUKS passphrase for the first time. This must be run after your initial provisioning to take
          ownership of the encrypted volumes. The script formats the LUKS container with your chosen passphrase, creates
          the filesystem, and updates <code>/etc/fstab</code> with the new encryption identifiers.
        </p>

        <pre className="bg-muted/50 overflow-x-auto rounded p-4">
          <code>{`# Interactive
sudo luks-rekey

# Non-interactive
sudo luks-rekey --passphrase "your-passphrase" --yes

# Via environment variable
LUKS_PASSPHRASE="your-passphrase" sudo luks-rekey --yes`}</code>
        </pre>

        <h3>luks-unlock</h3>

        <p>
          Opens your encrypted volumes and mounts them after a reboot. Since the OS disk is unencrypted, your server
          boots normally and is accessible via SSH. Run this script after each reboot to unlock and mount your encrypted
          data volumes.
        </p>

        <pre className="bg-muted/50 overflow-x-auto rounded p-4">
          <code>{`# Interactive
sudo luks-unlock

# Non-interactive
sudo luks-unlock --passphrase "your-passphrase"

# Via environment variable
LUKS_PASSPHRASE="your-passphrase" sudo luks-unlock`}</code>
        </pre>

        <h3>luks-lock</h3>

        <p>
          Unmounts and closes your encrypted volumes, securing the data at rest. Use this when you want to lock your
          volumes without rebooting.
        </p>

        <pre className="bg-muted/50 overflow-x-auto rounded p-4">
          <code>sudo luks-lock</code>
        </pre>

        <h2>Getting Started After Provisioning</h2>

        <ol>
          <li>
            <strong>SSH into your server</strong> using the credentials provided during provisioning.
          </li>
          <li>
            <strong>Run the rekey script</strong> to set your LUKS passphrase:
            <pre className="bg-muted/50 mt-2 overflow-x-auto rounded p-4">
              <code>sudo luks-rekey</code>
            </pre>
            You will be prompted to enter and confirm a passphrase. The script will format the LUKS container, create
            the filesystem, and mount the volume.
          </li>
          <li>
            <strong>Verify your volumes</strong> are mounted:
            <pre className="bg-muted/50 mt-2 overflow-x-auto rounded p-4">
              <code>lsblk</code>
            </pre>
            You should see your encrypted volume with a <code>crypt</code> type and the expected mountpoint.
          </li>
          <li>
            <strong>Store your passphrase securely.</strong> {BRAND_NAME} does not have a copy and cannot recover it.
          </li>
        </ol>

        <h2>After Reboots</h2>

        <p>
          Encrypted volumes are not automatically unlocked at boot to avoid passphrase prompts on headless servers.
          After each reboot:
        </p>

        <ol>
          <li>SSH into your server.</li>
          <li>
            Run the unlock script:
            <pre className="bg-muted/50 mt-2 overflow-x-auto rounded p-4">
              <code>sudo luks-unlock</code>
            </pre>
          </li>
        </ol>

        <h2>Preserved Encrypted Disks</h2>

        <p>
          When reprovisioning a server, you can choose to preserve data disk groups. If an encrypted disk is preserved,
          {BRAND_NAME} will detect the existing LUKS container and configure <code>/etc/fstab</code> and{' '}
          <code>/etc/crypttab</code> so your volume is ready to unlock after the reprovision completes. Your existing
          passphrase remains unchanged.
        </p>

        <h2>Important Notes</h2>

        <ul>
          <li>
            <strong>Key responsibility:</strong> {BRAND_NAME} generates a temporary key during provisioning that is
            immediately discarded. We do not store encryption keys. You must run the rekey script to set your own
            passphrase.
          </li>
          <li>
            <strong>No key recovery:</strong> If you lose your passphrase, the data on encrypted volumes cannot be
            recovered by {BRAND_NAME} or anyone else.
          </li>
          <li>
            <strong>OS disk is never encrypted:</strong> This ensures your server always boots and is accessible via SSH
            for you to unlock data volumes remotely.
          </li>
          <li>
            <strong>Performance:</strong> LUKS2 encryption uses hardware-accelerated AES on modern processors. The
            performance impact is minimal for most workloads.
          </li>
        </ul>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/brokkr-mfa">{BRAND_NAME} Multi-Factor Authentication</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/ssh-stops-on-vpn">SSH Connectivity on VPN</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
