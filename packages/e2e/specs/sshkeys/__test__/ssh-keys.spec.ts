import { expect, test } from '../../../fixtures/auth.fixture.js';

const ED25519_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKVkht1ZdckTEe2WZwwFgJX+cot8xSf5CAYaYqGtQKJ6';
const ED25519_FP = 'SHA256:TCzqHyUTYIf0YZCdq/F9k8JPYKElvkd39ZBWhP5mEAo';
const RSA_KEY =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDqJ5yMyY7Z+5R1GsW4U5gM9kD7OyArUZT1CDE/rbyTUVUKxdAs5bb8b5SKYS1j8/18trVJvDPdvrkrL9NzHKRvjFNm/lgoB1ifZ1tUZ/S2zd1+Es4f9kSsJGNiV2i6EjB+gjNfCtkVs93k/wOijKbcCh7SQuPSbg+AlRIQJ+UUj9I8A1a5yOWvwuP4oK1f9hcdz3T4/Zgy2JgDkvdhms+dFBl27J02WUE7NXjBS6i0QrpWw2lEGvMylFo+f4CIMeUNKRec/d8D59Vv5Z/lUUIqKXOpECtoj93E6SD/mW7Rqp8LFfKZoi4YYGhpRmKHAY0pfAWnbDFsS7JKQ9w5/xh';
const RSA_FP = 'SHA256:4Ce2nvi/+xKBSwPGbnD2/VzeDMat/uar6F8/nKLPBv8';
const ECDSA_KEY =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBL3EUCZt7l876ee9C5K0pPnlSvcc0ZC1BCd1vlRDIMHWTvrJJhMeoNCN4lQsyI9TceMIsIZvANrsgFv5GGArlCc=';
const ECDSA_FP = 'SHA256:n1otMcHCErs3nlWhl4AIxDE2oQDoCXSTOvRB8TneF/c';

