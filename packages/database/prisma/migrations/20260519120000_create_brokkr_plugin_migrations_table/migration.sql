-- CreateTable
CREATE TABLE "_brokkr_plugin_migrations" (
    "plugin_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "applied_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_brokkr_plugin_migrations_pkey" PRIMARY KEY ("plugin_id", "version")
);
