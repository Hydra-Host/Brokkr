-- AlterTable
CREATE SEQUENCE "readonly".netboxdevicestatuschanges_id_seq;
ALTER TABLE "readonly"."NetboxDeviceStatusChanges" ALTER COLUMN "id" SET DEFAULT nextval('"readonly".netboxdevicestatuschanges_id_seq');
ALTER SEQUENCE "readonly".netboxdevicestatuschanges_id_seq OWNED BY "readonly"."NetboxDeviceStatusChanges"."id";
