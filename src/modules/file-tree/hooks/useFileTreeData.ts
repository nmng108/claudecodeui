import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { FileTreeListing, FileTreeNode, Project } from '@/shared/types';

type UseFileTreeDataResult = {
  /** Root entries, each folder carrying `children` once that folder has been loaded. */
  files: FileTreeNode[];
  /** True while the root listing is in flight. */
  loading: boolean;
  error: string | null;
  /** Reloads the root and every folder that has been opened so far. */
  refreshFiles: () => void;
  /** Loads one folder's children; a folder that was already requested is not requested again. */
  loadDirectory: (directoryPath: string) => void;
  /** Folders whose children are being fetched right now. */
  loadingDirectories: ReadonlySet<string>;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

// The API reports refusals as { error: message }. Surfacing that message tells
// the user why the tree is missing, instead of leaving an unexplained empty tree.
function readResponseErrorMessage(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as unknown;
    const message = typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
      ? (parsedBody as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

class DirectoryLoadError extends Error {}

async function fetchDirectory(
  projectId: string,
  directoryPath: string | null,
  signal: AbortSignal,
): Promise<FileTreeListing> {
  const response = await api.listFiles(projectId, directoryPath, { signal });
  if (!response.ok) {
    const errorText = await response.text();
    console.error('File fetch failed:', response.status, errorText);
    throw new DirectoryLoadError(readResponseErrorMessage(errorText) ?? DEFAULT_LOAD_ERROR);
  }
  return (await response.json()) as FileTreeListing;
}

function attachChildren(
  entries: FileTreeNode[],
  childrenByPath: Record<string, FileTreeNode[]>,
): FileTreeNode[] {
  return entries.map((entry) => {
    const loadedChildren = entry.type === 'directory' ? childrenByPath[entry.path] : undefined;
    return loadedChildren ? { ...entry, children: attachChildren(loadedChildren, childrenByPath) } : entry;
  });
}

const isAbortError = (error: unknown) => (error as { name?: string })?.name === 'AbortError';

/**
 * Loads the file tree one folder at a time. The root is fetched up front and a
 * folder's children are fetched when it is first expanded, so a workspace with
 * hundreds of thousands of files costs only the folders actually opened.
 */
export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [rootEntries, setRootEntries] = useState<FileTreeNode[]>([]);
  const [childrenByPath, setChildrenByPath] = useState<Record<string, FileTreeNode[]>>({});
  const [loadingDirectories, setLoadingDirectories] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const projectId = selectedProject?.projectId;
  // Folders requested for the current project, kept so a refresh can reload them
  // and so an expanded folder is never fetched twice.
  const requestedRef = useRef<Set<string>>(new Set());
  // Bumped on every project change or refresh; a response from an older
  // generation is dropped instead of overwriting newer state.
  const generationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const loadedProjectIdRef = useRef<string | undefined>(undefined);

  const refreshFiles = useCallback(() => {
    setRefreshKey((previous) => previous + 1);
  }, []);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    abortControllerRef.current?.abort();
    generationRef.current += 1;
    const generation = generationRef.current;

    if (!projectId) {
      requestedRef.current = new Set();
      loadedProjectIdRef.current = undefined;
      setRootEntries([]);
      setChildrenByPath({});
      setLoadingDirectories(new Set());
      setLoading(false);
      setError(null);
      return;
    }

    const projectChanged = loadedProjectIdRef.current !== projectId;
    loadedProjectIdRef.current = projectId;
    if (projectChanged) {
      requestedRef.current = new Set();
      setChildrenByPath({});
      setLoadingDirectories(new Set());
    }
    const directoriesToReload = [...requestedRef.current];
    // Requests of the previous generation were aborted above and never report back.
    setLoadingDirectories(new Set());

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const reload = async () => {
      setLoading(true);
      setError(null);
      try {
        const [rootListing, ...reloaded] = await Promise.all([
          fetchDirectory(projectId, null, controller.signal),
          // A folder deleted or renamed since it was opened simply drops out.
          ...directoriesToReload.map((directoryPath) => fetchDirectory(projectId, directoryPath, controller.signal)
            .then((listing) => ({ directoryPath, entries: listing.entries }))
            .catch((reloadError: unknown) => {
              if (isAbortError(reloadError)) throw reloadError;
              return { directoryPath, entries: null };
            })),
        ]);
        if (generation !== generationRef.current) {
          return;
        }

        const nextChildren: Record<string, FileTreeNode[]> = {};
        for (const result of reloaded as Array<{ directoryPath: string; entries: FileTreeNode[] | null }>) {
          if (result.entries) {
            nextChildren[result.directoryPath] = result.entries;
          }
        }
        setRootEntries(rootListing.entries);
        setChildrenByPath(nextChildren);
      } catch (loadError) {
        if (isAbortError(loadError) || generation !== generationRef.current) {
          return;
        }
        console.error('Error fetching files:', loadError);
        setRootEntries([]);
        setChildrenByPath({});
        setError(loadError instanceof DirectoryLoadError ? loadError.message : DEFAULT_LOAD_ERROR);
      } finally {
        if (generation === generationRef.current) {
          setLoading(false);
        }
      }
    };

    void reload();

    return () => {
      controller.abort();
    };
  }, [projectId, refreshKey]);

  const loadDirectory = useCallback((directoryPath: string) => {
    if (!projectId || requestedRef.current.has(directoryPath)) {
      return;
    }
    requestedRef.current.add(directoryPath);
    const generation = generationRef.current;
    const signal = abortControllerRef.current?.signal ?? new AbortController().signal;

    setLoadingDirectories((previous) => new Set(previous).add(directoryPath));

    const finish = () => {
      if (generation !== generationRef.current) {
        return;
      }
      setLoadingDirectories((previous) => {
        const next = new Set(previous);
        next.delete(directoryPath);
        return next;
      });
    };

    fetchDirectory(projectId, directoryPath, signal)
      .then((listing) => {
        if (generation !== generationRef.current) {
          return;
        }
        setChildrenByPath((previous) => ({ ...previous, [directoryPath]: listing.entries }));
      })
      .catch((loadError: unknown) => {
        if (isAbortError(loadError) || generation !== generationRef.current) {
          return;
        }
        console.error('Error fetching folder:', directoryPath, loadError);
        // Shown as an empty folder. It stays "requested", so it is not retried
        // in a loop; a refresh reloads it.
        setChildrenByPath((previous) => ({ ...previous, [directoryPath]: [] }));
      })
      .finally(finish);
  }, [projectId]);

  const files = useMemo(() => attachChildren(rootEntries, childrenByPath), [rootEntries, childrenByPath]);

  return { files, loading, error, refreshFiles, loadDirectory, loadingDirectories };
}
