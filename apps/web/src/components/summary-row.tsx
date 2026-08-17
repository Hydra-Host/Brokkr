export function SummaryRow({
  label,
  children,
  nullFallback = '—',
}: {
  label: string;
  children: React.ReactNode;
  nullFallback?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">
        {children ?? <span className="text-muted-foreground">{nullFallback}</span>}
      </span>
    </div>
  );
}
