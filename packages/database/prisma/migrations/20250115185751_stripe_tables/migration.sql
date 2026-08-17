-- CreateTable
CREATE TABLE "StripePaymentIntent" (
    "paymentIntentId" TEXT NOT NULL,
    "source" TEXT,
    "amountPaid" INTEGER,
    "amountReceived" INTEGER,
    "status" TEXT,
    "timestamp" TIMESTAMP(3),
    "stripeCustomerId" TEXT,
    "customerEmail" TEXT,
    "amountDue" INTEGER,
    "customerOrg" TEXT,
    "deviceId" INTEGER,

    CONSTRAINT "StripePaymentIntent_pkey" PRIMARY KEY ("paymentIntentId")
);

-- CreateTable
CREATE TABLE "StripeCustomer" (
    "stripeCustomerId" TEXT NOT NULL,
    "organizationId" TEXT,
    "email" TEXT NOT NULL,

    CONSTRAINT "StripeCustomer_pkey" PRIMARY KEY ("stripeCustomerId")
);

-- CreateTable
CREATE TABLE "StripeCharge" (
    "chargeId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "amountCaptured" INTEGER,
    "amountRefunded" INTEGER,
    "currency" TEXT,
    "status" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "stripeCustomerId" TEXT,
    "receiptEmail" TEXT,
    "description" TEXT,
    "livemode" BOOLEAN,
    "created" TIMESTAMP(3) NOT NULL,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "cardExpMonth" INTEGER,
    "cardExpYear" INTEGER,
    "captured" BOOLEAN,
    "failureReason" TEXT,
    "stripePaymentIntentId" TEXT,

    CONSTRAINT "StripeCharge_pkey" PRIMARY KEY ("chargeId")
);

-- CreateTable
CREATE TABLE "StripeInvoice" (
    "invoiceId" TEXT NOT NULL,
    "accountCountry" TEXT,
    "accountName" TEXT,
    "amountDue" INTEGER,
    "amountPaid" INTEGER,
    "amountRemaining" INTEGER,
    "currency" TEXT,
    "stripeCustomerId" TEXT,
    "customerEmail" TEXT,
    "customerName" TEXT,
    "billingReason" TEXT,
    "collectionMethod" TEXT,
    "status" TEXT,
    "subtotal" INTEGER,
    "total" INTEGER,
    "dueDate" TIMESTAMP(3),
    "created" TIMESTAMP(3),
    "hostedInvoiceUrl" TEXT,
    "invoicePdf" TEXT,
    "livemode" BOOLEAN,
    "description" TEXT,

    CONSTRAINT "StripeInvoice_pkey" PRIMARY KEY ("invoiceId")
);

-- CreateTable
CREATE TABLE "StripeProduct" (
    "productId" TEXT NOT NULL,
    "name" TEXT,
    "active" BOOLEAN,
    "created" TIMESTAMP(3),
    "updated" TIMESTAMP(3),
    "livemode" BOOLEAN,
    "cpuCoreCount" TEXT,
    "cpuModel" TEXT,
    "gpuCount" TEXT,
    "gpuModel" TEXT,
    "memory" TEXT,
    "tenant" TEXT,

    CONSTRAINT "StripeProduct_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "StripePrice" (
    "priceId" TEXT NOT NULL,
    "stripeProductId" TEXT,
    "active" BOOLEAN,
    "billingScheme" TEXT,
    "created" TIMESTAMP(3),
    "currency" TEXT,
    "livemode" BOOLEAN,
    "recurringInterval" TEXT,
    "recurringIntervalCount" INTEGER,
    "usageType" TEXT,
    "unitAmount" DOUBLE PRECISION,
    "taxBehavior" TEXT,

    CONSTRAINT "StripePrice_pkey" PRIMARY KEY ("priceId")
);

-- CreateTable
CREATE TABLE "StripeSubscription" (
    "subscriptionId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "status" TEXT,
    "currency" TEXT,
    "billingCycleAnchor" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "created" TIMESTAMP(3),
    "collectionMethod" TEXT,
    "quantity" INTEGER,
    "stripeProductId" TEXT,
    "stripePriceId" TEXT,
    "unitAmount" DOUBLE PRECISION,
    "invoiceId" TEXT,
    "livemode" BOOLEAN,

    CONSTRAINT "StripeSubscription_pkey" PRIMARY KEY ("subscriptionId")
);

-- AddForeignKey
ALTER TABLE "StripePaymentIntent" ADD CONSTRAINT "StripePaymentIntent_stripeCustomerId_fkey" FOREIGN KEY ("stripeCustomerId") REFERENCES "StripeCustomer"("stripeCustomerId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripePaymentIntent" ADD CONSTRAINT "StripePaymentIntent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "NetboxDevices"("deviceId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeCharge" ADD CONSTRAINT "StripeCharge_stripeCustomerId_fkey" FOREIGN KEY ("stripeCustomerId") REFERENCES "StripeCustomer"("stripeCustomerId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeCharge" ADD CONSTRAINT "StripeCharge_stripePaymentIntentId_fkey" FOREIGN KEY ("stripePaymentIntentId") REFERENCES "StripePaymentIntent"("paymentIntentId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeInvoice" ADD CONSTRAINT "StripeInvoice_stripeCustomerId_fkey" FOREIGN KEY ("stripeCustomerId") REFERENCES "StripeCustomer"("stripeCustomerId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripePrice" ADD CONSTRAINT "StripePrice_stripeProductId_fkey" FOREIGN KEY ("stripeProductId") REFERENCES "StripeProduct"("productId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeSubscription" ADD CONSTRAINT "StripeSubscription_stripeCustomerId_fkey" FOREIGN KEY ("stripeCustomerId") REFERENCES "StripeCustomer"("stripeCustomerId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeSubscription" ADD CONSTRAINT "StripeSubscription_stripeProductId_fkey" FOREIGN KEY ("stripeProductId") REFERENCES "StripeProduct"("productId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeSubscription" ADD CONSTRAINT "StripeSubscription_stripePriceId_fkey" FOREIGN KEY ("stripePriceId") REFERENCES "StripePrice"("priceId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeSubscription" ADD CONSTRAINT "StripeSubscription_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "StripeInvoice"("invoiceId") ON DELETE SET NULL ON UPDATE CASCADE;
