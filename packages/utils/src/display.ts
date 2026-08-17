import { isRecord } from './type-guards';

export function formatCellValue(value: unknown): string {
  switch (true) {
    case value == null:
      return '-';
    case typeof value === 'boolean':
      return value ? 'Yes' : 'No';
    case typeof value === 'string':
      return value;
    case typeof value === 'number':
      return String(value);
    case Array.isArray(value):
      return `[${value.length} items]`;
    case isRecord(value):
      return `{${Object.keys(value).length} fields}`;
    default:
      return String(value);
  }
}

export function formatColumnHeader(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
