import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { MCP_PROVIDER_NAMES } from '@/shared/constants';
import type { McpProject, McpProvider } from '@/shared/types';
import { useMcpRawConfig } from '@/modules/mcp/hooks/useMcpRawConfig';

type McpRawConfigModalProps = {
  provider: McpProvider;
  currentProjects: McpProject[];
  onClose: () => void;
  onSaved: () => Promise<void>;
};

const SELECT_CLASS = 'w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';

function NameList({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) {
    return null;
  }

  return (
    <div>
      <span className="font-medium text-foreground">{label}:</span>{' '}
      <span className="break-words font-mono text-xs">{names.join(', ')}</span>
    </div>
  );
}

/** Rendered by McpServers to view and edit a provider's whole MCP config file, or paste several servers into it at once. */
export default function McpRawConfigModal({ provider, currentProjects, onClose, onSaved }: McpRawConfigModalProps) {
  const { t } = useTranslation('settings');
  const state = useMcpRawConfig({ provider, currentProjects, onSaved });
  const providerName = MCP_PROVIDER_NAMES[provider];
  const isMerge = state.mode === 'merge';
  const formatLosesComments = state.loaded && state.loaded.format !== 'json';
  const hasChanges = state.preview !== null
    && (state.preview.added.length + state.preview.changed.length + state.preview.removed.length) > 0;

  return createPortal(
    <div data-escape-layer className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="text-lg font-medium text-foreground">
            {t('mcpRaw.title', { provider: providerName, defaultValue: `${providerName} MCP config` })}
          </h3>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-3 overflow-y-auto p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <select
              value={state.scope}
              onChange={(event) => state.changeScope(event.target.value as typeof state.scope)}
              className={SELECT_CLASS}
              aria-label={t('mcpForm.scope.label')}
            >
              {state.supportedScopes.map((scope) => (
                <option key={scope} value={scope}>{scope}</option>
              ))}
            </select>
            {state.needsProject && (
              <select
                value={state.workspacePath}
                onChange={(event) => state.setWorkspacePath(event.target.value)}
                className={SELECT_CLASS}
                aria-label={t('mcpForm.fields.selectProject')}
              >
                <option value="">{t('mcpForm.fields.selectProject')}</option>
                {state.projectOptions.map((project) => (
                  <option key={project.value} value={project.value}>{project.label}</option>
                ))}
              </select>
            )}
          </div>

          {state.loaded && (
            <p className="truncate text-xs text-muted-foreground" title={state.loaded.filePath}>
              {state.loaded.filePath}
              {!state.loaded.exists && ` (${t('mcpRaw.willBeCreated', { defaultValue: 'will be created' })})`}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={isMerge ? 'outline' : 'default'} onClick={() => state.changeMode('replace')}>
              {t('mcpRaw.modeReplace', { defaultValue: 'Edit file' })}
            </Button>
            <Button size="sm" variant={isMerge ? 'default' : 'outline'} onClick={() => state.changeMode('merge')}>
              {t('mcpRaw.modeMerge', { defaultValue: 'Paste servers (merge)' })}
            </Button>
          </div>

          {state.loaded?.partial && (
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {t('mcpRaw.partialNotice', { defaultValue: 'This file also holds Claude’s own state. Only the MCP servers section is shown and saved; the rest is left untouched.' })}
            </p>
          )}
          {isMerge && formatLosesComments && (
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {t('mcpRaw.commentsNotice', { defaultValue: 'Merging rewrites the file, so comments in it are lost. Use Edit file to keep them.' })}
            </p>
          )}
          {isMerge && (
            <p className="text-xs text-muted-foreground">
              {t('mcpRaw.mergeHint', { defaultValue: 'Paste a full config or just the servers. Servers with the same name are replaced; all others are kept.' })}
            </p>
          )}

          <textarea
            value={state.draft}
            onChange={(event) => state.updateDraft(event.target.value)}
            spellCheck={false}
            disabled={state.isLoading || (state.needsProject && !state.workspacePath)}
            placeholder={isMerge ? t('mcpRaw.pastePlaceholder', { defaultValue: 'Paste MCP servers here' }) : ''}
            className="h-72 w-full resize-y rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs text-foreground"
          />

          {state.error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
              {state.error}
            </div>
          )}

          {state.preview && (
            <div className="space-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {hasChanges ? (
                <>
                  <NameList label={t('mcpRaw.added', { defaultValue: 'Added' })} names={state.preview.added} />
                  <NameList label={t('mcpRaw.changed', { defaultValue: 'Changed' })} names={state.preview.changed} />
                  <NameList label={t('mcpRaw.removed', { defaultValue: 'Removed' })} names={state.preview.removed} />
                </>
              ) : (
                t('mcpRaw.noServerChanges', { defaultValue: 'No server changes.' })
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border p-4">
          <Button variant="ghost" onClick={() => void state.reload()} disabled={state.isLoading || state.isBusy}>
            {t('mcpRaw.reload', { defaultValue: 'Reload' })}
          </Button>
          <Button variant="outline" onClick={() => void state.previewChanges()} disabled={state.isBusy || state.isLoading || state.isUnchanged || (isMerge && !state.draft.trim())}>
            {t('mcpRaw.preview', { defaultValue: 'Preview changes' })}
          </Button>
          <Button onClick={() => void state.save()} disabled={state.isBusy || state.isLoading || state.isUnchanged || (isMerge && !state.draft.trim())}>
            {t('mcpRaw.save', { defaultValue: 'Save' })}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
