import { AlertCircle, ChevronDown, Download, GitBranch, Plus, RefreshCw, RotateCcw, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ConfirmationRequest, GitRemoteStatus } from '@/shared/types';
import GitPickerList from '@/modules/git-panel/GitPickerList';
import NewBranchModal from '@/modules/git-panel/modals/NewBranchModal';

type GitPanelHeaderProps = {
  isMobile: boolean;
  currentBranch: string;
  branches: string[];
  remoteStatus: GitRemoteStatus | null;
  isLoading: boolean;
  isCreatingBranch: boolean;
  isFetching: boolean;
  isPulling: boolean;
  isPushing: boolean;
  isPublishing: boolean;
  isRevertingLocalCommit: boolean;
  operationError: string | null;
  /** Optional element rendered before the action buttons (the remote access badge). */
  accessSlot?: ReactNode;
  onRefresh: () => void;
  onRevertLocalCommit: () => Promise<void>;
  onSwitchBranch: (branchName: string) => Promise<boolean>;
  onCreateBranch: (branchName: string) => Promise<boolean>;
  onFetch: () => Promise<void>;
  onPull: () => Promise<void>;
  onPush: () => Promise<void>;
  onPublish: () => Promise<void>;
  onClearError: () => void;
  onRequestConfirmation: (request: ConfirmationRequest) => void;
};

