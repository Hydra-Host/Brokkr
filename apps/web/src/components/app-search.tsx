import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@repo/ui/components/command';
import { SearchTriggerButton } from '@repo/ui/components/search-trigger-button';
import { filterLeavesByQuery } from '@repo/utils';

import { useNavigate } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';

import { notifyNavPopupResult, openNavPopup, safeExternalHref, safeInternalPath, type FlatLeaf } from '~/lib/nav';

type AppSearchApi = {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  openSearch: () => void;
};

const AppSearchContext = createContext<AppSearchApi | null>(null);

function useAppSearch() {
  const ctx = useContext(AppSearchContext);
  if (!ctx) {
    throw new Error('AppSearch components must be used within AppSearchProvider');
  }
  return ctx;
}

export function AppSearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const openSearch = useCallback(() => setOpen(true), []);

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const value = useMemo<AppSearchApi>(() => ({ open, setOpen, openSearch }), [open, openSearch]);

  return <AppSearchContext.Provider value={value}>{children}</AppSearchContext.Provider>;
}

export function AppSearchTrigger() {
  const { openSearch } = useAppSearch();
  return <SearchTriggerButton onClick={openSearch} />;
}

export function AppSearch({ leaves }: { leaves: FlatLeaf[] }) {
  const { open, setOpen } = useAppSearch();
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        setQuery('');
      }
    },
    [setOpen],
  );

  const hasQuery = query.length >= 1;
  const filteredPages = useMemo(() => filterLeavesByQuery(leaves, query), [leaves, query]);

  const handleNavigate = useCallback(
    (leaf: FlatLeaf) => {
      setOpen(false);
      setQuery('');
      if (leaf.popup && safeInternalPath(leaf.url)) {
        notifyNavPopupResult(openNavPopup(leaf.url), leaf.title);
        return;
      }
      if (leaf.external) {
        const href = safeExternalHref(leaf.url);
        if (href) window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      const path = safeInternalPath(leaf.url);
      if (path) void navigate({ to: path });
    },
    [navigate, setOpen],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape' && query.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        setQuery('');
      }
    },
    [query],
  );

  const noAnyResults = hasQuery && filteredPages.length === 0;

  return (
    <CommandDialog open={open} onOpenChange={handleOpenChange} shouldFilter={false}>
      <div onKeyDown={handleKeyDown}>
        <CommandInput placeholder="Jump to page..." value={query} onValueChange={setQuery} />
      </div>
      <CommandList className="max-h-[460px]">
        {noAnyResults && <CommandEmpty>No results found.</CommandEmpty>}

        {filteredPages.length > 0 && (
          <CommandGroup heading={hasQuery ? `Pages (${filteredPages.length})` : 'Pages'}>
            {filteredPages.map((leaf) => {
              const Icon = leaf.icon;
              return (
                <CommandItem
                  key={`${leaf.url}-${leaf.title}`}
                  value={`page-${leaf.url}-${leaf.title}`}
                  onSelect={() => handleNavigate(leaf)}
                >
                  <Icon className="text-muted-foreground mr-2 h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{leaf.title}</div>
                    {leaf.sectionTitle && (
                      <div className="text-muted-foreground truncate text-xs">{leaf.sectionTitle}</div>
                    )}
                  </div>
                  {leaf.external && <ExternalLink className="text-muted-foreground ml-2 h-3.5 w-3.5 shrink-0" />}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
