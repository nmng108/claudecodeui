import { Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Badge, Button } from '@/shared/ui';
import { MCP_PROVIDER_NAMES } from '@/shared/constants';
import type { CentralSkillApplyResult, CentralSkillState } from '@/shared/types';
import { describeCentralSkillProblems } from '@/modules/skills/hooks/useCentralSkills';
import type { CentralSkillsState } from '@/modules/skills/hooks/useCentralSkills';

type CentralSkillsModalProps = {
  central: CentralSkillsState;
  onClose: () => void;
  /** Called after a change, so the provider's own skill list can refresh. */
  onChanged: () => Promise<void>;
};

const STATE_CLASSES: Record<CentralSkillState, string> = {
  native: 'text-muted-foreground',
  linked: 'text-green-700 dark:text-green-400',
  copy_in_sync: 'text-green-700 dark:text-green-400',
  copy_drifted: 'text-amber-700 dark:text-amber-400',
  broken: 'text-red-700 dark:text-red-400',
  conflict: 'text-amber-700 dark:text-amber-400',
  unlinked: 'text-muted-foreground',
};

/** Rendered by ProviderSkills to manage skills kept in one shared folder and linked into each provider. */
export default function CentralSkillsModal({ central, onClose, onChanged }: CentralSkillsModalProps) {
  const { t } = useTranslation('settings');
  // Last operation problem to show; cleared by the next action.
  const [message, setMessage] = useState<string | null>(null);

  const stateLabel = (state: CentralSkillState): string => ({
    native: t('skillsShared.state.native', { defaultValue: 'Reads shared folder' }),
    linked: t('skillsShared.state.linked', { defaultValue: 'Linked' }),
    copy_in_sync: t('skillsShared.state.copyInSync', { defaultValue: 'Copy, in sync' }),
    copy_drifted: t('skillsShared.state.copyDrifted', { defaultValue: 'Copy differs' }),
    broken: t('skillsShared.state.broken', { defaultValue: 'Broken link' }),
    conflict: t('skillsShared.state.conflict', { defaultValue: 'Other folder in the way' }),
    unlinked: t('skillsShared.state.unlinked', { defaultValue: 'Not linked' }),
  })[state];

  const act = async (action: () => Promise<CentralSkillApplyResult[]>) => {
    setMessage(null);
    try {
      setMessage(describeCentralSkillProblems(await action()));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unknown error');
    }

    await onChanged();
  };

  return createPortal(
    <div data-escape-layer className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="text-lg font-medium text-foreground">{t('skillsShared.title', { defaultValue: 'Shared skills' })}</h3>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-3 overflow-y-auto p-4">
          <p className="text-sm text-muted-foreground">
            {t('skillsShared.description', { defaultValue: 'Shared skills live in ~/.agents/skills and are linked into each provider’s skills folder, so an edit shows up everywhere. Use "Add to shared folder" when adding a skill, or "Share" on an existing one.' })}
          </p>

          {(message || central.error) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-200">
              {message || central.error}
            </div>
          )}

          {central.skills.length === 0 && (
            <div className="py-8 text-center text-muted-foreground">
              {t('skillsShared.empty', { defaultValue: 'No shared skills yet.' })}
            </div>
          )}

          {central.skills.map((skill) => {
            const linkable = skill.providers.filter((entry) => entry.state !== 'native');
            const needsAttention = linkable.some((entry) => entry.state === 'copy_drifted' || entry.state === 'broken');
            const anyUnlinked = linkable.some((entry) => entry.state === 'unlinked');
            return (
              <div key={skill.directoryName} className="rounded-lg border border-border bg-card/50 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-foreground">{skill.directoryName}</span>
                      {skill.name !== skill.directoryName && <Badge variant="outline" className="text-xs">{skill.name}</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">{skill.description}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600 hover:text-red-700"
                    title={t('skillsShared.delete', { defaultValue: 'Delete from shared folder' })}
                    onClick={() => {
                      if (window.confirm(t('skillsShared.deleteConfirm', { defaultValue: 'Delete this skill from the shared folder and remove its links?' }))) {
                        void act(() => central.remove(skill.directoryName));
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {skill.providers.map((entry) => (
                    <div key={entry.provider} className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
                      <span className="font-medium text-foreground">{MCP_PROVIDER_NAMES[entry.provider]}</span>
                      <span className={STATE_CLASSES[entry.state]}>{stateLabel(entry.state)}</span>
                      {entry.state === 'unlinked' && (
                        <button type="button" className="text-primary hover:underline" onClick={() => void act(() => central.link(skill.directoryName, [entry.provider]))}>
                          {t('skillsShared.link', { defaultValue: 'Link' })}
                        </button>
                      )}
                      {(entry.state === 'copy_drifted' || entry.state === 'broken') && (
                        <button type="button" className="text-primary hover:underline" onClick={() => void act(() => central.resync(skill.directoryName, [entry.provider]))}>
                          {t('skillsShared.reapply', { defaultValue: 'Re-apply' })}
                        </button>
                      )}
                      {(entry.state === 'linked' || entry.state === 'copy_in_sync' || entry.state === 'copy_drifted' || entry.state === 'broken') && (
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          title={t('skillsShared.unlink', { defaultValue: 'Remove the link from this provider' })}
                          onClick={() => void act(() => central.unlink(skill.directoryName, [entry.provider]))}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {(anyUnlinked || needsAttention) && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {anyUnlinked && (
                      <Button size="sm" variant="outline" onClick={() => void act(() => central.link(skill.directoryName))}>
                        {t('skillsShared.linkAll', { defaultValue: 'Link to all providers' })}
                      </Button>
                    )}
                    {needsAttention && (
                      <Button size="sm" variant="outline" onClick={() => void act(() => central.resync(skill.directoryName))}>
                        {t('skillsShared.reapplyAll', { defaultValue: 'Re-apply to all' })}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
