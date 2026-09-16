export function Pill({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-text-muted">{label}</span>
      <span className={`font-mono ${tone}`}>{value}</span>
    </span>
  );
}
