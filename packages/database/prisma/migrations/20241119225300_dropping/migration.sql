-- AddForeignKey
ALTER TABLE "readonly"."NetboxSite" ADD CONSTRAINT "NetboxSite_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "readonly"."NetboxTenant"("tenantId") ON DELETE SET NULL ON UPDATE CASCADE;
