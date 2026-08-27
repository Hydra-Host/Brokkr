import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  Element.prototype.scrollIntoView = vi.fn();
});

const navigateSpy = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateSpy,
}));

vi.mock('~/lib/nav', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/nav')>();
  return {
    ...actual,
    openNavPopup: vi.fn(),
    notifyNavPopupResult: vi.fn(),
  };
});

import { AppSearch, AppSearchProvider, AppSearchTrigger } from '../app-search';
import { openNavPopup, type FlatLeaf } from '~/lib/nav';

const Icon = () => null;

const leaves: FlatLeaf[] = [
  { title: 'Servers', url: '/servers', icon: Icon, sectionTitle: 'Rentals' },
  { title: 'Clusters', url: '/clusters', icon: Icon, sectionTitle: 'Infrastructure' },
  { title: 'Docs', url: '/help/docs', icon: Icon, sectionTitle: null },
];

function renderSearch(extraLeaves: FlatLeaf[] = []) {
  return render(
    <AppSearchProvider>
      <AppSearchTrigger />
      <AppSearch leaves={[...leaves, ...extraLeaves]} />
    </AppSearchProvider>,
  );
}

describe('AppSearch', () => {
  afterEach(() => vi.clearAllMocks());

  it('opens from the Search trigger and lists leaves until the query filters them', async () => {
    renderSearch();

    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByPlaceholderText('Jump to page...')).toBeInTheDocument();
    expect(screen.getByText('Servers')).toBeInTheDocument();
    expect(screen.getByText('Clusters')).toBeInTheDocument();
    expect(screen.getByText('Docs')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Jump to page...'), { target: { value: 'serv' } });
    expect(screen.getByText('Servers')).toBeInTheDocument();
    expect(screen.queryByText('Clusters')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Jump to page...'), { target: { value: 'infra' } });
    expect(screen.getByText('Clusters')).toBeInTheDocument();
    expect(screen.queryByText('Servers')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Jump to page...'), { target: { value: '/help' } });
    expect(screen.getByText('Docs')).toBeInTheDocument();
    expect(screen.queryByText('Servers')).not.toBeInTheDocument();
  });

  it('navigates to an internal leaf and closes', async () => {
    renderSearch();
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    expect(await screen.findByText('Servers')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Servers'));

    expect(navigateSpy).toHaveBeenCalledWith({ to: '/servers' });
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Jump to page...')).not.toBeInTheDocument();
    });
  });

  it('clears the query when the palette closes', async () => {
    renderSearch();
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    const input = await screen.findByPlaceholderText('Jump to page...');
    fireEvent.change(input, { target: { value: 'serv' } });
    expect(screen.queryByText('Clusters')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Jump to page...')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    expect(await screen.findByPlaceholderText('Jump to page...')).toHaveValue('');
    expect(screen.getByText('Servers')).toBeInTheDocument();
    expect(screen.getByText('Clusters')).toBeInTheDocument();
  });

  it('opens on Cmd+K', async () => {
    renderSearch();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(await screen.findByPlaceholderText('Jump to page...')).toBeInTheDocument();
  });

  it('closes on Cmd+K', async () => {
    renderSearch();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(await screen.findByPlaceholderText('Jump to page...')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Jump to page...')).not.toBeInTheDocument();
    });
  });

  it('clears the query on Cmd+K close', async () => {
    renderSearch();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    const input = await screen.findByPlaceholderText('Jump to page...');
    fireEvent.change(input, { target: { value: 'serv' } });
    expect(input).toHaveValue('serv');

    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Jump to page...')).not.toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(await screen.findByPlaceholderText('Jump to page...')).toHaveValue('');
  });

  it('opens an external leaf in a new tab and closes the palette', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderSearch([
      { title: 'Status', url: 'https://status.example.com', icon: Icon, sectionTitle: 'Help', external: true },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    fireEvent.click(await screen.findByText('Status'));
    expect(openSpy).toHaveBeenCalledWith('https://status.example.com', '_blank', 'noopener,noreferrer');
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Jump to page...')).not.toBeInTheDocument();
    });
    openSpy.mockRestore();
  });

  it('opens a popup leaf and closes the palette', async () => {
    renderSearch([{ title: 'Console', url: '/console', icon: Icon, sectionTitle: 'Tools', popup: true }]);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    fireEvent.click(await screen.findByText('Console'));
    expect(openNavPopup).toHaveBeenCalledWith('/console');
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Jump to page...')).not.toBeInTheDocument();
    });
  });

  it('silently drops an untrusted URL', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderSearch([{ title: 'Evil', url: 'javascript:alert(1)', icon: Icon, sectionTitle: 'Nope' }]);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    fireEvent.click(await screen.findByText('Evil'));
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('clears a non-empty query on Escape without closing the palette', async () => {
    renderSearch();
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    const input = await screen.findByPlaceholderText('Jump to page...');
    fireEvent.change(input, { target: { value: 'serv' } });
    expect(input).toHaveValue('serv');
    expect(screen.queryByText('Clusters')).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input).toHaveValue('');
    expect(screen.getByPlaceholderText('Jump to page...')).toBeInTheDocument();
    expect(screen.getByText('Servers')).toBeInTheDocument();
    expect(screen.getByText('Clusters')).toBeInTheDocument();
  });
});