test.describe('SSH Keys CRUD', () => {
  test('should display ssh keys list page', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const owner = await db.waitForUserByEmail(seedData.users.orguser.email, 'org user should exist for list test');
    const keyName = `e2e-list-${Date.now()}`;

    const seededKey = await db.prisma.sshKeys.create({
      data: {
        name: keyName,
        key: `${ED25519_KEY} ${keyName}@e2e`,
        fingerprint: ED25519_FP,
        userId: owner.id,
      },
    });

    try {
      await page.goto('/account/ssh-keys');
      await expect(page.getByText('SSH Keys').first()).toBeVisible();
      await expect(
        page.getByText('Setup and control access to your deployments with secure shell keys.'),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: 'Add Key' })).toBeVisible();

      const seededRow = page.getByRole('row').filter({ hasText: keyName });
      await expect(seededRow.getByRole('cell', { name: keyName })).toBeVisible();
      await expect(seededRow.getByRole('cell', { name: ED25519_FP })).toBeVisible();
    } finally {
      await db.prisma.sshKeys.deleteMany({ where: { id: seededKey.id } });
    }
  });

  test('should create an ssh-ed25519 key', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const owner = await db.waitForUserByEmail(seedData.users.orguser.email, 'org user should exist for create test');
    const keyName = `e2e-ed25519-${Date.now()}`;
    const keyBody = `${ED25519_KEY} ${keyName}@e2e`;

    try {
      await page.goto('/account/ssh-keys/create');
      await expect(
        page.getByText('The key will be associated with your user in your currently selected organization.'),
      ).toBeVisible();

      await page.getByLabel('Name').fill(keyName);
      await page.getByLabel('Key').fill(keyBody);
      await page.getByRole('button', { name: 'Add SSH Key' }).click();

      await page.waitForURL(/\/account\/ssh-keys$/);
      await expect(page.getByRole('cell', { name: keyName })).toBeVisible();

      const created = await db.prisma.sshKeys.findFirst({
        where: { name: keyName, userId: owner.id, dateDeleted: null },
      });
      expect(created).not.toBeNull();
      expect(created!.key).toBe(keyBody);
      expect(created!.fingerprint).toBe(ED25519_FP);
    } finally {
      await db.prisma.sshKeys.deleteMany({ where: { name: keyName, userId: owner.id } });
    }
  });

  test('should create an ecdsa-sha2-nistp256 key', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const owner = await db.waitForUserByEmail(seedData.users.orguser.email, 'org user should exist for ecdsa test');
    const keyName = `e2e-ecdsa-${Date.now()}`;
    const keyBody = `${ECDSA_KEY} ${keyName}@e2e`;

    try {
      await page.goto('/account/ssh-keys/create');
      await page.getByLabel('Name').fill(keyName);
      await page.getByLabel('Key').fill(keyBody);
      await page.getByRole('button', { name: 'Add SSH Key' }).click();

      await page.waitForURL(/\/account\/ssh-keys$/);
      await expect(page.getByRole('cell', { name: keyName })).toBeVisible();

      const created = await db.prisma.sshKeys.findFirst({
        where: { name: keyName, userId: owner.id, dateDeleted: null },
      });
      expect(created).not.toBeNull();
      expect(created!.key).toBe(keyBody);
      expect(created!.fingerprint).toBe(ECDSA_FP);
    } finally {
      await db.prisma.sshKeys.deleteMany({ where: { name: keyName, userId: owner.id } });
    }
  });

  test('should reject a key with an unknown type', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const owner = await db.waitForUserByEmail(seedData.users.orguser.email, 'org user should exist for reject test');
    const keyName = `e2e-unknown-${Date.now()}`;

    await page.goto('/account/ssh-keys/create');
    await page.getByLabel('Name').fill(keyName);
    await page.getByLabel('Key').fill('ssh-unknown AAAAB3NzaC1yc2EAAAADAQABAAABAQ');
    await page.getByRole('button', { name: 'Add SSH Key' }).click();

    await expect(page.getByText('Cannot determine key type').first()).toBeVisible();
    await expect(page).toHaveURL(/\/account\/ssh-keys\/create/);

    const created = await db.prisma.sshKeys.findFirst({
      where: { name: keyName, userId: owner.id },
    });
    expect(created).toBeNull();
  });

  test('should reject a duplicate key', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const owner = await db.waitForUserByEmail(seedData.users.orguser.email, 'org user should exist for duplicate test');
    const keyName = `e2e-duplicate-${Date.now()}`;
    const keyBody = `${RSA_KEY} ${keyName}@e2e`;

    await db.prisma.sshKeys.create({
      data: {
        name: keyName,
        key: keyBody,
        fingerprint: RSA_FP,
        userId: owner.id,
      },
    });

    try {
      await page.goto('/account/ssh-keys/create');
      await page.getByLabel('Name').fill(`${keyName}-copy`);
      await page.getByLabel('Key').fill(keyBody);
      await page.getByRole('button', { name: 'Add SSH Key' }).click();

      await expect(page.getByText('SSH key already exists').first()).toBeVisible();
      await expect(page).toHaveURL(/\/account\/ssh-keys\/create/);

      const count = await db.prisma.sshKeys.count({
        where: { key: keyBody, userId: owner.id },
      });
      expect(count).toBe(1);
    } finally {
      await db.prisma.sshKeys.deleteMany({ where: { key: keyBody, userId: owner.id } });
    }
  });

  test('should delete an ssh key', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const owner = await db.waitForUserByEmail(seedData.users.orguser.email, 'org user should exist for delete test');
    const keyName = `e2e-delete-${Date.now()}`;

    const seededKey = await db.prisma.sshKeys.create({
      data: {
        name: keyName,
        key: `${ED25519_KEY} ${keyName}@e2e`,
        fingerprint: ED25519_FP,
        userId: owner.id,
      },
    });

    try {
      await page.goto(`/account/ssh-keys/${seededKey.id}/delete`);

      await expect(page.getByText('Delete SSH Key').first()).toBeVisible();
      await expect(page.getByText('This action cannot be undone.')).toBeVisible();

      const deleteButton = page.getByRole('button', { name: 'Delete SSH Key' });
      await expect(deleteButton).toBeDisabled();

      await page.getByLabel(`Type ${keyName} to confirm`).fill(keyName);
      await expect(deleteButton).toBeEnabled();
      await deleteButton.click();

      await page.waitForURL(/\/account\/ssh-keys$/);

      const deleted = await db.prisma.sshKeys.findUnique({ where: { id: seededKey.id } });
      expect(deleted).not.toBeNull();
      expect(deleted!.dateDeleted).not.toBeNull();
    } finally {
      await db.prisma.sshKeys.deleteMany({ where: { id: seededKey.id } });
    }
  });
});
