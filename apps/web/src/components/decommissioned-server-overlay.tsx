export function DecommissionedServerOverlay({ deletedAt }: { deletedAt: string | null }) {
  if (!deletedAt) return null;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg bg-black/50">
      <div className="bg-card rounded-lg p-8 text-center">
        <h2 className="text-xl font-semibold">Server Decommissioned</h2>
        <p className="text-muted-foreground mt-2">This server has been decommissioned and can no longer be modified.</p>
      </div>
    </div>
  );
}
