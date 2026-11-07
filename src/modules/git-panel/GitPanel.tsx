import { Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useGitPanelController } from '@/modules/git-panel/hooks/useGitPanelController';
import { useGitRemoteAccess } from '@/modules/git-panel/hooks/useGitRemoteAccess';
import { useGitRepositories } from '@/modules/git-panel/hooks/useGitRepositories';
import { useRevertLocalCommit } from '@/modules/git-panel/hooks/useRevertLocalCommit';
import { setActiveGitRepository, useActiveGitRepository } from '@/shared/gitRepositorySelection';
import type { ConfirmationRequest, FileOpenHandler, GitPanelView, Project } from '@/shared/types';
import { getChangedFileCount } from '@/modules/git-panel/utils/gitPanelUtils';
import ChangesView from '@/modules/git-panel/changes/ChangesView';
import CompareView from '@/modules/git-panel/compare/CompareView';
import HistoryView from '@/modules/git-panel/history/HistoryView';
import BranchesView from '@/modules/git-panel/branches/BranchesView';
import WorktreesView from '@/modules/git-panel/worktrees/WorktreesView';
import GitPanelHeader from '@/modules/git-panel/GitPanelHeader';
import GitRemoteAccessBadge from '@/modules/git-panel/GitRemoteAccessBadge';
import GitRepositorySelector from '@/modules/git-panel/GitRepositorySelector';
import GitRepositoryErrorState from '@/modules/git-panel/GitRepositoryErrorState';
import GitViewTabs from '@/modules/git-panel/GitViewTabs';
import ConfirmActionModal from '@/modules/git-panel/modals/ConfirmActionModal';

type GitPanelProps = {
  selectedProject: Project | null;
  isMobile?: boolean;
  onFileOpen?: FileOpenHandler;
  /** Switches the app to another project — used by the Worktrees view to jump into a worktree. */
  onProjectSelect?: (project: Project) => void;
  /** Silently re-syncs the sidebar project list after worktree projects are created/archived. */
  onProjectsRefresh?: () => void;
};

