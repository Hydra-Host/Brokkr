-- Operator/admin-panel initiated lifecycle operations are attributed with
-- their own RequestSource so audit trails distinguish them from customer UI/API.
ALTER TYPE "RequestSource" ADD VALUE 'ADMIN';
