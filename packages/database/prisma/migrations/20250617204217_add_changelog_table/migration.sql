-- CreateTable
CREATE TABLE "Changelog" (
    "id" SERIAL NOT NULL,
    "tableName" TEXT NOT NULL,
    "pk" UUID NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "diff" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Changelog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Changelog_tableName_idx" ON "Changelog"("tableName");

-- CreateIndex
CREATE INDEX "Changelog_pk_idx" ON "Changelog"("pk");

-- CreateIndex
CREATE INDEX "Changelog_createdAt_idx" ON "Changelog"("createdAt");

-- JSON diff function to compare two JSONB objects
CREATE OR REPLACE FUNCTION json_diff(l jsonb, r jsonb) RETURNS jsonb
LANGUAGE 'sql'
AS $BODY$
    SELECT jsonb_object_agg(a.key, a.value) 
    FROM (
        SELECT key, value FROM jsonb_each(l) 
    ) a 
    LEFT OUTER JOIN (
        SELECT key, value FROM jsonb_each(r) 
    ) b ON a.key = b.key
    WHERE a.value != b.value OR b.key IS NULL;
$BODY$;

-- Trigger function adapted for Changelog table
CREATE OR REPLACE FUNCTION changelog_trigger_func() RETURNS TRIGGER AS $body$
DECLARE
    v_old_data jsonb;
    v_new_data jsonb;
    v_diff jsonb;
    v_pk_value TEXT;
BEGIN 
    IF (TG_OP = 'UPDATE') THEN
        v_old_data := row_to_json(OLD)::jsonb;
        v_new_data := row_to_json(NEW)::jsonb;
        v_diff := json_diff(v_new_data, v_old_data);
        
        -- Extract primary key (assuming 'id' field exists)
        v_pk_value := COALESCE((v_old_data->>'id'), 'unknown');
               
        IF(v_diff = '{}' OR v_diff IS NULL) THEN
            -- Nothing has been changed
            RETURN NULL;
        ELSE
            INSERT INTO "Changelog" ("id", "tableName", "pk", "before", "after", "diff", "createdAt") 
            VALUES (
                gen_random_uuid(),
                TG_TABLE_NAME::TEXT, 
                v_pk_value::UUID,
                v_old_data, 
                v_new_data, 
                v_diff,
                CURRENT_TIMESTAMP
            );
            RETURN NEW;
        END IF;
        
    ELSIF (TG_OP = 'DELETE') THEN
        v_old_data := row_to_json(OLD)::jsonb;
        v_pk_value := COALESCE((v_old_data->>'id'), 'unknown');
        
        INSERT INTO "Changelog" ("id", "tableName", "pk", "before", "after", "diff", "createdAt") 
        VALUES (
            gen_random_uuid(),
            TG_TABLE_NAME::TEXT, 
            v_pk_value::UUID,
            v_old_data, 
            '{}'::jsonb,  -- Empty after for deletes
            v_old_data,   -- Full old data as diff for deletes
            CURRENT_TIMESTAMP
        );
        RETURN OLD;
        
    ELSIF (TG_OP = 'INSERT') THEN
        v_new_data := row_to_json(NEW)::jsonb;
        v_pk_value := COALESCE((v_new_data->>'id'), 'unknown');
        
        INSERT INTO "Changelog" ("id", "tableName", "pk", "before", "after", "diff", "createdAt") 
        VALUES (
            gen_random_uuid(),
            TG_TABLE_NAME::TEXT, 
            v_pk_value::UUID,
            '{}'::jsonb,  -- Empty before for inserts
            v_new_data,
            v_new_data,   -- Full new data as diff for inserts
            CURRENT_TIMESTAMP
        );
        RETURN NEW;
        
    ELSE
        RAISE WARNING '[CHANGELOG_TRIGGER_FUNC] - Other action occurred: %, at %', TG_OP, now();
        RETURN NULL;
    END IF;
END;
$body$
LANGUAGE plpgsql;

