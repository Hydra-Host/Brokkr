-- Update the changelog trigger function to filter out changes where only updatedAt field changed
CREATE OR REPLACE FUNCTION changelog_trigger_func() RETURNS TRIGGER AS $body$
DECLARE
    v_old_data jsonb;
    v_new_data jsonb;
    v_diff jsonb;
    v_pk_value TEXT;
    v_diff_keys text[];
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
        END IF;

        -- Check if only updatedAt changed
        v_diff_keys := ARRAY(SELECT jsonb_object_keys(v_diff));

        IF array_length(v_diff_keys, 1) = 1 AND v_diff_keys[1] = 'updatedAt' THEN
            -- Only updatedAt changed, skip logging
            RETURN NULL;
        END IF;

        -- Log the change
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