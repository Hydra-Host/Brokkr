-- Drop the Kafka event-store residue. The device-sync consumer and log shipping
-- were already removed (the Kafka integration is managed-only and absent from BOSS);
-- the KafkaEvent table and KafkaTopic enum had no remaining readers.
DROP TABLE IF EXISTS "KafkaEvent";
DROP TYPE IF EXISTS "KafkaTopic";
