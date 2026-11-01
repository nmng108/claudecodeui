import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { useApiSource } from '@/modules/command-palette/hooks/useApiSource';
import type { FileTreeSearchResponse } from '@/shared/types';

export type FileResult = {
  path: string;
  name: string;
};

const MAX_FILES = 200;
// The palette searches as you type; coalesce keystrokes into one request.
const SEARCH_DEBOUNCE_MS = 200;

/**
 * Files for the command palette, searched on the server so a workspace of any
 * size can be searched without loading its tree into the browser. With an empty
 * query it returns the files nearest the project root.
 */
export function useFilesSource(projectId: string | undefined, enabled: boolean, search = '') {
  const [debouncedSearch, setDebouncedSearch] = useState(search.trim());

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  return useApiSource<FileResult, FileTreeSearchResponse>({
    enabled: enabled && !!projectId,
    deps: [projectId, debouncedSearch],
    fetcher: (signal) => api.searchFiles(
      projectId!,
      { query: debouncedSearch, type: 'file', limit: MAX_FILES },
      { signal },
    ),
    parse: (data) => (Array.isArray(data?.results) ? data.results : [])
      .map((result) => ({ path: result.path, name: result.name })),
  });
}