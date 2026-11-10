import { Edit3, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Badge, Button } from '@/shared/ui';
import { MCP_PROVIDER_NAMES, MCP_SUPPORTS_ENABLE_TOGGLE } from '@/shared/constants';
import type { CentralMcpApplyResult, CentralMcpServer, CentralMcpTargetState, McpProvider } from '@/shared/types';
import { describeCentralFailures } from '@/modules/mcp/hooks/useCentralMcpServers';
import type { CentralMcpServersState } from '@/modules/mcp/hooks/useCentralMcpServers';
import { getErrorMessage } from '@/modules/mcp/utils/mcpFormatting';

type CentralMcpModalProps = {
  central: CentralMcpServersState;
  onEdit: (server: CentralMcpServer) => void;
  onClose: () => void;
  /** Called after a change that rewrote provider config, so the provider list can refresh. */
  onProvidersChanged: () => Promise<void>;
};

const ALL_PROVIDERS: McpProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'kiro'];

const STATE_CLASSES: Record<CentralMcpTargetState, string> = {
  in_sync: 'text-green-700 dark:text-green-400',
  drifted: 'text-amber-700 dark:text-amber-400',
  missing: 'text-red-700 dark:text-red-400',
  paused: 'text-muted-foreground',
};

/** Rendered by McpServers to manage MCP servers that are defined once and applied to several providers. */
export default function CentralMcpModal({ central, onEdit, onClose, onProvidersChanged }: CentralMcpModalProps) {
  const { t } = useTranslation('settings');
  // Last operation problem to show; cleared by the next action.
  const [message, setMessage] = useState<string | null>(null);

  const stateLabel = (state: CentralMcpTargetState): string => ({
    in_sync: t('mcpShared.state.inSync', { defaultValue: 'In sync' }),
    drifted: t('mcpShared.state.drifted', { defaultValue: 'Differs' }),
    missing: t('mcpShared.state.missing', { defaultValue: 'Missing' }),
    paused: t('mcpShared.state.paused', { defaultValue: 'Paused' }),
  })[state];

  // Every action refreshes the shared list itself; provider lists are refreshed here.
  const act = async (action: () => Promise<CentralMcpApplyResult[]>) => {
    setMessage(null);
    try {
      const failures = describeCentralFailures(await action());
      if (failures) {
        setMessage(failures);
      }
    } catch (error) {
      setMessage(getErrorMessage(error));
    }

    await onProvidersChanged();
  };

  return createPortal(
    <div data-escape-layer className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="text-lg font-medium text-foreground">{t('mcpShared.title', { defaultValue: 'Shared MCP servers' })}</h3>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-3 overflow-y-auto p-4">
          <p className="text-sm text-muted-foreground">
            {t('mcpShared.description', { defaultValue: 'A shared server is defined once and written into each linked provider by name. Edit it here to update all of them.' })}
          </p>

          {(message || central.error) && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
              {message || central.error}
            </div>
          )}

          {central.servers.length === 0 && (
            <div className="py-8 text-center text-muted-foreground">
              {t('mcpShared.empty', { defaultValue: 'No shared servers yet. Use "Add to all providers" to create one.' })}
            </div>
          )}

          {central.servers.map((server) => {
            const linked = new Set(server.targets.map((target) => target.provider));
            const needsAttention = server.targets.some((target) => target.state === 'drifted' || target.state === 'missing');
            const allEnabled = server.targets.length > 0 && server.targets.every((target) => target.enabled);

            return (
              <div key={server.id} className="rounded-lg border border-border bg-card/50 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{server.name}</span>
                      <Badge variant="outline" className="text-xs">{server.transport}</Badge>
                      <Badge variant="outline" className="text-xs">{server.scope}</Badge>
                    </div>
                    <div className="truncate text-sm text-muted-foreground">
                      {server.transport === 'stdio' ? [server.command, ...(server.args ?? [])].join(' ') : server.url}
                    </div>
                    {server.workspacePath && (
                      <div className="truncate text-xs text-muted-foreground">{server.workspacePath}</div>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <Button variant="ghost" size="sm" title={t('mcpServers.actions.edit')} onClick={() => onEdit(server)}>
                      <Edit3 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:text-red-700"
                      title={t('mcpServers.actions.delete')}
                      onClick={() => {
                        if (window.confirm(t('mcpShared.deleteConfirm', { defaultValue: 'Delete this shared server and remove it from every linked provider?' }))) {
                          void act(() => central.remove(server.id));
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {server.targets.map((target) => (
                    <div key={target.provider} className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
                      <span className="font-medium text-foreground">{MCP_PROVIDER_NAMES[target.provider]}</span>
                      <span
                        className={STATE_CLASSES[target.state]}
                        title={target.error || target.differences.join(', ')}
                      >
                        {stateLabel(target.state)}
                        {target.differences.length > 0 && `: ${target.differences.join(', ')}`}
                      </span>
                      <label className="flex items-center gap-1 text-muted-foreground" title={MCP_SUPPORTS_ENABLE_TOGGLE[target.provider]
                        ? undefined
                        : t('mcpShared.pauseHint', { defaultValue: 'This provider has no on/off field, so switching off removes the entry until you switch it on.' })}
                      >
                        <input
                          type="checkbox"
                          checked={target.enabled}
                          onChange={(event) => void act(() => central.setEnabled(server.id, event.target.checked, [target.provider]))}
                        />
                        {t('mcpShared.on', { defaultValue: 'On' })}
                      </label>
                      {(target.state === 'drifted' || target.state === 'missing') && (
                        <>
                          <button type="button" className="text-primary hover:underline" onClick={() => void act(() => central.resync(server.id, target.provider))}>
                            {t('mcpShared.reapply', { defaultValue: 'Re-apply' })}
                          </button>
                          {target.state === 'drifted' && (
                            <button type="button" className="text-primary hover:underline" onClick={() => void act(() => central.adopt(server.id, target.provider))}>
                              {t('mcpShared.useAsShared', { defaultValue: 'Use as shared' })}
                            </button>
                          )}
                        </>
                      )}
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        title={t('mcpShared.unlink', { defaultValue: 'Remove from this provider' })}
                        onClick={() => void act(() => central.update(server.id, { providers: [...linked].filter((provider) => provider !== target.provider) }))}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  {ALL_PROVIDERS.filter((provider) => !linked.has(provider)).map((provider) => (
                    <button
                      key={provider}
                      type="button"
                      className="rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => void act(() => central.update(server.id, { providers: [...linked, provider] }))}
                    >
                      + {MCP_PROVIDER_NAMES[provider]}
                    </button>
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void act(() => central.setEnabled(server.id, !allEnabled))}>
                    {allEnabled
                      ? t('mcpShared.disableAll', { defaultValue: 'Switch off everywhere' })
                      : t('mcpShared.enableAll', { defaultValue: 'Switch on everywhere' })}
                  </Button>
                  {needsAttention && (
                    <Button size="sm" variant="outline" onClick={() => void act(() => central.resync(server.id))}>
                      {t('mcpShared.reapplyAll', { defaultValue: 'Re-apply to all' })}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
