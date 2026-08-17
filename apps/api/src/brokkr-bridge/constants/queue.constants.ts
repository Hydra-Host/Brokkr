export const LIFECYCLE_QUEUE_NAME = 'lifecycle';
// Bridge-side collection queue (apps/bridge BULLMQ_COLLECTION_QUEUE_NAME default). enrich's
// collection.run jobs land here, keyed by the same zone-UUID prefix as the lifecycle queue.
export const COLLECTION_QUEUE_NAME = 'collection';

export const RESULTS_PREFIX = 'results';
export const RESULTS_QUEUE_NAME = 'inbox';

// Job states the brokkr.queue.jobs gauge reports per queue.
export const QUEUE_JOB_STATES = ['waiting', 'active', 'failed', 'delayed'] as const;
