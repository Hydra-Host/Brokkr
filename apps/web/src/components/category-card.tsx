import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { formatPrice } from '@repo/utils';
import { Link } from '@tanstack/react-router';

export interface InventoryCategory {
  name: string;
  chipset: string;
  manufacturers: string[];
  description: string;
  badgeList: string[];
  brandImages: string[];
  startPrice: number;
  priceFrequency: string;
  ctaButtonLabel: string;
  ctaButtonHref: string;
  hasPreorder: boolean;
  hasOnDemand: boolean;
  hasReserve: boolean;
  hasCluster: boolean;
}

export const CategoryCard: React.FC<{
  category: InventoryCategory;
  urlOverride?: string;
}> = ({ category, urlOverride }) => {
  const targetUrl = urlOverride ?? category.ctaButtonHref;
  const isExternalUrl = /^https?:\/\//.test(targetUrl);

  const cardContent = (
    <div
      key={category.name}
      className="border-border bg-bg-primary hover:border-accent relative grid grid-cols-1 gap-y-5 border p-4 transition-colors md:grid-cols-12 md:gap-x-5 md:gap-y-0"
    >
      <div className="relative z-10 col-span-7 2xl:col-span-8">
        <p className="mb-10 font-mono text-[2rem] font-bold">{category.name}</p>
        <div className="mb-[30px] flex flex-wrap gap-2.5 lg:w-4/5">
          {category.badgeList.map((badge) => (
            <Badge key={badge} className="bg-primary text-primary-foreground rounded-none border-transparent">
              {badge}
            </Badge>
          ))}
        </div>
        <p className="text-text-muted">{category.description}</p>
      </div>

      <div className="md:border-t-none border-border relative z-10 col-span-5 flex h-full flex-col gap-[30px] border-t pt-[30px] md:border-t-0 md:border-l md:pt-0 md:pl-[30px] 2xl:col-span-4">
        <div className="flex flex-wrap gap-5 md:gap-4 xl:gap-5">
          {category.brandImages.map((image, index) => (
            <img
              key={index}
              src={image}
              alt={`${category.manufacturers[index] || 'brand'} logo`}
              className="h-[50px] w-[100px] lg:h-[45px] lg:w-[90px] xl:h-[50px] xl:w-[100px]"
            />
          ))}
        </div>
        <div className="grid h-full w-full gap-5 2xl:col-span-4">
          <div className="grid h-full w-full grid-cols-5 sm:gap-y-0 md:grid-cols-1 md:gap-y-4 2xl:grid-cols-4">
            <div className="col-span-3 flex h-min flex-col justify-between 2xl:col-span-2">
              <p className="text-text-muted text-sm sm:text-base">Starting at</p>
              <div className="justify-self-end">
                <span className="text-status-online font-mono text-[1.5rem] sm:text-[2rem]">
                  {formatPrice(Number(category.startPrice))}
                </span>
                <span className="text-text-muted ml-1 text-xs">{category.priceFrequency}</span>
              </div>
            </div>

            <div className="col-span-2 flex h-min flex-col justify-between">
              <div className="flex h-full flex-col justify-between sm:self-end md:self-start 2xl:self-end">
                <p className="text-text-muted mb-2 text-sm sm:text-base">Stock available</p>
                <div>
                  {category.hasOnDemand && <p className="text-accent text-sm">On demand</p>}
                  {category.hasReserve && <p className="text-accent text-sm">Reserve</p>}
                  {category.hasPreorder && <p className="text-accent text-sm">Pre-order</p>}
                </div>
              </div>
            </div>
          </div>
          <div className="self-end">
            <Button className="bg-primary text-primary-foreground pointer-events-none w-full rounded-none font-mono text-base">
              {category.ctaButtonLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  if (isExternalUrl) {
    return (
      <a href={targetUrl} className="relative block">
        {cardContent}
      </a>
    );
  }

  return (
    <Link to={targetUrl} className="relative block" preload="intent">
      {cardContent}
    </Link>
  );
};
