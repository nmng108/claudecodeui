import { Edit3, ExternalLink, FileJson, Globe, Link2, Lock, Plus, Server, Terminal, Trash2, Users, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CentralMcpServer, McpFormState, McpProject, McpProvider, McpScope, ProviderMcpServer } from '@/shared/types';
import { IS_PLATFORM } from '@/shared/utils';
import { ActionMenu, Badge, Button } from '@/shared/ui';
import { MCP_GLOBAL_SUPPORTED_TRANSPORTS, MCP_PROVIDER_NAMES, MCP_SUPPORTS_ENABLE_TOGGLE } from '@/shared/constants';
import { useMcpServers } from '@/modules/mcp/hooks/useMcpServers';
import { maskSecret } from '@/modules/mcp/utils/mcpFormatting';
import McpServerFormModal from '@/modules/mcp/McpServerFormModal';
import McpRawConfigModal from '@/modules/mcp/McpRawConfigModal';
import CentralMcpModal from '@/modules/mcp/CentralMcpModal';
import { describeCentralFailures, useCentralMcpServers } from '@/modules/mcp/hooks/useCentralMcpServers';
import { createMcpPayloadFromForm, getErrorMessage } from '@/modules/mcp/utils/mcpFormatting';

type McpServersProps = {
  selectedProvider: McpProvider;
  currentProjects: McpProject[];
};

const MCP_GLOBAL_SUPPORTED_SCOPES: McpScope[] = ['user', 'project'];

const MCP_PROVIDER_BUTTON_CLASSES: Record<McpProvider, string> = {
  claude: 'bg-primary text-primary-foreground hover:bg-primary/90',
  cursor: 'bg-primary text-primary-foreground hover:bg-primary/90',
  codex: 'bg-primary text-primary-foreground hover:bg-primary/90',
  opencode: 'bg-primary text-primary-foreground hover:bg-primary/90',
  kiro: 'bg-primary text-primary-foreground hover:bg-primary/90',
};

const getTransportIcon = (transport: string | undefined) => {
  if (transport === 'stdio') {
    return <Terminal className="h-4 w-4" />;
  }

  if (transport === 'sse') {
    return <Zap className="h-4 w-4" />;
  }

  if (transport === 'http') {
    return <Globe className="h-4 w-4" />;
  }

  return <Server className="h-4 w-4" />;
};

const getScopeLabel = (scope: McpScope): string => {
  if (scope === 'user') {
    return 'user';
  }

  if (scope === 'local') {
    return 'local';
  }

  return 'project';
};

const getServerKey = (server: ProviderMcpServer): string => (
  `${server.provider}:${server.scope}:${server.workspacePath || 'global'}:${server.name}`
);

// Servers prefixed with `cloudcli-` are written and removed automatically by a
// CloudCLI feature toggle (e.g. the Browser tab), not added by the user. They are
// shown read-only so users don't edit/delete them out of sync with the feature.
const isManagedServer = (server: ProviderMcpServer): boolean => server.name.startsWith('cloudcli-');

// Minimal on/off switch for a server row; used only by this list.
function EnabledSwitch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-muted-foreground/30'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

function ConfigLine({ label, children }: { label: string; children: string }) {
  if (!children) {
    return null;
  }

  return (
    <div>
      {label}:{' '}
      <code className="rounded bg-muted px-1 text-xs">{children}</code>
    </div>
  );
}

function TeamMcpFeatureCard() {
  const { t } = useTranslation('settings');
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
          <Users className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium text-foreground">{t('mcpTeamCard.title')}</h4>
            <Lock className="h-3 w-3 text-muted-foreground/60" />
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('mcpTeamCard.description')}
          </p>
          <a
            href="https://cloudcli.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:underline"
          >
            {t('mcpTeamCard.proLink')}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

