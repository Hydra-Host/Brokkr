import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type SearchUpdater = (prev: Record<string, unknown>) => Record<string, unknown>;

interface NavigateWithSearchOptions {
  to: string;
  search: SearchUpdater;
  replace?: boolean;
}

type AnyFunction = (...args: any[]) => any;

export function navigatePreservingSearch(navigate: AnyFunction, opts: NavigateWithSearchOptions): void {
  navigate(opts);
}
