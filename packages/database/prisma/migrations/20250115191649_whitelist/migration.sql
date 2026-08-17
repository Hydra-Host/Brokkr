-- CreateTable
CREATE TABLE "Whitelist" (
    "id" TEXT NOT NULL,
    "auth0Id" TEXT NOT NULL,

    CONSTRAINT "Whitelist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Whitelist_auth0Id_key" ON "Whitelist"("auth0Id");
