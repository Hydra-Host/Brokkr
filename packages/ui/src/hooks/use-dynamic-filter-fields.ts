import { useMemo } from 'react';

import type { FilterFieldConfig } from './use-filters';

type AccessorResult = string | number | string[] | null | undefined;

export interface DynamicFilterFieldConfig<TData> extends Omit<FilterFieldConfig, 'options'> {
  options?: string[];
  accessor?: (row: TData) => AccessorResult;
}

export function useDynamicFilterFields<TData>(
  fields: DynamicFilterFieldConfig<TData>[],
  data: TData[],
): FilterFieldConfig[] {
  return useMemo(() => {
    return fields.map(({ accessor, ...field }) => {
      if (!accessor) {
        return field as FilterFieldConfig;
      }

      const values = new Set<string>();
      for (const row of data) {
        const val = accessor(row);
        if (Array.isArray(val)) {
          for (const v of val) {
            if (v !== '') values.add(v);
          }
        } else if (val !== null && val !== undefined && val !== '') {
          values.add(String(val));
        }
      }

      return { ...field, options: [...values].sort((a, b) => a.localeCompare(b)) };
    });
  }, [fields, data]);
}
