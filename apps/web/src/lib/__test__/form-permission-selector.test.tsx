import { FormPermissionSelector } from '@repo/ui/form/form-permission-selector';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';

type FormValues = { permissions: string[] };
type Permission = { resource: string; action: string };

function TestForm({
  onSubmit,
  permissions,
  isPermissionCatalogAuthoritative,
}: {
  onSubmit: (values: FormValues) => void;
  permissions: Permission[];
  isPermissionCatalogAuthoritative: boolean;
}) {
  const form = useForm<FormValues>({
    defaultValues: { permissions: ['device:read', 'device:removed'] },
  });

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <FormPermissionSelector
        control={form.control}
        name="permissions"
        label="Permissions"
        permissions={permissions}
        isPermissionCatalogAuthoritative={isPermissionCatalogAuthoritative}
      />
      <button type="submit">Submit</button>
    </form>
  );
}

describe('FormPermissionSelector', () => {
  it('preserves selected keys while the permission catalog is not authoritative', async () => {
    const onSubmit = vi.fn();
    render(<TestForm onSubmit={onSubmit} permissions={[]} isPermissionCatalogAuthoritative={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ permissions: ['device:read', 'device:removed'] }, expect.anything());
    });
    expect(screen.getByText('Permissions (2 selected)')).toBeInTheDocument();
  });

  it('removes selected keys that are absent from the available permission catalog', async () => {
    const onSubmit = vi.fn();
    render(
      <TestForm
        onSubmit={onSubmit}
        permissions={[{ resource: 'device', action: 'read' }]}
        isPermissionCatalogAuthoritative={true}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ permissions: ['device:read'] }, expect.anything());
    });
    expect(screen.getByText('Permissions (1 selected)')).toBeInTheDocument();
  });
});
