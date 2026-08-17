import { QTYPE_A, QTYPE_AAAA, QTYPE_PTR } from './protocol.js';

import type { DnsRecordsAtomValue } from './dns-records-reader.schema.js';

export const DNS_RECORDS_KEY = 'config:dns-records';

export interface DnsLookupResult {
  value: string;
  // Null = no per-record override; the answer path substitutes the LIVE zone default so hub
  // TTL updates apply without rebuilding the lookup.
  ttl: number | null;
}

function qtypeToRecordType(qtype: number): string | null {
  if (qtype === QTYPE_A) return 'A';
  if (qtype === QTYPE_AAAA) return 'AAAA';
  if (qtype === QTYPE_PTR) return 'PTR';
  return null;
}

function lookupKey(fqdn: string, recordType: string): string {
  return `${fqdn.toLowerCase()}.${recordType}`;
}

export class DnsRecordsLookup {
  private readonly table = new Map<string, Array<DnsLookupResult>>();

  constructor(atom: DnsRecordsAtomValue) {
    for (const domain of atom.domains) {
      for (const record of domain.records) {
        const fqdn =
          record.name === '' || record.name === '@'
            ? domain.name.toLowerCase()
            : `${record.name}.${domain.name}`.toLowerCase();
        const key = lookupKey(fqdn, record.type);
        const entry: DnsLookupResult = {
          value: record.value,
          ttl: record.ttl ?? null,
        };

        const existing = this.table.get(key);
        if (existing !== undefined) {
          existing.push(entry);
        } else {
          this.table.set(key, [entry]);
        }
      }
    }
  }

  lookup(qname: string, qtype: number): Array<DnsLookupResult> | null {
    const recordType = qtypeToRecordType(qtype);
    if (recordType === null) return null;

    const key = lookupKey(qname, recordType);
    const results = this.table.get(key);
    if (results === undefined || results.length === 0) return null;
    return results;
  }
}