/** Rendered by the settings module's agents tab to list and manage one provider's MCP servers. */
export default function McpServers({ selectedProvider, currentProjects }: McpServersProps) {
  const { t } = useTranslation('settings');
  const {
    servers,
    isLoading,
    isLoadingProjectScopes,
    loadError,
    deleteError,
    saveStatus,
    serverForm,
    openForm,
    openGlobalForm,
    closeForm,
    submitForm,
    submitGlobalForm,
    deleteServer: deleteProviderServer,
    toggleServerEnabled: toggleProviderServerEnabled,
    reloadServers,
  } = useMcpServers({ selectedProvider, currentProjects });

  // Whether the raw config editor is open; local to this list since nothing else needs it.
  const [isRawEditorOpen, setIsRawEditorOpen] = useState(false);
  // Whether the shared servers dialog is open.
  const [isSharedOpen, setIsSharedOpen] = useState(false);
  // The shared server being edited in the form, if any; the form modal is mounted only while this is set.
  const [editingShared, setEditingShared] = useState<CentralMcpServer | null>(null);
  // Problem from the last shared-server action on a row, shown above the list.
  const [sharedError, setSharedError] = useState<string | null>(null);
  const central = useCentralMcpServers();

  // The form hook reloads its fields whenever this object's identity changes, so it must be
  // stable while the form is open; an inline literal would wipe what the user has typed on
  // every re-render of this list.
  const sharedFormServer = useMemo<ProviderMcpServer | null>(() => (editingShared ? {
    provider: selectedProvider,
    name: editingShared.name,
    scope: editingShared.scope,
    transport: editingShared.transport,
    command: editingShared.command,
    args: editingShared.args,
    env: editingShared.env,
    url: editingShared.url,
    headers: editingShared.headers,
    workspacePath: editingShared.workspacePath,
  } : null), [editingShared, selectedProvider]);

  const findShared = (server: ProviderMcpServer): CentralMcpServer | undefined => central.servers.find((candidate) => (
    candidate.name === server.name
    && candidate.scope === server.scope
    && (candidate.workspacePath ?? '') === (server.workspacePath ?? '')
  ));

  // Runs a shared-server action from a list row and refreshes both lists afterwards.
  const runSharedAction = async (action: () => Promise<Parameters<typeof describeCentralFailures>[0]>) => {
    setSharedError(null);
    try {
      setSharedError(describeCentralFailures(await action()));
    } catch (error) {
      setSharedError(getErrorMessage(error));
    }

    await reloadServers();
  };

  const submitSharedEdit = async (formData: McpFormState) => {
    if (!editingShared) {
      return;
    }

    const payload = createMcpPayloadFromForm(selectedProvider, formData, {
      supportedTransports: MCP_GLOBAL_SUPPORTED_TRANSPORTS,
      supportsWorkingDirectory: false,
      includeProviderSpecificFields: false,
    });
    const failures = describeCentralFailures(await central.update(editingShared.id, {
      transport: payload.transport,
      command: payload.command,
      args: payload.args,
      env: payload.env,
      url: payload.url,
      headers: payload.headers,
    }));
    await reloadServers();
    if (failures) {
      throw new Error(failures);
    }

    setEditingShared(null);
  };

  const providerName = MCP_PROVIDER_NAMES[selectedProvider];
  const description = t(`mcpServers.description.${selectedProvider}`, {
    defaultValue: `Model Context Protocol servers provide additional tools and data sources to ${providerName}`,
  });
  const globalButtonLabel = t('mcpServersAdd.globalButtonLabel');
  const providerButtonLabel = t('mcpServersAdd.providerButtonLabel', { provider: providerName });
  const globalAddDescription = t('mcpServersAdd.globalAddDescription');
  const providerAddDescription = t('mcpServersAdd.providerAddDescription', { button: providerButtonLabel, provider: providerName });
  const globalModalDescription = t('mcpServersAdd.globalModalDescription');

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Server className="mt-0.5 h-5 w-5 flex-shrink-0 text-purple-500" />
          <div className="min-w-0 space-y-1">
            <h3 className="text-lg font-medium text-foreground">{t('mcpServers.title')}</h3>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <Button variant="outline" onClick={() => setIsSharedOpen(true)} className="w-full sm:w-auto">
          <Link2 className="mr-2 h-4 w-4" />
          {t('mcpShared.openButton', { defaultValue: 'Shared servers' })}
          {central.servers.length > 0 && ` (${central.servers.length})`}
        </Button>
        <Button variant="outline" onClick={() => setIsRawEditorOpen(true)} className="w-full sm:w-auto">
          <FileJson className="mr-2 h-4 w-4" />
          {t('mcpRaw.openButton', { defaultValue: 'Edit config' })}
        </Button>
        <ActionMenu
          label={t('mcpServersAdd.menuLabel')}
          icon={Plus}
          className="w-full sm:w-auto"
          triggerClassName={`w-full sm:w-auto ${MCP_PROVIDER_BUTTON_CLASSES[selectedProvider]}`}
          items={[
            {
              key: 'global',
              label: globalButtonLabel,
              description: globalAddDescription,
              icon: Globe,
              onSelect: openGlobalForm,
            },
            {
              key: 'provider',
              label: providerButtonLabel,
              description: providerAddDescription,
              icon: Server,
              onSelect: () => openForm(),
            },
          ]}
        />
        </div>
      </div>

      <div className="space-y-2">
        <div className="min-h-4">
          {saveStatus === 'success' && (
            <span className="animate-in fade-in text-xs text-muted-foreground">{t('saveStatus.success')}</span>
          )}
          {isLoadingProjectScopes && (
            <span className="animate-in fade-in text-xs text-muted-foreground">{t('mcpServersAdd.refreshingScopes')}</span>
          )}
        </div>
      </div>

      {sharedError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-200">
          {sharedError}
        </div>
      )}

      {(loadError || deleteError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
          {deleteError || loadError}
        </div>
      )}

      <div className="space-y-2">
        {isLoading && servers.length === 0 && (
          <div className="py-8 text-center text-muted-foreground">{t('mcpServersAdd.loadingServers')}</div>
        )}

        {servers.map((server) => {
          const managed = isManagedServer(server);
          const shared = findShared(server);
          const sharedTarget = shared?.targets.find((target) => target.provider === selectedProvider);

          return (
            <div key={getServerKey(server)} className="rounded-lg border border-border bg-card/50 p-4">
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    {!managed && getTransportIcon(server.transport)}
                    <span className={`font-medium ${server.enabled === false ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{server.name}</span>
                    {server.enabled === false && (
                      <Badge variant="outline" className="text-xs text-muted-foreground">
                        {t('mcpServers.disabledBadge', { defaultValue: 'Disabled' })}
                      </Badge>
                    )}
                    {!managed && (
                      <>
                        <Badge variant="outline" className="text-xs">
                          {server.transport || 'stdio'}
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {getScopeLabel(server.scope)}
                        </Badge>
                        {server.projectDisplayName && (
                          <Badge variant="outline" className="max-w-full truncate text-xs">
                            {server.projectDisplayName}
                          </Badge>
                        )}
                      </>
                    )}
                    {shared && sharedTarget && (
                      <Badge
                        variant="outline"
                        className={`gap-1 text-xs ${sharedTarget.state === 'drifted' ? 'border-amber-400 text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
                        title={sharedTarget.differences.join(', ')}
                      >
                        <Link2 className="h-3 w-3" />
                        {sharedTarget.state === 'drifted'
                          ? t('mcpShared.differsBadge', { defaultValue: 'Differs from shared' })
                          : t('mcpShared.sharedBadge', { defaultValue: 'Shared' })}
                      </Badge>
                    )}
                    {managed && (
                      <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
                        <Lock className="h-3 w-3" />
                        {t('mcpServers.managed.badge', { defaultValue: 'Managed' })}
                      </Badge>
                    )}
                  </div>

                  <div className="space-y-1 text-sm text-muted-foreground">
                    {shared && sharedTarget?.state === 'drifted' && (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span>{t('mcpShared.differsIn', { fields: sharedTarget.differences.join(', '), defaultValue: `Differs from the shared definition in: ${sharedTarget.differences.join(', ')}` })}</span>
                        <button type="button" className="text-primary hover:underline" onClick={() => void runSharedAction(() => central.resync(shared.id, selectedProvider))}>
                          {t('mcpShared.reapply', { defaultValue: 'Re-apply' })}
                        </button>
                        <button type="button" className="text-primary hover:underline" onClick={() => void runSharedAction(() => central.adopt(shared.id, selectedProvider))}>
                          {t('mcpShared.useAsShared', { defaultValue: 'Use as shared' })}
                        </button>
                      </div>
                    )}
                    {!managed && (
                      <>
                        <ConfigLine label={t('mcpServers.config.command')}>{server.command || ''}</ConfigLine>
                        <ConfigLine label={t('mcpServers.config.url')}>{server.url || ''}</ConfigLine>
                        <ConfigLine label={t('mcpServers.config.args')}>{(server.args || []).join(' ')}</ConfigLine>
                        <ConfigLine label={t('mcpServersAdd.configCwd')}>{server.cwd || ''}</ConfigLine>
                        {server.env && Object.keys(server.env).length > 0 && (
                          <ConfigLine label={t('mcpServers.config.environment')}>
                            {Object.entries(server.env).map(([key, value]) => `${key}=${maskSecret(value)}`).join(', ')}
                          </ConfigLine>
                        )}
                        {server.envVars && server.envVars.length > 0 && (
                          <ConfigLine label={t('mcpServersAdd.configEnvVars')}>{server.envVars.join(', ')}</ConfigLine>
                        )}
                      </>
                    )}
                    {managed && (
                      <div className="text-xs text-muted-foreground">
                        {t('mcpServers.managed.hint', {
                          defaultValue: 'Managed by CloudCLI.',
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {!managed && (
                  <div className="ml-4 flex items-center gap-2">
                    {!shared && server.scope !== 'local' && server.transport !== 'sse' && (
                      <Button
                        onClick={() => void runSharedAction(() => central.importEntry({
                          provider: selectedProvider,
                          name: server.name,
                          scope: server.scope,
                          workspacePath: server.workspacePath,
                        }))}
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-foreground"
                        title={t('mcpShared.shareAction', { defaultValue: 'Manage as a shared server' })}
                      >
                        <Link2 className="h-4 w-4" />
                      </Button>
                    )}
                    {MCP_SUPPORTS_ENABLE_TOGGLE[selectedProvider] && server.enabled !== undefined && (
                      <EnabledSwitch
                        checked={server.enabled}
                        label={server.enabled
                          ? t('mcpServers.actions.disable', { defaultValue: 'Disable server' })
                          : t('mcpServers.actions.enable', { defaultValue: 'Enable server' })}
                        onChange={(next) => void toggleProviderServerEnabled(server, next).then(central.reload)}
                      />
                    )}
                    <Button
                      onClick={() => openForm(server)}
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-foreground"
                      title={t('mcpServers.actions.edit')}
                    >
                      <Edit3 className="h-4 w-4" />
                    </Button>
                    <Button
                      onClick={() => void deleteProviderServer(server).then(central.reload)}
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:text-red-700"
                      title={t('mcpServers.actions.delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {!isLoading && !isLoadingProjectScopes && servers.length === 0 && (
          <div className="py-8 text-center text-muted-foreground">{t('mcpServers.empty')}</div>
        )}
      </div>

      {selectedProvider === 'codex' && (
        <div className="rounded-lg border border-border bg-muted/50 p-4">
          <h4 className="mb-2 font-medium text-foreground">{t('mcpServers.help.title')}</h4>
          <p className="text-sm text-muted-foreground">{t('mcpServers.help.description')}</p>
        </div>
      )}

      {selectedProvider === 'claude' && !IS_PLATFORM && <TeamMcpFeatureCard />}

      {/* Mounted only while open: each instance runs a full useMcpServerForm. */}
      {serverForm?.scope === 'provider' && (
        <McpServerFormModal
          provider={selectedProvider}
          editingServer={serverForm.editingServer}
          currentProjects={currentProjects}
          title={serverForm.editingServer ? undefined : providerButtonLabel}
          submitLabel={providerButtonLabel}
          onClose={closeForm}
          onSubmit={async (formData, editingServer) => {
            await submitForm(formData, editingServer);
            await central.reload();
          }}
        />
      )}

      {isRawEditorOpen && (
        <McpRawConfigModal
          provider={selectedProvider}
          currentProjects={currentProjects}
          onClose={() => setIsRawEditorOpen(false)}
          onSaved={reloadServers}
        />
      )}

      {serverForm?.scope === 'global' && (
        <McpServerFormModal
          provider={selectedProvider}
          mode="global"
          editingServer={null}
          currentProjects={currentProjects}
          title={globalButtonLabel}
          description={globalModalDescription}
          submitLabel={globalButtonLabel}
          supportedScopes={MCP_GLOBAL_SUPPORTED_SCOPES}
          supportedTransports={MCP_GLOBAL_SUPPORTED_TRANSPORTS}
          onClose={closeForm}
          onSubmit={async (formData) => {
            try {
              await submitGlobalForm(formData);
            } finally {
              await central.reload();
            }
          }}
        />
      )}

      {isSharedOpen && (
        <CentralMcpModal
          central={central}
          onEdit={(server) => {
            setIsSharedOpen(false);
            setEditingShared(server);
          }}
          onClose={() => setIsSharedOpen(false)}
          onProvidersChanged={reloadServers}
        />
      )}

      {sharedFormServer && (
        <McpServerFormModal
          provider={selectedProvider}
          mode="global"
          editingServer={sharedFormServer}
          currentProjects={currentProjects}
          title={t('mcpShared.editTitle', { defaultValue: 'Edit shared server' })}
          description={t('mcpShared.editDescription', { defaultValue: 'Changes are written to every provider this server is linked to.' })}
          supportedScopes={MCP_GLOBAL_SUPPORTED_SCOPES}
          supportedTransports={MCP_GLOBAL_SUPPORTED_TRANSPORTS}
          onClose={() => setEditingShared(null)}
          onSubmit={submitSharedEdit}
        />
      )}
    </div>
  );
}