/** Exported through the git-panel barrel; the project-workspace module renders it as the source-control sidebar tab. */
export default function GitPanel({
  selectedProject,
  isMobile = false,
  onFileOpen,
  onProjectSelect,
  onProjectsRefresh,
}: GitPanelProps) {
  const { t } = useTranslation();
  const [activeView, setActiveView] = useState<GitPanelView>('changes');
  const [wrapText, setWrapText] = useState(true);
  const [hasExpandedFiles, setHasExpandedFiles] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmationRequest | null>(null);
  const projectId = selectedProject?.projectId ?? null;

  // A project folder can hold several repositories; the tab shows one of them.
  const {
    repositories,
    truncated: repositoriesTruncated,
    isResolved: repositoriesResolved,
    isLoading: isLoadingRepositories,
    refresh: rescanRepositories,
  } = useGitRepositories(projectId);
  const activeRepo = useActiveGitRepository(projectId);

  const {
    gitStatus,
    gitDiff,
    isLoading,
    isLoadingCommits,
    currentBranch,
    branches,
    localBranches,
    remoteBranches,
    remoteRefs,
    recentCommits,
    commitDiffs,
    remoteStatus,
    isCreatingBranch,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    isCreatingInitialCommit,
    isInitializingRepository,
    operationError,
    clearOperationError,
    refreshAll,
    switchBranch,
    createBranch,
    deleteBranch,
    handleFetch,
    handlePull,
    handlePush,
    handlePublish,
    discardChanges,
    deleteUntrackedFile,
    stageFiles,
    unstageFiles,
    fetchCommitDiff,
    commitChanges,
    createInitialCommit,
    initRepository,
    openFile,
  } = useGitPanelController({
    // Held back until discovery picked the repository, so the first request
    // does not hit the project folder and flash a "not a repository" state.
    selectedProject: repositoriesResolved ? selectedProject : null,
    activeView,
    onFileOpen,
  });

  const remoteAccess = useGitRemoteAccess({
    projectId,
    repo: activeRepo,
    branch: currentBranch,
    enabled: repositoriesResolved && gitStatus !== null && !gitStatus.error && remoteStatus?.hasRemote === true,
  });

  const { isRevertingLocalCommit, revertLatestLocalCommit } = useRevertLocalCommit({
    // `projectId` (DB primary key) is forwarded to the revert API which uses it
    // as the `project` body param.
    projectId: selectedProject?.projectId ?? null,
    onSuccess: refreshAll,
  });

  const executeConfirmedAction = useCallback(async (useAlternateConfirmation = false) => {
    if (!confirmAction) return;
    const actionToExecute = confirmAction;
    setConfirmAction(null);
    try {
      const confirmationHandler = useAlternateConfirmation
        ? actionToExecute.alternateConfirmation?.onConfirm ?? actionToExecute.onConfirm
        : actionToExecute.onConfirm;
      await confirmationHandler();
    } catch (error) {
      console.error('Error executing confirmation action:', error);
    }
  }, [confirmAction]);

  const changeCount = getChangedFileCount(gitStatus);
  // Without a repository the branch/fetch/refresh header controls are all
  // meaningless — hide the whole header and let the init state own the panel.
  const isMissingRepository = Boolean(gitStatus?.notGitRepository);

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>{t('git:panel.selectProject')}</p>
      </div>
    );
  }

  if (!repositoriesResolved) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  // The selector is only useful when there is something to choose between.
  const showRepositorySelector =
    repositories.length > 1 || (repositories.length === 1 && !repositories[0].isProjectRoot);
  const repositoryScope = `${selectedProject.fullPath}|${activeRepo}`;

  return (
    <div className="flex h-full flex-col bg-background">
      {showRepositorySelector && (
        <div className={`flex items-center border-b border-border/60 ${isMobile ? 'px-3 py-1' : 'px-4 py-2'}`}>
          <GitRepositorySelector
            repositories={repositories}
            activeRepo={activeRepo}
            truncated={repositoriesTruncated}
            isLoading={isLoadingRepositories}
            isMobile={isMobile}
            onSelect={(repo) => setActiveGitRepository(selectedProject.projectId, repo)}
            onRescan={rescanRepositories}
          />
        </div>
      )}

      {!isMissingRepository && (
        <GitPanelHeader
          isMobile={isMobile}
          currentBranch={currentBranch}
          branches={branches}
          remoteStatus={remoteStatus}
          isLoading={isLoading}
          isCreatingBranch={isCreatingBranch}
          isFetching={isFetching}
          isPulling={isPulling}
          isPushing={isPushing}
          isPublishing={isPublishing}
          isRevertingLocalCommit={isRevertingLocalCommit}
          operationError={operationError}
          accessSlot={
            remoteStatus?.hasRemote ? (
              <GitRemoteAccessBadge
                access={remoteAccess.access}
                isChecking={remoteAccess.isChecking}
                autoCheck={remoteAccess.autoCheck}
                isMobile={isMobile}
                onCheck={(force) => void remoteAccess.check(force)}
                onAutoCheckChange={remoteAccess.setAutoCheck}
              />
            ) : null
          }
          onRefresh={refreshAll}
          onRevertLocalCommit={revertLatestLocalCommit}
          onSwitchBranch={switchBranch}
          onCreateBranch={createBranch}
          onFetch={handleFetch}
          onPull={handlePull}
          onPush={handlePush}
          onPublish={handlePublish}
          onClearError={clearOperationError}
          onRequestConfirmation={setConfirmAction}
        />
      )}

      {gitStatus?.error ? (
        <GitRepositoryErrorState
          error={gitStatus.error}
          details={gitStatus.details}
          canInitRepository={isMissingRepository}
          isInitializingRepository={isInitializingRepository}
          initError={isMissingRepository ? operationError : null}
          onInitRepository={() => {
            clearOperationError();
            // The folder becomes a repository, so the list is rescanned.
            void initRepository().then((initialized) => {
              if (initialized) rescanRepositories();
            });
          }}
        />
      ) : (
        <>
          <GitViewTabs
            activeView={activeView}
            isHidden={hasExpandedFiles}
            changeCount={changeCount}
            onChange={setActiveView}
          />

          {activeView === 'changes' && (
            <ChangesView
              key={repositoryScope}
              isMobile={isMobile}
              projectPath={activeRepo ? `${selectedProject.fullPath}/${activeRepo}` : selectedProject.fullPath}
              gitStatus={gitStatus}
              gitDiff={gitDiff}
              isLoading={isLoading}
              wrapText={wrapText}
              isCreatingInitialCommit={isCreatingInitialCommit}
              onWrapTextChange={setWrapText}
              onCreateInitialCommit={createInitialCommit}
              onOpenFile={openFile}
              onDiscardFile={discardChanges}
              onDeleteFile={deleteUntrackedFile}
              onStageFiles={stageFiles}
              onUnstageFiles={unstageFiles}
              onCommitChanges={commitChanges}
              onRequestConfirmation={setConfirmAction}
              onExpandedFilesChange={setHasExpandedFiles}
            />
          )}

          {activeView === 'compare' && (
            <CompareView
              key={repositoryScope}
              projectId={selectedProject.projectId}
              currentBranch={currentBranch}
              localBranches={localBranches}
              remoteRefs={remoteRefs}
              gitStatus={gitStatus}
              isMobile={isMobile}
              wrapText={wrapText}
              onWrapTextChange={setWrapText}
              onOpenFile={openFile}
            />
          )}

          {activeView === 'history' && (
            <HistoryView
              isMobile={isMobile}
              // Treat an in-flight commits request as loading only while the
              // list is empty, so "No commits found" never flashes before the
              // first response and refetches don't blank an existing list.
              isLoading={isLoading || (recentCommits.length === 0 && isLoadingCommits)}
              recentCommits={recentCommits}
              commitDiffs={commitDiffs}
              wrapText={wrapText}
              onFetchCommitDiff={fetchCommitDiff}
            />
          )}

          {activeView === 'worktrees' && (
            <WorktreesView
              key={repositoryScope}
              isMobile={isMobile}
              selectedProject={selectedProject}
              localBranches={localBranches}
              onProjectSelect={onProjectSelect}
              onProjectsRefresh={onProjectsRefresh}
            />
          )}

          {activeView === 'branches' && (
            <BranchesView
              isMobile={isMobile}
              isLoading={isLoading}
              currentBranch={currentBranch}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              remoteStatus={remoteStatus}
              isCreatingBranch={isCreatingBranch}
              onSwitchBranch={switchBranch}
              onCreateBranch={createBranch}
              onDeleteBranch={deleteBranch}
              onRequestConfirmation={setConfirmAction}
            />
          )}
        </>
      )}

      <ConfirmActionModal
        action={confirmAction}
        onCancel={() => setConfirmAction(null)}
        onConfirm={(useAlternateConfirmation) => {
          void executeConfirmedAction(useAlternateConfirmation);
        }}
      />
    </div>
  );
}
