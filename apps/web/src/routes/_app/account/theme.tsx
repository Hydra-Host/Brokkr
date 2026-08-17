import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { THEME_CATEGORIES, useTheme } from '@repo/ui/theme-provider';
import { createFileRoute } from '@tanstack/react-router';
import { Monitor } from 'lucide-react';

export const Route = createFileRoute('/_app/account/theme')({
  staticData: { breadcrumb: 'Theme' },
  component: ThemeSettings,
});

function ThemeSettings() {
  const { theme, mode, setTheme, setSystemMode, preferredDark, preferredLight } = useTheme();

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
          <CardDescription>Customize the appearance of the application by selecting a color theme.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-8">
            <div className="space-y-4">
              <div>
                <h3 className="text-foreground text-sm font-medium">System</h3>
                <p className="text-text-dim mt-1 text-xs">
                  Switches between your preferred dark and light themes based on your OS appearance
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                <button
                  onClick={setSystemMode}
                  className={`relative flex flex-col items-center gap-3 rounded-sm border p-6 transition-all ${
                    mode === 'system' ? 'border-accent' : 'border-border hover:border-text-muted'
                  }`}
                >
                  <Monitor className="text-text-muted h-10 w-10" />
                  <span
                    className="font-mono text-sm font-medium"
                    style={{ color: mode === 'system' ? 'var(--color-accent)' : undefined }}
                  >
                    Auto
                  </span>
                </button>
              </div>
            </div>

            {THEME_CATEGORIES.map((category) => (
              <div key={category.name} className="space-y-4">
                <div>
                  <h3 className="text-foreground text-sm font-medium">{category.name}</h3>
                  {category.description && <p className="text-text-dim mt-1 text-xs">{category.description}</p>}
                </div>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                  {category.themes.map((option) => {
                    const isPreferred = option.value === preferredDark || option.value === preferredLight;
                    const isActive = mode !== 'system' && theme === option.value;
                    return (
                      <button
                        key={option.value}
                        onClick={() => setTheme(option.value)}
                        className={`relative flex flex-col items-center gap-3 rounded-sm border p-6 transition-all ${
                          isActive ? 'border-accent' : 'border-border hover:border-text-muted'
                        }`}
                        style={{
                          backgroundColor: isActive ? `${option.color}15` : undefined,
                        }}
                      >
                        {isPreferred && (
                          <Badge
                            variant="outline"
                            className="text-text-muted absolute top-2 right-2 px-1 py-0 font-mono text-[9px] leading-tight"
                          >
                            preferred
                          </Badge>
                        )}
                        <div
                          className="h-10 w-10"
                          style={{ backgroundColor: option.color, boxShadow: `0 0 16px ${option.color}60` }}
                        />
                        <span
                          className="font-mono text-sm font-medium"
                          style={{ color: isActive ? option.color : undefined }}
                        >
                          {option.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="text-text-muted text-sm">This setting is stored locally in your browser.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
