import { z } from 'zod';
import { PaginationMetaSchema, PaginationQuerySchema } from './pagination';

export const AnalyticsDateRangeQuerySchema = z.object({
  startDate: z.string().optional().describe('Start of the date range (ISO 8601)'),
  endDate: z.string().optional().describe('End of the date range (ISO 8601)'),
});

export type AnalyticsDateRangeQuery = z.infer<typeof AnalyticsDateRangeQuerySchema>;

export const RentalInvoiceSchema = z.object({
  invoiceId: z.string().describe('Unique identifier for the invoice'),
  invoiceNumber: z.string().nullable().describe('Human-readable invoice number'),
  invoiceDate: z.string().describe('Date the invoice was issued (YYYY-MM-DD)'),
  periodStart: z.string().describe('Start of the billing period (YYYY-MM-DD)'),
  periodEnd: z.string().describe('End of the billing period (YYYY-MM-DD)'),
  invoiceStatus: z.string().describe('Current status of the invoice (e.g., paid, pending)'),
  contractType: z.string().nullable().describe('Type of contract for this invoice'),
  term: z.union([z.string(), z.number()]).nullable().describe('Contract term length'),
  interruptibleNotice: z
    .union([z.string(), z.number()])
    .nullable()
    .describe('Interruptible notice period, if applicable'),
  onBrokkr: z
    .union([z.string(), z.number(), z.boolean()])
    .nullable()
    .describe('Whether this invoice is managed through Brokkr'),
  productId: z.string().nullable().describe('Identifier for the associated product'),
  productType: z.string().nullable().describe('Type of product (e.g., GPU, CPU, storage)'),
  productModel: z.string().nullable().describe('Model name of the product'),
  gpuQuantity: z.number().nullable().describe('Number of GPUs billed'),
  cpuQuantity: z.number().nullable().describe('Number of CPUs billed'),
  storageQuantity: z.number().nullable().describe('Amount of storage billed'),
  billingFrequency: z.string().nullable().describe('How often billing occurs (e.g., hourly, monthly)'),
  collectionMethod: z.string().nullable().describe('Payment collection method'),
  supplierRate: z.number().nullable().describe('Rate charged to the supplier'),
  supplierPriceTotal: z.number().nullable().describe('Total amount owed to the supplier'),
  effectiveUsage: z.number().nullable().describe('Effective usage during the billing period'),
  invoiceDueDate: z.string().nullable().describe('Date by which the invoice payment is due (YYYY-MM-DD)'),
});

export type RentalInvoice = z.infer<typeof RentalInvoiceSchema>;

export const RentalInvoicesResponseSchema = z.object({
  invoices: z.array(RentalInvoiceSchema).describe('List of rental invoices'),
  summary: z
    .object({
      totalRevenue: z.number().describe('Total revenue across all invoices'),
      invoiceCount: z.number().describe('Total number of invoices'),
      paidCount: z.number().describe('Number of paid invoices'),
      pendingCount: z.number().describe('Number of pending invoices'),
    })
    .describe('Aggregate summary of invoice metrics'),
  truncated: z.boolean().optional().describe('True when the invoice list was cut off at the row cap'),
});

export type RentalInvoicesResponse = z.infer<typeof RentalInvoicesResponseSchema>;

export const RentalInvoicesPaginatedQuerySchema = PaginationQuerySchema.extend({
  startDate: z.string().optional().describe('Filter invoices from this date'),
  endDate: z.string().optional().describe('Filter invoices until this date'),
  status: z.string().optional().describe('Filter invoices by status'),
});

export type RentalInvoicesPaginatedQuery = z.infer<typeof RentalInvoicesPaginatedQuerySchema>;

export const RentalInvoicesPaginatedResponseSchema = z.object({
  data: z.array(RentalInvoiceSchema).describe('Paginated list of rental invoices'),
  meta: PaginationMetaSchema.describe('Pagination metadata'),
});

export type RentalInvoicesPaginatedResponse = z.infer<typeof RentalInvoicesPaginatedResponseSchema>;

export const RentalInvoicesSummarySchema = z.object({
  totalRevenue: z.number().describe('Total revenue across all invoices'),
  invoiceCount: z.number().describe('Total number of invoices'),
  paidCount: z.number().describe('Number of paid invoices'),
  pendingCount: z.number().describe('Number of pending invoices'),
});

export type RentalInvoicesSummary = z.infer<typeof RentalInvoicesSummarySchema>;
