export type QueryableLeaf = {
  title: string;
  url: string;
  sectionTitle?: string | null;
};

export function filterLeavesByQuery<T extends QueryableLeaf>(leaves: T[], query: string): T[] {
  const q = query.toLowerCase();
  if (!q) return leaves;
  return leaves.filter((leaf) => {
    const title = leaf.title.toLowerCase();
    const section = leaf.sectionTitle?.toLowerCase() ?? '';
    const url = leaf.url.toLowerCase();
    return title.includes(q) || section.includes(q) || url.includes(q);
  });
}
