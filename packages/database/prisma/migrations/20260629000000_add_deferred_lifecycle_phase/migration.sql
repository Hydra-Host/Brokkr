-- AlterEnum
-- Parked phase for a lifecycle job a plugin gate deferred (LifecycleGateDeferral)
-- pending out-of-band resolution (e.g. human approval). Positioned before
-- DISPATCHED to match the schema's phase ordering.
ALTER TYPE "LifecycleJobPhase" ADD VALUE 'DEFERRED' BEFORE 'DISPATCHED';
