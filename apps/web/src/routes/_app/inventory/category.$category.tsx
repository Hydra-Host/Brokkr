import { PrivateCategoryItemCard } from '@/components/category-item-card';
import { tsr } from '@/lib/api';
import { inventoryCategories, mergeCategoryPrices } from '@/lib/category-data';
import { PluginSlot } from '@/plugin-host/plugin-slot';
import { DeviceCategoriesSchema, type InventoryListing } from '@repo/api-client';
import { useSession } from '@repo/auth/client';
import { ServerPagination } from '@repo/ui/components/server-pagination';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { usePagination } from '@repo/ui/hooks/use-pagination';
import { formatCategoryTitle } from '@repo/utils/format';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';

import { useCallback } from 'react';

export const Route = createFileRoute('/_app/inventory/category/$category')({
  staticData: {
    breadcrumb: (loaderData: unknown) => {
      const data = loaderData as { categoryName?: string } | undefined;
      return data?.categoryName || 'Category';
    },
  },

  loader: async ({ context: { queryClient }, params }) => {
    const { category } = params;

    const parseResult = DeviceCategoriesSchema.safeParse(category);
    if (!parseResult.success) {
      throw redirect({ to: '/inventory/categories' });
    }

    const [categoryPricesResponse, categoryAvailabilityResponse] = await Promise.all([
      queryClient.ensureQueryData({
        queryKey: ['categoryPrices'],
        queryFn: () => tsr.getCategoryPrices.query({ query: {} }),
      }),
      queryClient.ensureQueryData({
        queryKey: ['categoryAvailability'],
        queryFn: () => tsr.getCategoryAvailability.query({ query: {} }),
      }),
    ]);

    const categoryPrices = categoryPricesResponse.status === 200 ? categoryPricesResponse.body.data : [];
    const categoryAvailability =
      categoryAvailabilityResponse.status === 200 ? categoryAvailabilityResponse.body.data : [];

    const categories = mergeCategoryPrices(inventoryCategories, categoryPrices, categoryAvailability);

    const categoryData = categories.find((cat) => cat.chipset.toLowerCase() === category.toLowerCase());
    const categoryName = categoryData?.name || `${formatCategoryTitle(category)} Servers`;

    return {
      categories,
      categoryName,
    };
  },
  component: InventoryCategoryDetail,
});

function InventoryCategoryDetail() {
  const { categories } = Route.useLoaderData();
  const { category } = Route.useParams();
  const { data: session } = useSession();
  const userEmail = session?.user?.email;

  const categoryData = categories.find((cat) => cat.chipset.toLowerCase() === category.toLowerCase());
  const categoryName = categoryData?.name || `${formatCategoryTitle(category)} Servers`;

  useDocumentTitle(categoryName);

  const parseResult = DeviceCategoriesSchema.safeParse(category);
  const validCategory = parseResult.success ? parseResult.data : undefined;

  const { page, setPage, pageSize, setPageSize } = usePagination({ defaultPageSize: 10 });

  const inventoryFilters = validCategory ? `category:eq:${validCategory}|status:eq:on demand` : 'status:eq:on demand';

  const { data: inventoryResponse, isFetching } = tsr.getInventory.useQuery({
    queryKey: ['inventory', category, page, pageSize],
    queryData: {
      query: {
        filters: inventoryFilters,
        page,
        pageSize,
      },
    },
    placeholderData: keepPreviousData,
  });

  const listings = inventoryResponse?.status === 200 ? inventoryResponse.body.data : [];
  const meta = inventoryResponse?.status === 200 ? inventoryResponse.body.meta : undefined;

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

  const hasListings = meta ? meta.totalItems > 0 : false;

  return (
    <div className="flex min-h-full flex-col">
      <div className="space-y-4">
        {meta && (
          <ServerPagination meta={meta} onPageChange={setPage} pageSize={pageSize} onPageSizeChange={setPageSize} />
        )}

        <div className={isFetching ? 'opacity-60 transition-opacity' : 'space-y-4'}>{renderListingGrid(listings)}</div>
      </div>

      {!isFetching && !hasListings && (
        <div className="border-border bg-card w-full max-w-[560px] rounded-lg border p-6 md:p-8">
          <h2 className="mb-2 text-2xl font-bold">We&apos;re at capacity right now!</h2>
          <p className="text-muted-foreground max-w-3xl">
            All available {categoryName.toUpperCase()}&apos;s are currently reserved. Between our flexible rental terms
            and new machines coming online every week, our team is ready to help you find the perfect machine!
          </p>
        </div>
      )}

      {meta !== undefined && (
        <PluginSlot
          name="inventory-page-extras"
          category={category}
          userEmail={userEmail}
          hasListings={hasListings}
          isAuthenticated={true}
        />
      )}
    </div>
  );
}
