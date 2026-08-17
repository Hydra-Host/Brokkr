import { expect, test } from '../../../fixtures/auth.fixture.js';

test.describe('Deployment Projects CRUD', () => {
  test.afterEach(async ({ db, seedData }) => {
    await db.prisma.deploymentProject.deleteMany({ where: { organizationId: seedData.organization.id } });
  });

  test('should create a project via the create dialog', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const projectName = `e2e-project-create-${Date.now()}`;

    await page.goto('/deployments/projects/create');
    await expect(page.getByRole('heading', { name: 'Create Deployment Project' })).toBeVisible();
    await expect(page.getByText('Projects help you organize and manage related deployments together.')).toBeVisible();

    await page.getByLabel('Project Name').fill(projectName);
    await page.getByRole('button', { name: 'Create Project' }).click();

    await page.waitForURL(/\/deployments$/);

    const project = await db.prisma.deploymentProject.findFirst({
      where: { name: projectName, organizationId: seedData.organization.id },
    });
    expect(project).not.toBeNull();
    expect(project!.isDefault).toBe(false);
    expect(project!.deletedAt).toBeNull();
  });

  test('should rename a project via the edit dialog', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;

    const project = await db.prisma.deploymentProject.create({
      data: {
        name: `e2e-project-edit-${Date.now()}`,
        organizationId: seedData.organization.id,
      },
    });

    await page.goto(`/deployments/projects/${project.id}/edit`);
    await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeVisible();

    await page.getByLabel('Project Name').fill(`${project.name}-renamed`);
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await page.waitForURL(/\/deployments$/);

    const updated = await db.prisma.deploymentProject.findUnique({ where: { id: project.id } });
    expect(updated!.name).toBe(`${project.name}-renamed`);
    expect(updated!.isDefault).toBe(false);
  });

  test('should set a project as default and demote the previous default', async ({
    authenticatedPage,
    db,
    seedData,
  }) => {
    const page = authenticatedPage;
    const suffix = Date.now();

    const previousDefault = await db.prisma.deploymentProject.create({
      data: {
        name: `e2e-project-default-a-${suffix}`,
        organizationId: seedData.organization.id,
        isDefault: true,
      },
    });
    const project = await db.prisma.deploymentProject.create({
      data: {
        name: `e2e-project-default-b-${suffix}`,
        organizationId: seedData.organization.id,
      },
    });

    await page.goto(`/deployments/projects/${project.id}/edit`);
    await expect(page.getByRole('heading', { name: 'Edit Project' })).toBeVisible();

    const defaultCheckbox = page.getByRole('dialog', { name: 'Edit Project' }).locator('span[role="checkbox"]');
    await defaultCheckbox.click();
    await expect(defaultCheckbox).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await page.waitForURL(/\/deployments$/);

    const promoted = await db.prisma.deploymentProject.findUnique({ where: { id: project.id } });
    const demoted = await db.prisma.deploymentProject.findUnique({ where: { id: previousDefault.id } });
    expect(promoted!.isDefault).toBe(true);
    expect(demoted!.isDefault).toBe(false);
  });

  test('should delete a non-default project after typing its name to confirm', async ({
    authenticatedPage,
    db,
    seedData,
  }) => {
    const page = authenticatedPage;
    const suffix = Date.now();

    await db.prisma.deploymentProject.create({
      data: {
        name: `e2e-project-keeper-${suffix}`,
        organizationId: seedData.organization.id,
      },
    });
    const project = await db.prisma.deploymentProject.create({
      data: {
        name: `e2e-project-delete-${suffix}`,
        organizationId: seedData.organization.id,
      },
    });

    await page.goto(`/deployments/projects/${project.id}/delete`);
    await expect(page.getByRole('heading', { name: 'Delete Project' })).toBeVisible();

    const deleteButton = page.getByRole('button', { name: 'Delete Project' });
    await expect(deleteButton).toBeDisabled();

    await page.getByLabel(`Type ${project.name} to confirm`).fill(project.name);
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();

    await page.waitForURL(/\/deployments$/);

    const deleted = await db.prisma.deploymentProject.findUnique({ where: { id: project.id } });
    expect(deleted).not.toBeNull();
    expect(deleted!.deletedAt).not.toBeNull();
  });

  test('should keep the delete button disabled until the exact name is typed', async ({
    authenticatedPage,
    db,
    seedData,
  }) => {
    const page = authenticatedPage;

    const project = await db.prisma.deploymentProject.create({
      data: {
        name: `e2e-project-confirm-${Date.now()}`,
        organizationId: seedData.organization.id,
      },
    });

    await page.goto(`/deployments/projects/${project.id}/delete`);
    await expect(page.getByRole('heading', { name: 'Delete Project' })).toBeVisible();

    const confirmInput = page.getByLabel(`Type ${project.name} to confirm`);
    const deleteButton = page.getByRole('button', { name: 'Delete Project' });

    await expect(deleteButton).toBeDisabled();

    await confirmInput.fill('wrong-name');
    await expect(deleteButton).toBeDisabled();

    await confirmInput.fill(project.name);
    await expect(deleteButton).toBeEnabled();

    const untouched = await db.prisma.deploymentProject.findUnique({ where: { id: project.id } });
    expect(untouched!.deletedAt).toBeNull();
  });

  test('should refuse to delete the default project', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;
    const suffix = Date.now();

    const defaultProject = await db.prisma.deploymentProject.create({
      data: {
        name: `e2e-project-default-del-${suffix}`,
        organizationId: seedData.organization.id,
        isDefault: true,
      },
    });
    await db.prisma.deploymentProject.create({
      data: {
        name: `e2e-project-other-${suffix}`,
        organizationId: seedData.organization.id,
      },
    });

    await page.goto(`/deployments/projects/${defaultProject.id}/delete`);
    await expect(page.getByRole('heading', { name: 'Delete Project' })).toBeVisible();

    await page.getByLabel(`Type ${defaultProject.name} to confirm`).fill(defaultProject.name);
    await page.getByRole('button', { name: 'Delete Project' }).click();

    await expect(
      page.getByText('Default project cannot be deleted. Set another project as default first.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Delete Project' })).toBeVisible();

    const untouched = await db.prisma.deploymentProject.findUnique({ where: { id: defaultProject.id } });
    expect(untouched!.deletedAt).toBeNull();
    expect(untouched!.isDefault).toBe(true);
  });

  test('should refuse to delete the last remaining project', async ({ authenticatedPage, db, seedData }) => {
    const page = authenticatedPage;

    const project = await db.prisma.deploymentProject.create({
      data: {
        name: `e2e-project-last-${Date.now()}`,
        organizationId: seedData.organization.id,
      },
    });

    await page.goto(`/deployments/projects/${project.id}/delete`);
    await expect(page.getByRole('heading', { name: 'Delete Project' })).toBeVisible();

    await page.getByLabel(`Type ${project.name} to confirm`).fill(project.name);
    await page.getByRole('button', { name: 'Delete Project' }).click();

    await expect(page.getByText('Cannot delete the last project', { exact: true })).toBeVisible();

    const untouched = await db.prisma.deploymentProject.findUnique({ where: { id: project.id } });
    expect(untouched!.deletedAt).toBeNull();
  });
});
