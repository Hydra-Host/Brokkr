import { useEffect } from 'react';

let defaultSuffix = 'Platform';

export function setDocumentTitleSuffix(suffix: string): void {
  defaultSuffix = suffix;
}

export function useDocumentTitle(title: string, suffix: string = defaultSuffix) {
  useEffect(() => {
    const prev = document.title;
    document.title = title ? `${title} | ${suffix}` : suffix;
    return () => {
      document.title = prev;
    };
  }, [title, suffix]);
}
