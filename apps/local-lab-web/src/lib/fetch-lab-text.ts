import { labApiToken } from '@/lib/lab-token';

// plain-text/binary attachment downloads live outside the ts-rest contract (it models JSON bodies),
// so this is the sanctioned raw fetch — it still carries the x-lab-token header like the tsr client.
export async function fetchLabText(path: string): Promise<string> {
  const res = await fetch(path, { headers: { 'x-lab-token': labApiToken() } });
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.text();
}
