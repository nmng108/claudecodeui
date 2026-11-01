import { useEffect, useMemo, useState } from 'react';

import { api } from '@/shared/api';
import { buildSearchTree, collectExpandedDirectoryPaths } from '@/modules/file-tree/utils/fileTreeUtils';
import type { FileTreeNode, FileTreeSearchResponse } from '@/shared/types';

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_RESULT_LIMIT = 200;

type UseFileTreeSearchArgs = {
  projectId: string | undefined;
};

type UseFileTreeSearchResult = {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  /** True while the box holds a query, i.e. the tree shows search results instead of the browsable folders. */
  isSearching: boolean;
  /** Matches arranged as a tree. */
  searchTree: FileTreeNode[];
  /** Every folder on the way to a match, so each result is visible without clicking. */
  searchExpandedDirs: Set<string>;
  searchLoading: boolean;
  /** More matches exist than are shown, or the search stopped before covering the whole project. */
  searchTruncated: boolean;
  searchError: string | null;
};

/**
 * Searches the whole project on the server. The folder tree is loaded lazily,
 * so most of the project is never in the browser and a client-side filter
 * would only see what the user happened to expand.
 */
export function useFileTreeSearch({ projectId }: UseFileTreeSearchArgs): UseFileTreeSearchResult {
  const [searchQuery, setSearchQuery] = useState('');
  const [response, setResponse] = useState<{ projectId: string; query: string; data: FileTreeSearchResponse } | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 0;

  useEffect(() => {
    if (!projectId || !trimmedQuery) {
      setSearchLoading(false);
      setSearchError(null);
      return;
    }

    const controller = new AbortController();
    setSearchLoading(true);

    const timer = setTimeout(async () => {
      try {
        const result = await api.searchFiles(
          projectId,
          { query: trimmedQuery, limit: SEARCH_RESULT_LIMIT },
          { signal: controller.signal },
        );
        if (!result.ok) {
          throw new Error(`Search failed (${result.status})`);
        }
        const data = (await result.json()) as FileTreeSearchResponse;
        if (controller.signal.aborted) {
          return;
        }
        setResponse({ projectId, query: trimmedQuery, data });
        setSearchError(null);
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') {
          return;
        }
        console.error('Error searching files:', error);
        setSearchError(error instanceof Error ? error.message : 'Search failed');
      } finally {
        if (!controller.signal.aborted) {
          setSearchLoading(false);
        }
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, trimmedQuery]);

  // The previous query's hits stay on screen while the next ones load, instead
  // of flashing an empty state on every keystroke; a different project's never show.
  const hits = response && response.projectId === projectId ? response.data.results : null;
  const searchTree = useMemo(() => (hits ? buildSearchTree(hits) : []), [hits]);
  const searchExpandedDirs = useMemo(
    () => new Set(collectExpandedDirectoryPaths(searchTree)),
    [searchTree],
  );

  return {
    searchQuery,
    setSearchQuery,
    isSearching,
    searchTree: isSearching ? searchTree : [],
    searchExpandedDirs,
    searchLoading,
    searchTruncated: isSearching && Boolean(response?.data.truncated),
    searchError: isSearching ? searchError : null,
  };
}
