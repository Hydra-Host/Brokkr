import { Badge } from '@repo/ui/components/badge';
import { Label } from '@repo/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@repo/ui/components/select';
import { formatPrice } from '@repo/utils';
import { createFileRoute, Link, Outlet, useMatch, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import type { InventoryCategory } from '~/components/category-card';
import { tsr } from '~/lib/api';
import { inventoryCategories, mergeCategoryPrices } from '~/lib/category-data';
import { PluginSlot } from '~/plugin-host/plugin-slot';

const inventorySearchSchema = z.object({
  chipset: z.string().optional().catch(undefined),
  manufacturer: z.string().optional().catch(undefined),
  availability: z.string().optional().catch(undefined),
  tag: z.string().optional().catch(undefined),
});

const CATEGORY_PRICES_KEY = ['categoryPrices'] as const;
const CATEGORY_AVAILABILITY_KEY = ['categoryAvailability'] as const;

export const Route = createFileRoute('/_navbar-layout/inventory')({
  validateSearch: inventorySearchSchema,
  loader: async ({ context: { queryClient } }) => {
    const [pricesResponse, availabilityResponse] = await Promise.all([
      queryClient.ensureQueryData({
        queryKey: CATEGORY_PRICES_KEY,
        queryFn: () => tsr.getCategoryPrices.query({ query: {} }),
      }),
      queryClient.ensureQueryData({
        queryKey: CATEGORY_AVAILABILITY_KEY,
        queryFn: () => tsr.getCategoryAvailability.query({ query: {} }),
      }),
    ]);

    const categoryPrices = pricesResponse.status === 200 ? pricesResponse.body.data : [];
    const categoryAvailability = availabilityResponse.status === 200 ? availabilityResponse.body.data : [];
    return mergeCategoryPrices(inventoryCategories, categoryPrices, categoryAvailability);
  },
  component: InventoryCategories,
});

function InventoryCategories() {
  const { chipset, manufacturer, availability, tag } = Route.useSearch();
  const navigate = useNavigate();
  const categories = Route.useLoaderData();

  const childMatch = useMatch({ from: '/_navbar-layout/inventory/categories/$category', shouldThrow: false });
  const isChildRoute = !!childMatch;

  const chipsetFilter = chipset ?? 'all';
  const manufacturerFilter = manufacturer ?? 'all';
  const availabilityFilter = availability ?? 'all';
  const tagFilter = tag ?? 'all';

  const uniqueChipsets = Array.from(new Set(categories.map((cat) => cat.chipset))).sort();
  const uniqueManufacturers = Array.from(new Set(categories.flatMap((cat) => cat.manufacturers))).sort();
  const uniqueTags = Array.from(new Set(categories.flatMap((cat) => cat.badgeList))).sort();

  const filteredCategories = categories.filter((category) => {
    const chipsetMatch = chipsetFilter === 'all' || category.chipset === chipsetFilter;
    const manufacturerMatch = manufacturerFilter === 'all' || category.manufacturers.includes(manufacturerFilter);
    const availabilityMatch =
      availabilityFilter === 'all' ||
      (availabilityFilter === 'onDemand' && category.hasOnDemand) ||
      (availabilityFilter === 'reserve' && category.hasReserve) ||
      (availabilityFilter === 'preorder' && category.hasPreorder);
    const tagMatch = tagFilter === 'all' || category.badgeList.includes(tagFilter);
    return chipsetMatch && manufacturerMatch && availabilityMatch && tagMatch;
  });

  const handleFilterChange = (filterType: 'chipset' | 'manufacturer' | 'availability' | 'tag', value: string) => {
    navigate({
      to: Route.fullPath,
      search: (prev) => ({
        ...prev,
        [filterType]: value === 'all' ? undefined : value,
      }),
    });
  };

  if (isChildRoute) {
    return <Outlet />;
  }

  return (
    <>
      <div className="mb-12 space-y-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <h1 className="text-4xl font-bold text-white lg:text-5xl">Inventory</h1>
          <div className="flex shrink-0 flex-wrap gap-3 sm:gap-6 lg:flex-nowrap [&>div]:flex-1 [&>div]:sm:flex-none">
            <div className="flex flex-col gap-2">
              <Label htmlFor="availability-filter" className="text-purple-light">
                Availability
              </Label>
              <Select value={availabilityFilter} onValueChange={(value) => handleFilterChange('availability', value)}>
                <SelectTrigger id="availability-filter" className="w-full sm:w-[180px]">
                  <SelectValue placeholder="All Availability" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Availability</SelectItem>
                  <SelectItem value="onDemand">On Demand</SelectItem>
                  <SelectItem value="reserve">Reserve</SelectItem>
                  <SelectItem value="preorder">Pre-order</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="chipset-filter" className="text-purple-light">
                Chipset
              </Label>
              <Select value={chipsetFilter} onValueChange={(value) => handleFilterChange('chipset', value)}>
                <SelectTrigger id="chipset-filter" className="w-full sm:w-[180px]">
                  <SelectValue placeholder="All Chipsets" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Chipsets</SelectItem>
                  {uniqueChipsets.map((chipset) => (
                    <SelectItem key={chipset} value={chipset}>
                      {chipset}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="manufacturer-filter" className="text-purple-light">
                Manufacturer
              </Label>
              <Select value={manufacturerFilter} onValueChange={(value) => handleFilterChange('manufacturer', value)}>
                <SelectTrigger id="manufacturer-filter" className="w-full sm:w-[180px]">
                  <SelectValue placeholder="All Manufacturers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Manufacturers</SelectItem>
                  {uniqueManufacturers.map((manufacturer) => (
                    <SelectItem key={manufacturer} value={manufacturer}>
                      {manufacturer}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="tag-filter" className="text-purple-light">
                Tag
              </Label>
              <Select value={tagFilter} onValueChange={(value) => handleFilterChange('tag', value)}>
                <SelectTrigger id="tag-filter" className="w-full sm:w-[220px]">
                  <SelectValue placeholder="All Tags" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Tags</SelectItem>
                  {uniqueTags.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <p className="text-purple-light text-lg">
          Explore our comprehensive selection of high-performance GPUs and computing resources. From cutting-edge AI
          accelerators to versatile workstation graphics cards, find the perfect hardware for your computational needs.
        </p>
      </div>

      {filteredCategories.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filteredCategories.map((category) => (
            <CompactCategoryCard key={category.chipset} category={category} />
          ))}
        </div>
      ) : (
        <div className="py-12 text-center">
          <p className="text-muted-foreground font-mono text-lg">No categories match your filters.</p>
        </div>
      )}

      <PluginSlot name="inventory-page-extras" hasListings={false} isAuthenticated={false} />
    </>
  );
}

function CompactCategoryCard({ category }: { category: InventoryCategory }) {
  const hasAvailability = category.hasOnDemand || category.hasReserve || category.hasPreorder;
  const targetUrl = `/inventory/categories/${category.chipset.toLowerCase()}`;

  return (
    <Link
      to={targetUrl}
      preload="intent"
      className="border-border bg-bg-primary hover:border-text-dim group relative flex flex-col justify-between rounded-sm border p-5 font-mono transition-all hover:shadow-lg"
    >
      <div>
        <div className="flex items-start justify-between gap-2">
          <span className="text-foreground text-3xl font-bold">{category.chipset}</span>
          <div className="-mt-1 flex shrink-0 gap-2">
            {category.brandImages.map((image, index) => (
              <img
                key={index}
                src={image}
                alt={`${category.manufacturers[index] || 'brand'} logo`}
                className="h-[40px] w-[80px] object-contain"
              />
            ))}
          </div>
        </div>

        <p className="text-muted-foreground mt-1 text-xs">{category.manufacturers.join(', ')}</p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {category.badgeList.map((badge) => (
            <Badge key={badge} className="bg-primary text-primary-foreground rounded-none border-transparent text-xs">
              {badge}
            </Badge>
          ))}
        </div>
      </div>

      <div className="border-border/30 mt-5 flex items-center justify-between border-t pt-4">
        <div className="flex flex-wrap gap-1.5">
          {category.hasOnDemand && (
            <Badge className="border-accent/30 bg-accent/10 text-accent text-xs">On demand</Badge>
          )}
          {category.hasReserve && <Badge className="border-accent/30 bg-accent/10 text-accent text-xs">Reserve</Badge>}
          {category.hasPreorder && (
            <Badge className="border-accent/30 bg-accent/10 text-accent text-xs">Pre-order</Badge>
          )}
          {!hasAvailability && (
            <Badge className="border-muted-foreground/30 bg-muted/50 text-muted-foreground text-xs">Unavailable</Badge>
          )}
        </div>
        {category.startPrice > 0 && (
          <span className="text-muted-foreground text-sm">
            from <span className="text-status-online text-lg font-bold">{formatPrice(category.startPrice)}</span>
            <span className="text-muted-foreground text-xs"> {category.priceFrequency}</span>
          </span>
        )}
      </div>
    </Link>
  );
}
