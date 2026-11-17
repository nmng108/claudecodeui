import { Check, Search, X } from 'lucide-react';
import { Command as CommandPrimitive } from 'cmdk';
import { useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { Command, CommandItem, CommandList } from '@/shared/ui';
import { cn } from '@/shared/utils';

type GitPickerListProps = {
  /** Every row; the list filters them by label as the user types. `id` is handed back to `onSelectItem`. */
  items: Array<{
    id: string;
    label: string;
    subtitle?: string;
    badge?: string | null;
    isCurrent: boolean;
  }>;
  searchPlaceholder: string;
  /** False keeps the input for keyboard focus but hides it visually (short lists). */
  showSearch: boolean;
  /** Label of the clear-search button; omit to render no button. */
  clearSearchLabel?: string;
  emptyText: string;
  /** Classes for the scrolling list, so each picker keeps its own max height. */
  listClassName: string;
  onSelectItem: (id: string) => void;
  /** Escape was pressed anywhere inside the picker. */
  onClose: () => void;
  /** Plain controls shown under the list (create, rescan, warnings). */
  children?: ReactNode;
};

/**
 * Used by GitRepositorySelector and GitPanelHeader (git-panel) so the repository
 * and branch dropdowns share one keyboard-driven list: Up/Down/Home/End move
 * the highlight, Enter picks it, Escape closes.
 */
export default function GitPickerList({
  items,
  searchPlaceholder,
  showSearch,
  clearSearchLabel,
  emptyText,
  listClassName,
  onSelectItem,
  onClose,
  children,
}: GitPickerListProps) {
  // What the user typed. Kept here, in a component that exists only while the
  // dropdown is open, so every opening starts with an empty search.
  const [searchQuery, setSearchQuery] = useState('');
  // The row Up/Down/Enter act on. cmdk owns moving it; it is held here so the
  // list opens on the current repository or branch instead of the first row.
  const [highlighted, setHighlighted] = useState(() => {
    const currentIndex = items.findIndex((item) => item.isCurrent);
    return `item-${Math.max(currentIndex, 0)}`;
  });

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleItems = normalizedQuery
    ? items.filter((item) => item.label.toLowerCase().includes(normalizedQuery))
    : items;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <Command
      shouldFilter={false}
      loop
      value={highlighted}
      onValueChange={setHighlighted}
      onKeyDown={handleKeyDown}
    >
      <div
        className={cn(
          'flex items-center gap-2 border-b border-border px-3 py-2',
          !showSearch && 'sr-only',
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <CommandPrimitive.Input
          autoFocus
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        {clearSearchLabel && searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            title={clearSearchLabel}
            aria-label={clearSearchLabel}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {visibleItems.length === 0 ? (
        <div className="px-4 py-3 text-center text-sm text-muted-foreground">{emptyText}</div>
      ) : (
        <CommandList className={cn('py-1', listClassName)}>
          {visibleItems.map((item, index) => (
            <CommandItem
              key={item.id || '.'}
              value={`item-${index}`}
              onSelect={() => onSelectItem(item.id)}
              data-current={item.isCurrent || undefined}
              className={cn(
                'w-full gap-2 rounded-none px-4 py-2 text-left',
                item.isCurrent ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              <span className="flex h-3 w-3 shrink-0 items-center">
                {item.isCurrent && <Check className="h-3 w-3 text-primary" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate', item.isCurrent && 'font-medium')}>{item.label}</span>
                {item.subtitle && (
                  <span className="block text-xs text-muted-foreground">{item.subtitle}</span>
                )}
              </span>
              {item.badge && (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{item.badge}</span>
              )}
            </CommandItem>
          ))}
        </CommandList>
      )}

      {children}
    </Command>
  );
}
