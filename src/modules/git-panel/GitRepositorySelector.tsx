import { Check, ChevronDown, FolderGit2, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { GitRepositoryEntry } from '@/shared/types';

type GitRepositorySelectorProps = {
  repositories: GitRepositoryEntry[];
  /** Path of the active repository, relative to the project; empty for the project folder. */
  activeRepo: string;
  truncated: boolean;
  isLoading: boolean;
  isMobile: boolean;
  onSelect: (repo: string) => void;
  onRescan: () => void;
};

/** Number of repositories above which the dropdown shows a search box. */
const SEARCH_THRESHOLD = 8;

function entryLabel(entry: GitRepositoryEntry): string {
  return entry.isProjectRoot ? entry.name : entry.path;
}

/** Rendered by GitPanel when a project folder holds several repositories, to pick the one the tab shows. */
export default function GitRepositorySelector({
  repositories,
  activeRepo,
  truncated,
  isLoading,
  isMobile,
  onSelect,
  onRescan,
}: GitRepositorySelectorProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      searchInputRef.current?.focus();
    } else {
      setSearchQuery('');
    }
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const active = repositories.find((entry) => entry.path === activeRepo) ?? null;
  const showSearch = repositories.length > SEARCH_THRESHOLD;

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return repositories;
    }
    return repositories.filter((entry) => entryLabel(entry).toLowerCase().includes(query));
  }, [repositories, searchQuery]);

  return (
    <div className="relative min-w-0" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen((previous) => !previous)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={t('git:repositories.switchTitle')}
        className={`flex max-w-full items-center rounded-lg transition-colors hover:bg-accent ${isMobile ? 'space-x-1 px-2 py-1' : 'space-x-2 px-3 py-1.5'}`}
      >
        <FolderGit2 className={`shrink-0 text-muted-foreground ${isMobile ? 'h-3 w-3' : 'h-4 w-4'}`} />
        <span className={`truncate font-medium ${isMobile ? 'text-xs' : 'text-sm'}`}>
          {active ? entryLabel(active) : t('git:repositories.choose')}
        </span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          {showSearch && (
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('git:repositories.search')}
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
            </div>
          )}

          <div role="listbox" className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-4 py-3 text-center text-sm text-muted-foreground">{t('git:repositories.noMatch')}</div>
            ) : (
              filtered.map((entry) => {
                const isActive = entry.path === activeRepo;
                return (
                  <button
                    key={entry.path || '.'}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => {
                      setIsOpen(false);
                      if (!isActive) {
                        onSelect(entry.path);
                      }
                    }}
                    className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors hover:bg-accent ${
                      isActive ? 'bg-accent/50 text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    <span className="flex h-3 w-3 shrink-0 items-center">
                      {isActive && <Check className="h-3 w-3 text-primary" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate ${isActive ? 'font-medium' : ''}`}>{entryLabel(entry)}</span>
                      {entry.isProjectRoot && (
                        <span className="block text-xs text-muted-foreground">{t('git:repositories.projectFolder')}</span>
                      )}
                    </span>
                    {entry.branch && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{entry.branch}</span>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {truncated && (
            <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{t('git:repositories.truncated')}</div>
          )}

          <div className="border-t border-border py-1">
            <button
              type="button"
              onClick={onRescan}
              disabled={isLoading}
              className="flex w-full items-center space-x-2 px-4 py-2 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
              <span>{t('git:repositories.rescan')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
