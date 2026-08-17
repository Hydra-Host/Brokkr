-- Drop the legacy billing subsystem.
--
-- These tables are unused — there is no billing/subscription/invoice service,
-- no active-record classes, and no Prisma-client callers (Stripe was already
-- removed in 20260615000000_remove_stripe; rental-invoice analytics is served
-- from ClickHouse, not these tables). Drop the tables child-first so each
-- table's outbound FKs are gone before the table it references, then drop the
-- now-orphaned enum types.

DROP TABLE "Transaction";
DROP TABLE "SubscriptionsInInvoice";
DROP TABLE "SubscriptionItem";
DROP TABLE "Invoice";
DROP TABLE "Subscription";
DROP TABLE "BillingInformation";
DROP TABLE "OpenmeterWebhookEvent";

DROP TYPE "TransactionType";
DROP TYPE "TransactionStatus";
DROP TYPE "InvoiceStatus";
DROP TYPE "SubscriptionItemType";
DROP TYPE "SubscriptionStatus";
DROP TYPE "BillingProvider";
DROP TYPE "OpenmeterWebhookEventType";
DROP TYPE "NetTerms";
