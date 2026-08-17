// min-w-0 is load-bearing: a grid item defaults to min-width:auto, so without it a long value widens
// its own track and the whole row overflows the column rather than wrapping inside the tile.
export function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="border-border-dim bg-bg-secondary min-w-0 rounded-lg border p-3">
      <div className="text-text-dim truncate text-[10px] tracking-wide uppercase">{label}</div>
      <div className="text-text-primary mt-0.5 font-mono text-sm break-words">{value}</div>
      {sub && <div className="text-text-dim mt-0.5 font-mono text-[11px] break-words">{sub}</div>}
    </div>
  );
}
