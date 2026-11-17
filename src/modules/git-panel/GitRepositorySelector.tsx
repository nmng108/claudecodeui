import { ChevronDown, FolderGit2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import GitPickerList from '@/modules/git-panel/GitPickerList';
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Keyboard users keep their place: closing from inside the list returns to the trigger.
  const closeAndFocusTrigger = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  // Arrow-Down on the closed trigger opens the list, as on a native select.
  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' && !isOpen) {
      event.preventDefault();
      setIsOpen(true);
    }
  };

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


  return (
    <div className="relative min-w-0" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((previous) => !previous)}
        onKeyDown={handleTriggerKeyDown}
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
          <GitPickerList
            items={repositories.map((entry) => ({
              id: entry.path,
              label: entryLabel(entry),
              subtitle: entry.isProjectRoot ? t('git:repositories.projectFolder') : undefined,
              badge: entry.branch,
              isCurrent: entry.path === activeRepo,
            }))}
            searchPlaceholder={t('git:repositories.search')}
            showSearch={showSearch}
            emptyText={t('git:repositories.noMatch')}
            listClassName="max-h-72"
            onSelectItem={(path) => {
              closeAndFocusTrigger();
              if (path !== activeRepo) {
                onSelect(path);
              }
            }}
            onClose={closeAndFocusTrigger}
          >
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
          </GitPickerList>
        </div>
      )}
    </div>
  );
}
