import { Eye, KeyRound, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { GitRemoteAccess, GitRemoteAccessState } from '@/shared/types';

type GitRemoteAccessBadgeProps = {
  access: GitRemoteAccess | null;
  isChecking: boolean;
  autoCheck: boolean;
  isMobile: boolean;
  onCheck: (force?: boolean) => void;
  onAutoCheckChange: (value: boolean) => void;
};

const STATE_STYLE: Record<GitRemoteAccessState, { icon: typeof Eye; className: string; labelKey: string }> = {
  'read-write': { icon: ShieldCheck, className: 'text-green-600 dark:text-green-400', labelKey: 'readWrite' },
  'read-only': { icon: Eye, className: 'text-amber-600 dark:text-amber-400', labelKey: 'readOnly' },
  readable: { icon: ShieldQuestion, className: 'text-muted-foreground', labelKey: 'readable' },
  'no-access': { icon: ShieldAlert, className: 'text-red-600 dark:text-red-400', labelKey: 'noAccess' },
  'not-found': { icon: ShieldAlert, className: 'text-red-600 dark:text-red-400', labelKey: 'notFound' },
  'host-key': { icon: KeyRound, className: 'text-amber-600 dark:text-amber-400', labelKey: 'hostKey' },
  unreachable: { icon: WifiOff, className: 'text-muted-foreground', labelKey: 'unreachable' },
  'no-remote': { icon: ShieldQuestion, className: 'text-muted-foreground', labelKey: 'noRemote' },
  error: { icon: ShieldQuestion, className: 'text-muted-foreground', labelKey: 'error' },
};

/**
 * Rendered by GitPanel next to the repository/branch controls. It shows whether the credentials git would use can read from and push to the remote, with the details and a manual re-check in a popover.
 */
export default function GitRemoteAccessBadge({
  access,
  isChecking,
  autoCheck,
  isMobile,
  onCheck,
  onAutoCheckChange,
}: GitRemoteAccessBadgeProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const state = access?.state;
  const style = state ? STATE_STYLE[state] : null;
  const Icon = isChecking ? Loader2 : style?.icon ?? ShieldQuestion;
  const label = isChecking
    ? t('git:remoteAccess.checking')
    : style
      ? t(`git:remoteAccess.state.${style.labelKey}`)
      : t('git:remoteAccess.notChecked');

  return (
    <div className="relative shrink-0" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen((previous) => !previous)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        title={t('git:remoteAccess.title')}
        className={`flex items-center gap-1.5 rounded-lg transition-colors hover:bg-accent ${isMobile ? 'px-2 py-1' : 'px-2.5 py-1.5'}`}
      >
        <Icon className={`h-3.5 w-3.5 ${isChecking ? 'animate-spin text-muted-foreground' : style?.className ?? 'text-muted-foreground'}`} />
        {!isMobile && <span className="text-xs text-muted-foreground">{label}</span>}
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label={t('git:remoteAccess.title')}
          className="absolute right-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center gap-2">
            <Icon className={`h-4 w-4 ${isChecking ? 'animate-spin text-muted-foreground' : style?.className ?? 'text-muted-foreground'}`} />
            <span className="text-sm font-medium">{label}</span>
          </div>

          {state && !isChecking && (
            <p className="mb-2 text-xs text-muted-foreground">{t(`git:remoteAccess.hint.${style?.labelKey}`)}</p>
          )}

          {access?.readVia === 'anonymous' && (
            <p className="mb-2 text-xs text-muted-foreground">{t('git:remoteAccess.public')}</p>
          )}

          {access?.message && state !== 'read-write' && (
            <p className="mb-2 break-words rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{access.message}</p>
          )}

          {access?.url && (
            <dl className="mb-2 space-y-0.5 text-xs">
              <div className="flex gap-2">
                <dt className="shrink-0 text-muted-foreground">{t('git:remoteAccess.remote')}</dt>
                <dd className="min-w-0 truncate" title={access.url}>
                  {access.remote} · {access.url}
                </dd>
              </div>
              {access.checkedAt && (
                <div className="flex gap-2">
                  <dt className="shrink-0 text-muted-foreground">{t('git:remoteAccess.checkedAt')}</dt>
                  <dd>{new Date(access.checkedAt).toLocaleTimeString()}</dd>
                </div>
              )}
            </dl>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
            <label className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={autoCheck}
                onChange={(event) => onAutoCheckChange(event.target.checked)}
              />
              <span className="truncate">{t('git:remoteAccess.autoCheck')}</span>
            </label>
            <button
              type="button"
              onClick={() => onCheck(true)}
              disabled={isChecking}
              className="shrink-0 rounded-lg bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {access ? t('git:remoteAccess.checkAgain') : t('git:remoteAccess.checkNow')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
