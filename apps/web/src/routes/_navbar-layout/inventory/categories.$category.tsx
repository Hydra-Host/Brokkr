import { PrivateCategoryItemCard } from '@/components/category-item-card';
import { tsr } from '@/lib/api';
import { inventoryCategories, mergeCategoryPrices } from '@/lib/category-data';
import { PluginSlot } from '@/plugin-host/plugin-slot';
import { DeviceCategoriesSchema, type InventoryListing } from '@repo/api-client';
import { useSession } from '@repo/auth/client';
import { Button } from '@repo/ui/components/button';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

export const Route = createFileRoute('/_navbar-layout/inventory/categories/$category')({
  loader: async ({ context: { queryClient }, params }) => {
    const { category } = params;

    const parseResult = DeviceCategoriesSchema.safeParse(category);
    if (!parseResult.success) {
      throw redirect({ to: '/inventory' });
    }

    const [inventoryResponse, categoryPricesResponse, categoryAvailabilityResponse] = await Promise.all([
      queryClient.ensureQueryData({
        queryKey: ['inventory', category],
        queryFn: () =>
          tsr.getInventory.query({
            query: {
              filters: `category:eq:${parseResult.data}|status:eq:on demand`,
              pageSize: 100,
            },
          }),
      }),
      queryClient.ensureQueryData({
        queryKey: ['categoryPrices'],
        queryFn: () => tsr.getCategoryPrices.query({ query: {} }),
      }),
      queryClient.ensureQueryData({
        queryKey: ['categoryAvailability'],
        queryFn: () => tsr.getCategoryAvailability.query({ query: {} }),
      }),
    ]);

    const listings = inventoryResponse.status === 200 ? inventoryResponse.body.data : [];
    const categoryPrices = categoryPricesResponse.status === 200 ? categoryPricesResponse.body.data : [];
    const categoryAvailability =
      categoryAvailabilityResponse.status === 200 ? categoryAvailabilityResponse.body.data : [];

    const categories = mergeCategoryPrices(inventoryCategories, categoryPrices, categoryAvailability);

    return {
      listings,
      categories,
    };
  },
  component: InventoryCategoriesCategory,
});

function InventoryCategoriesCategory() {
  const { listings, categories } = Route.useLoaderData();
  const { category } = Route.useParams();
  const { data: session, isPending: sessionPending } = useSession();
  const userEmail = session?.user?.email;

  // Cap the session-check wait: it only avoids flashing the plugin lead wall at signed-in visitors, so a stalled auth request must not suppress the wall for anonymous ones.
  const [sessionWaitExpired, setSessionWaitExpired] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSessionWaitExpired(true), 3000);
    return () => clearTimeout(timer);
  }, []);
  const sessionSettled = !sessionPending || sessionWaitExpired;

  const getPrice = useCallback((listing: InventoryListing) => {
    return listing.listing.onDemandPrice.perHour.perGpu ?? listing.listing.onDemandPrice.perHour.total ?? 0;
  }, []);

  const categoryData = categories.find((cat) => cat.chipset.toLowerCase() === category.toLowerCase());

  const renderListingGrid = useCallback(
    (listingsSubset: InventoryListing[]) => (
      <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {listingsSubset.map((listing) => (
          <PrivateCategoryItemCard
            key={listing.id}
            id={listing.id}
            primaryIP4={listing.networking.ipv4}
            primaryIP6={listing.networking.ipv6}
            inInventory={listing.stockStatus === 'on demand'}
            name={listing.name}
            isTeeCapable={listing.isTeeCapable}
            vpcCapable={listing.networking.vpcCapable}
            gpuModel={listing.specs.gpu?.model}
            gpuCount={listing.specs.gpu?.count}
            cpuModel={listing.specs.cpu?.model}
            cpuCount={listing.specs.cpu?.count}
            cpuCoreCount={listing.specs.cpu?.totalCores}
            memory={listing.specs.memory.total}
            ssdCount={listing.specs.storage?.ssdCount}
            ssdSize={listing.specs.storage?.ssdSize}
            hddCount={listing.specs.storage?.hddCount}
            hddSize={listing.specs.storage?.hddSize}
            nvmeCount={listing.specs.storage?.nvmeCount}
            nvmeSize={listing.specs.storage?.nvmeSize}
            location={listing.location}
            status={listing.stockStatus}
            priceAmount={listing.listing.onDemandPrice.perHour.perGpu ?? listing.listing.onDemandPrice.perHour.total}
            interruptiblePriceAmount={
              listing.listing.interruptiblePrice.perHour.perGpu ?? listing.listing.interruptiblePrice.perHour.total
            }
            interruptibleOnly={listing.listing.isInterruptibleOnly}
            isInterruptibleDeployment={listing.isInterruptibleDeployment}
            interruptibleNoticePeriod={listing.interruptibleNoticePeriod}
            category={category}
            userEmail={userEmail}
          />
        ))}
      </div>
    ),
    [category, userEmail],
  );

  const categoryName = categoryData?.name || `${category.toUpperCase()} Servers`;
  const categoryDescription =
    categoryData?.description ||
    `Browse our available ${category.toUpperCase()} GPU servers. These high-performance systems are ready for immediate deployment with flexible rental terms and enterprise-grade reliability.`;

  const sortedListings = useMemo(() => {
    return [...listings].sort((a, b) => getPrice(a) - getPrice(b));
  }, [listings, getPrice]);

  return (
    <div className="flex min-h-full flex-col">
      <div className="mb-12 flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex-1">
          <h1 className="mb-4 text-4xl font-bold text-white lg:text-5xl">{categoryName}</h1>
          <p className="text-purple-light max-w-4xl text-lg">{categoryDescription}</p>
        </div>

        <div className="flex items-start">
          <Button
            asChild
            variant="outline"
            size="lg"
            className="border-white/20 bg-white/10 text-white hover:bg-white/20"
          >
            <Link to="/inventory">
              <ChevronLeft className="mr-2 h-5 w-5" />
              Back to Categories
            </Link>
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        {renderListingGrid(sortedListings)}

        {listings.length === 0 && (
          <div className="border-border bg-card w-full max-w-[560px] rounded-lg border p-6 md:p-8">
            <h2 className="mb-2 text-2xl font-bold">We&apos;re at capacity right now!</h2>
            <p className="text-muted-foreground max-w-3xl">
              All available {categoryName.toUpperCase()}&apos;s are currently reserved. Between our flexible rental
              terms and new machines coming online every week, our team is ready to help you find the perfect machine!
            </p>
          </div>
        )}
      </div>

      {sessionSettled && (
        <PluginSlot
          name="inventory-page-extras"
          category={category}
          userEmail={userEmail}
          hasListings={listings.length > 0}
          isAuthenticated={false}
          sessionPending={sessionPending}
        />
      )}
    </div>
  );
}
