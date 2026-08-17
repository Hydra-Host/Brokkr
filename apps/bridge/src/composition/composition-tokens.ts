import type { EnqueueCollectionJob } from '../auto-collection/auto-collection.service.js';
import type { EnqueueRenderRequest } from '../device-record/atom/atom-fetcher.js';

export const BULLMQ_RENDER_REQUEST_ENQUEUER = Symbol('BULLMQ_RENDER_REQUEST_ENQUEUER');

export const BULLMQ_COLLECTION_JOB_ENQUEUER = Symbol('BULLMQ_COLLECTION_JOB_ENQUEUER');

export const BULLMQ_RESULTS_SERVICE = Symbol('BULLMQ_RESULTS_SERVICE');

export type EnqueueRenderRequestToken = typeof BULLMQ_RENDER_REQUEST_ENQUEUER | symbol | string;
export type EnqueueCollectionJobToken = typeof BULLMQ_COLLECTION_JOB_ENQUEUER | symbol | string;

export type { EnqueueCollectionJob, EnqueueRenderRequest };