/** Rendered by GitPanel to host the branch switcher and the fetch/pull/push/publish/revert actions. */
export default function GitPanelHeader({
  isMobile,
  currentBranch,
  branches,
  remoteStatus,
  isLoading,
  isCreatingBranch,
  isFetching,
  isPulling,
  isPushing,
  isPublishing,
  isRevertingLocalCommit,
  operationError,
  accessSlot,
  onRefresh,
  onRevertLocalCommit,
  onSwitchBranch,
  onCreateBranch,
  onFetch,
  onPull,
  onPush,
  onPublish,
  onClearError,
  onRequestConfirmation,
}: GitPanelHeaderProps) {
  const { t } = useTranslation();
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [showNewBranchModal, setShowNewBranchModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const branchTriggerRef = useRef<HTMLButtonElement | null>(null);
  // True while a branch switch is running, so a second Enter or click cannot
  // start another checkout before the first one answers.
  const isSwitchingBranchRef = useRef(false);

  // Keyboard users keep their place: closing from inside the list returns to the trigger.
  const closeBranchDropdownAndFocusTrigger = () => {
    setShowBranchDropdown(false);
    branchTriggerRef.current?.focus();
  };

  // Arrow-Down on the closed trigger opens the list, as on a native select.
  const handleBranchTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' && !showBranchDropdown) {
      event.preventDefault();
      setShowBranchDropdown(true);
    }
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowBranchDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const aheadCount = remoteStatus?.ahead ?? 0;
  const behindCount = remoteStatus?.behind ?? 0;
  const remoteName = remoteStatus?.remoteName ?? 'remote';
  const anyPending = isFetching || isPulling || isPushing || isPublishing;

  const requestPullConfirmation = () => {
    onRequestConfirmation({
      type: 'pull',
      message: t('git:header.confirmPull', { count: behindCount, remote: remoteName }),
      onConfirm: onPull,
    });
  };

  const requestPushConfirmation = () => {
    onRequestConfirmation({
      type: 'push',
      message: t('git:header.confirmPush', { count: aheadCount, remote: remoteName }),
      onConfirm: onPush,
    });
  };

  const requestPublishConfirmation = () => {
    onRequestConfirmation({
      type: 'publish',
      message: t('git:header.confirmPublish', { branch: currentBranch, remote: remoteName }),
      onConfirm: onPublish,
    });
  };

  const requestRevertLocalCommitConfirmation = () => {
    onRequestConfirmation({
      type: 'revertLocalCommit',
      message: t('git:header.confirmRevert'),
      onConfirm: onRevertLocalCommit,
    });
  };

  const handleSwitchBranch = async (branchName: string) => {
    if (isSwitchingBranchRef.current) return;
    isSwitchingBranchRef.current = true;
    try {
      const success = await onSwitchBranch(branchName);
      if (success) closeBranchDropdownAndFocusTrigger();
    } catch (error) {
      console.error('[GitPanelHeader] Failed to switch branch:', error);
    } finally {
      isSwitchingBranchRef.current = false;
    }
  };

  return (
    <>
      {/* Branch row + action buttons */}
      <div className={`flex items-center justify-between border-b border-border/60 ${isMobile ? 'px-3 py-2' : 'px-4 py-3'}`}>
        {/* Branch selector */}
        <div className="relative" ref={dropdownRef}>
          <button
            ref={branchTriggerRef}
            type="button"
            onClick={() => setShowBranchDropdown((prev) => !prev)}
            onKeyDown={handleBranchTriggerKeyDown}
            aria-haspopup="listbox"
            aria-expanded={showBranchDropdown}
            className={`flex items-center rounded-lg transition-colors hover:bg-accent ${isMobile ? 'space-x-1 px-2 py-1' : 'space-x-2 px-3 py-1.5'}`}
          >
            <GitBranch className={`text-muted-foreground ${isMobile ? 'h-3 w-3' : 'h-4 w-4'}`} />
            <span className="flex items-center gap-1">
              <span className={`font-medium ${isMobile ? 'text-xs' : 'text-sm'}`}>{currentBranch}</span>
              {remoteStatus?.hasRemote && (
                <span className="flex items-center gap-0.5 text-xs">
                  {aheadCount > 0 && (
                    <span className="text-green-600 dark:text-green-400" title={t('git:header.aheadTitle', { n: aheadCount })}>
                      ↑{aheadCount}
                    </span>
                  )}
                  {behindCount > 0 && (
                    <span className="text-primary" title={t('git:header.behindTitle', { n: behindCount })}>
                      ↓{behindCount}
                    </span>
                  )}
                  {remoteStatus.isUpToDate && (
                    <span className="text-muted-foreground" title={t('git:header.upToDate')}>✓</span>
                  )}
                </span>
              )}
            </span>
            <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${showBranchDropdown ? 'rotate-180' : ''}`} />
          </button>

          {showBranchDropdown && (
            <div className="absolute left-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
              <GitPickerList
                items={branches.map((branch) => ({
                  id: branch,
                  label: branch,
                  isCurrent: branch === currentBranch,
                }))}
                searchPlaceholder={t('git:header.searchBranches')}
                showSearch
                clearSearchLabel={t('git:header.clearSearch')}
                emptyText={t('git:header.noMatchingBranches')}
                listClassName="max-h-64"
                onSelectItem={(branch) => void handleSwitchBranch(branch)}
                onClose={closeBranchDropdownAndFocusTrigger}
              >
                <div className="border-t border-border py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setShowNewBranchModal(true);
                      setShowBranchDropdown(false);
                    }}
                    className="flex w-full items-center space-x-2 px-4 py-2 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <Plus className="h-3 w-3" />
                    <span>{t('git:header.createNewBranch')}</span>
                  </button>
                </div>
              </GitPickerList>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className={`flex items-center ${isMobile ? 'gap-1' : 'gap-2'}`}>
          {accessSlot}
          {remoteStatus?.hasRemote && (
            <>
              {!remoteStatus.hasUpstream ? (
                <button
                  onClick={requestPublishConfirmation}
                  disabled={anyPending}
                  className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  title={t('git:header.publishTitle', { branch: currentBranch, remote: remoteName })}
                >
                  <Upload className={`h-3 w-3 ${isPublishing ? 'animate-pulse' : ''}`} />
                  {!isMobile && <span>{isPublishing ? t('git:header.publishing') : t('git:header.publish')}</span>}
                </button>
              ) : (
                <>
                  {/* Fetch — always visible when remote exists */}
                  <button
                    onClick={() => void onFetch()}
                    disabled={anyPending}
                    className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                    title={t('git:header.fetchTitle', { remote: remoteName })}
                  >
                    <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
                    {!isMobile && <span>{isFetching ? t('git:header.fetching') : t('git:header.fetch')}</span>}
                  </button>

                  {behindCount > 0 && (
                    <button
                      onClick={requestPullConfirmation}
                      disabled={anyPending}
                      className="flex items-center gap-1 rounded-lg bg-green-600 px-2.5 py-1 text-sm text-white transition-colors hover:bg-green-700 disabled:opacity-50"
                      title={t('git:header.pullTitle', { n: behindCount, remote: remoteName })}
                    >
                      <Download className={`h-3 w-3 ${isPulling ? 'animate-pulse' : ''}`} />
                      {!isMobile && <span>{isPulling ? t('git:header.pulling') : t('git:header.pullCount', { n: behindCount })}</span>}
                    </button>
                  )}

                  {aheadCount > 0 && (
                    <button
                      onClick={requestPushConfirmation}
                      disabled={anyPending}
                      className="flex items-center gap-1 rounded-lg bg-orange-600 px-2.5 py-1 text-sm text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
                      title={t('git:header.pushTitle', { n: aheadCount, remote: remoteName })}
                    >
                      <Upload className={`h-3 w-3 ${isPushing ? 'animate-pulse' : ''}`} />
                      {!isMobile && <span>{isPushing ? t('git:header.pushing') : t('git:header.pushCount', { n: aheadCount })}</span>}
                    </button>
                  )}
                </>
              )}
            </>
          )}

          <button
            onClick={requestRevertLocalCommitConfirmation}
            disabled={isRevertingLocalCommit}
            className={`rounded-lg transition-colors hover:bg-accent disabled:opacity-50 ${isMobile ? 'p-1' : 'p-1.5'}`}
            title={t('git:header.revertTitle')}
          >
            <RotateCcw
              className={`text-muted-foreground ${isRevertingLocalCommit ? 'animate-pulse' : ''} ${isMobile ? 'h-3 w-3' : 'h-4 w-4'}`}
            />
          </button>

          <button
            onClick={onRefresh}
            disabled={isLoading}
            className={`rounded-lg transition-colors hover:bg-accent ${isMobile ? 'p-1' : 'p-1.5'}`}
            title={t('git:header.refreshTitle')}
          >
            <RefreshCw className={`text-muted-foreground ${isLoading ? 'animate-spin' : ''} ${isMobile ? 'h-3 w-3' : 'h-4 w-4'}`} />
          </button>
        </div>
      </div>

      {/* Inline error banner */}
      {operationError && (
        <div className="flex items-start gap-2 border-b border-destructive/20 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1 leading-snug">{operationError}</span>
          <button
            onClick={onClearError}
            className="shrink-0 rounded p-0.5 hover:bg-destructive/20"
            aria-label={t('git:header.dismissError')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <NewBranchModal
        isOpen={showNewBranchModal}
        currentBranch={currentBranch}
        isCreatingBranch={isCreatingBranch}
        onClose={() => setShowNewBranchModal(false)}
        onCreateBranch={onCreateBranch}
      />
    </>
  );
}
