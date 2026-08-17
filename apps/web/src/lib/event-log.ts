import type { EventLogEntry } from '@repo/api-client';

export interface ActorDisplay {
  primary: string;
  secondary: string | null;
}

/** API actors resolve `actorId` to the key's owning human, so the key name has to lead —
 *  otherwise a CI bot's actions read as the person who created the key. */
export function actorDisplay(entry: EventLogEntry): ActorDisplay {
  if (entry.apiKeyLabel) {
    return { primary: entry.apiKeyLabel, secondary: entry.actorLabel };
  }
  // An unnamed key still must not read as the human who owns it.
  if (entry.actorType === 'API') {
    return { primary: 'Unnamed API key', secondary: entry.actorLabel };
  }
  if (entry.actorLabel) {
    return { primary: entry.actorLabel, secondary: null };
  }
  return { primary: entry.actorType === 'SYSTEM' ? 'System' : 'Unattributed', secondary: null };
}

/** `resource.action` reads as a machine key; the table shows the verb with the resource beneath it. */
export function actionDisplay(entry: EventLogEntry): { verb: string; resource: string } {
  return { verb: humanize(entry.action), resource: humanize(entry.resource) };
}

function humanize(value: string): string {
  const spaced = value.replace(/[-_.]/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
