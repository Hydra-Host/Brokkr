import { cn } from '@repo/ui/utils';

export const DetailListItem = ({
  name,
  value,
  className,
}: {
  name: string;
  value?: string | number | null;
  className?: string;
}) => {
  return (
    value !== null &&
    value !== undefined &&
    value !== 0 &&
    value !== '' && (
      <div className={cn('flex justify-between gap-10 py-[10px] text-sm', className)}>
        <dt className="font-bold">{name}</dt>
        <dd>{value}</dd>
      </div>
    )
  );
};
