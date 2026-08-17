import type { ReactNode } from 'react';

export interface WikiEntry {
  slug: string;
  title: string;
  brief: string;
  category: 'Concepts' | 'Navigation' | 'Services' | 'Data' | 'How-to';
  related?: string[];
  body: ReactNode;
}
