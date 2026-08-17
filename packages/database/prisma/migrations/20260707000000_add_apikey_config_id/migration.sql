-- better-auth 1.6 api-key plugin adds a required `configId` column (defaults to "default").
ALTER TABLE "apikey" ADD COLUMN "configId" TEXT NOT NULL DEFAULT 'default';
