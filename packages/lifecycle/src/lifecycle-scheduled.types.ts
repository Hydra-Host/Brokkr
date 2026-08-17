import { z } from 'zod';

// Grace-timer queue; deliberately separate from the legacy `interruptible-action` queue so the two engines never process each other's delayed jobs.
export const LIFECYCLE_SCHEDULED_QUEUE = 'lifecycle-scheduled';

export const RESUME_SCHEDULED_JOB = 'resume';
export const START_LINKED_PROVISION_JOB = 'start-linked-provision';

export const LIFECYCLE_WATCHDOG_QUEUE = 'lifecycle-watchdog';

export const PHONE_HOME_WATCHDOG_JOB = 'phone-home-watchdog';
export const POWER_WATCHDOG_JOB = 'power-watchdog';

export const scheduledJobDataSchema = z.object({
  jobId: z.string().uuid(),
});

export type ScheduledJobData = z.infer<typeof scheduledJobDataSchema>;
