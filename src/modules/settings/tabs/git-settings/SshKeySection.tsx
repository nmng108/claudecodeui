import { Check, Copy, ExternalLink, KeyRound, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSshKey } from '@/modules/settings/hooks/useSshKey';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import { Button } from '@/shared/ui';
import { copyTextToClipboard } from '@/shared/utils';

/** Pages where a public key is added to an account. */
const ADD_KEY_LINKS = [
  { id: 'github', label: 'GitHub', href: 'https://github.com/settings/ssh/new' },
  { id: 'gitlab', label: 'GitLab', href: 'https://gitlab.com/-/user_settings/ssh_keys' },
  { id: 'bitbucket', label: 'Bitbucket', href: 'https://bitbucket.org/account/settings/ssh-keys/' },
] as const;

/**
 * Rendered by the Git settings tab: shows the public SSH key git uses over SSH,
 * to be copied into a git server, and creates one when none exists. A key is
 * only ever created on request, and only a key created here can be replaced.
 */
export default function SshKeySection() {
  const { t } = useTranslation('settings');
  const { key, isLoading, isGenerating, error, generate } = useSshKey();
  const [copied, setCopied] = useState(false);
  const [confirmingReplace, setConfirmingReplace] = useState(false);

  const handleCopy = async () => {
    if (!key?.publicKey) return;
    if (await copyTextToClipboard(key.publicKey)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleReplace = async () => {
    const replaced = await generate({ replace: true });
    if (replaced) setConfirmingReplace(false);
  };

  return (
    <SettingsSection title={t('git.sshKey.title')} description={t('git.sshKey.description')}>
      <SettingsCard className="p-4">
        <div className="space-y-4">
          {isLoading && !key && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('git.sshKey.loading')}
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          {key?.status === 'missing' && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {key.canGenerate
                  ? t('git.sshKey.missing')
                  : key.reason === 'read-only'
                    ? t('git.sshKey.readOnly', { location: key.location })
                    : t('git.sshKey.cannotGenerate')}
              </p>
              {key.canGenerate && (
                <Button type="button" onClick={() => void generate()} disabled={isGenerating}>
                  <KeyRound className="mr-2 h-4 w-4" />
                  {isGenerating ? t('git.sshKey.generating') : t('git.sshKey.generate')}
                </Button>
              )}
            </div>
          )}

          {key?.status === 'unreadable' && (
            <p className="text-sm text-muted-foreground">
              {t('git.sshKey.unreadable', { location: key.location })}
            </p>
          )}

          {key?.status === 'present' && key.publicKey && (
            <div className="space-y-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t('git.sshKey.type')}</dt>
                <dd>{key.type}</dd>
                <dt className="text-muted-foreground">{t('git.sshKey.fingerprint')}</dt>
                <dd className="break-all font-mono text-xs">{key.fingerprint}</dd>
                <dt className="text-muted-foreground">{t('git.sshKey.location')}</dt>
                <dd className="break-all font-mono text-xs">{key.location}</dd>
                <dt className="text-muted-foreground">{t('git.sshKey.origin')}</dt>
                <dd>{key.origin === 'generated' ? t('git.sshKey.originGenerated') : t('git.sshKey.originExisting')}</dd>
              </dl>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label htmlFor="settings-ssh-public-key" className="text-sm font-medium text-foreground">
                    {t('git.sshKey.publicKey')}
                  </label>
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
                    {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
                    {copied ? t('git.sshKey.copied') : t('git.sshKey.copy')}
                  </Button>
                </div>
                <textarea
                  id="settings-ssh-public-key"
                  readOnly
                  value={key.publicKey}
                  rows={3}
                  onFocus={(event) => event.currentTarget.select()}
                  className="w-full resize-none rounded-md border border-border bg-muted/40 p-2 font-mono text-xs text-foreground focus:outline-none"
                />
                <p className="mt-1 text-xs text-muted-foreground">{t('git.sshKey.addHelp')}</p>
                <div className="mt-2 flex flex-wrap gap-3 text-sm">
                  {ADD_KEY_LINKS.map((link) => (
                    <a
                      key={link.id}
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      {link.label}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ))}
                </div>
              </div>

              {key.canReplace && (
                <div className="border-t border-border pt-3">
                  {confirmingReplace ? (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">{t('git.sshKey.replaceWarning')}</p>
                      <div className="flex gap-2">
                        <Button type="button" variant="destructive" size="sm" onClick={() => void handleReplace()} disabled={isGenerating}>
                          {isGenerating ? t('git.sshKey.generating') : t('git.sshKey.replaceConfirm')}
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingReplace(false)} disabled={isGenerating}>
                          {t('git.sshKey.cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingReplace(true)}>
                      {t('git.sshKey.replace')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          <p className="border-t border-border pt-3 text-xs text-muted-foreground">{t('git.sshKey.warning')}</p>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}