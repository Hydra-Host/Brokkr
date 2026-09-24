import { ThemeSettingsPanel } from '@repo/ui/theme-settings-panel';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/account/theme')({
  staticData: { breadcrumb: 'Theme' },
  component: ThemeSettings,
});

function ThemeSettings() {
  return <ThemeSettingsPanel />;
}
