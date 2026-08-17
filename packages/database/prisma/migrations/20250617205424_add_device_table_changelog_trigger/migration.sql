CREATE OR REPLACE TRIGGER changelog_trigger
    AFTER INSERT OR UPDATE OR DELETE ON "Device"
    FOR EACH ROW EXECUTE FUNCTION changelog_trigger_func();

-- Create indexes on the diff column
CREATE INDEX idx_changelog_diff_is_listed_true ON "Changelog" ((diff->>'isListed')) 
    WHERE (diff->>'isListed')::boolean = true;

CREATE INDEX idx_changelog_diff_is_listed_false ON "Changelog" ((diff->>'isListed')) 
    WHERE (diff->>'isListed')::boolean = false;

CREATE INDEX idx_changelog_diff_is_interruptible_true ON "Changelog" ((diff->>'isInterruptible')) 
    WHERE (diff->>'isInterruptible')::boolean = true;

CREATE INDEX idx_changelog_diff_is_interruptible_false ON "Changelog" ((diff->>'isInterruptible')) 
    WHERE (diff->>'isInterruptible')::boolean = false;