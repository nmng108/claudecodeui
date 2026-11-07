import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import type { KiroLoginMethod, KiroLoginState, ProviderAuthStatus } from '@/shared/types';

const POLL_INTERVAL_MS = 2000;
const REMEMBERED_ORGANIZATION_KEY = 'kiro-login-organization';

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: { message?: string };
  message?: string;
};

type KiroLoginPanelProps = {
  /** Current auth status for `kiro`, used to show an existing sign-in and to explain what takes precedence. */
  authStatus: ProviderAuthStatus;
  /** Called after a sign-in or sign-out so the caller can refresh the auth status. */
  onChanged: () => void;
};

type Organization = { startUrl: string; region: string };

function readRememberedOrganization(): Organization {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(REMEMBERED_ORGANIZATION_KEY) ?? '{}') as Partial<Organization>;
    return {
      startUrl: typeof parsed.startUrl === 'string' ? parsed.startUrl : '',
      region: typeof parsed.region === 'string' ? parsed.region : '',
    };
  } catch {
    return { startUrl: '', region: '' };
  }
}

async function readEnvelope<T>(response: Response, fallbackMessage: string): Promise<T> {
  const body = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !body?.success || body.data === undefined) {
    throw new Error(body?.error?.message || body?.message || fallbackMessage);
  }
  return body.data;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be blocked (insecure origin); the value stays selectable on screen.
    }
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()} aria-label={label}>
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

/**
 * Browser sign-in for Kiro through the OAuth device flow. The server runs
 * `kiro-cli login --use-device-flow` and hands back a verification URL and a
 * one-time code; the user confirms them in any browser (the machine running
 * the server needs none) and this panel polls until the CLI reports the result.
 * "Organization" signs in with an IAM Identity Center start URL and region.
 */
export default function KiroLoginPanel({ authStatus, onChanged }: KiroLoginPanelProps) {
  const { t } = useTranslation('settings');
  const [method, setMethod] = useState<KiroLoginMethod>('builder-id');
  const [organization, setOrganization] = useState<Organization>(readRememberedOrganization);
  const [login, setLogin] = useState<KiroLoginState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const notifiedSuccessRef = useRef(false);

  const status = login?.status ?? 'idle';
  const isRunning = status === 'starting' || status === 'awaiting_confirmation';
  const hasCliLogin = authStatus.authenticated && authStatus.method === 'cli_login';
  const hasApiKey = authStatus.authenticated
    && (authStatus.method === 'environment' || authStatus.method === 'credentials_file');
  const canStart = method === 'builder-id' || (organization.startUrl.trim() !== '' && organization.region.trim() !== '');

  // A sign-in started before the panel was opened (or in another tab) is picked up.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await readEnvelope<KiroLoginState>(await api.providers.kiroLoginState(), '');
        if (!cancelled && (state.status === 'starting' || state.status === 'awaiting_confirmation')) {
          setLogin(state);
          if (state.method) setMethod(state.method);
        }
      } catch {
        // No sign-in to resume.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll while the user confirms the code in the browser.
  useEffect(() => {
    if (!isRunning) {
      return undefined;
    }
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const state = await readEnvelope<KiroLoginState>(await api.providers.kiroLoginState(), '');
          if (!cancelled) setLogin(state);
        } catch {
          // Transient failure: keep polling.
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isRunning]);

  useEffect(() => {
    if (status === 'succeeded' && !notifiedSuccessRef.current) {
      notifiedSuccessRef.current = true;
      onChanged();
    }
  }, [status, onChanged]);

  const handleStart = useCallback(async () => {
    setError(null);
    setIsStarting(true);
    notifiedSuccessRef.current = false;
    try {
      const input = method === 'builder-id'
        ? { method }
        : { method, startUrl: organization.startUrl.trim(), region: organization.region.trim() };
      if (method === 'identity-center') {
        window.localStorage.setItem(REMEMBERED_ORGANIZATION_KEY, JSON.stringify({
          startUrl: input.startUrl,
          region: input.region,
        }));
      }
      setLogin(await readEnvelope<KiroLoginState>(await api.providers.startKiroLogin(input), t('agents.kiro.login.errors.startFailed')));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('agents.kiro.login.errors.startFailed'));
    } finally {
      setIsStarting(false);
    }
  }, [method, organization, t]);

  const handleCancel = useCallback(async () => {
    try {
      setLogin(await readEnvelope<KiroLoginState>(await api.providers.cancelKiroLogin(), ''));
    } catch {
      setLogin(null);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    setError(null);
    setIsSigningOut(true);
    try {
      const response = await api.providers.kiroLogout();
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ApiEnvelope<unknown> | null;
        throw new Error(body?.error?.message || body?.message || t('agents.kiro.login.errors.signOutFailed'));
      }
      setLogin(null);
      onChanged();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('agents.kiro.login.errors.signOutFailed'));
    } finally {
      setIsSigningOut(false);
    }
  }, [onChanged, t]);

  return (
    <div className="space-y-4 p-4">
      <div>
        <h3 className="text-base font-medium text-foreground">{t('agents.kiro.login.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('agents.kiro.login.description')}</p>
      </div>

      {hasCliLogin && (
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <div className="text-sm font-medium text-foreground">{t('agents.kiro.login.signedIn')}</div>
          <div className="mt-1 break-all text-sm text-muted-foreground">{authStatus.email}</div>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void handleSignOut()}
            disabled={isSigningOut}
          >
            {isSigningOut && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('agents.kiro.login.signOut')}
          </Button>
        </div>
      )}

      {hasApiKey && (
        <p className="text-xs text-muted-foreground">{t('agents.kiro.login.apiKeyTakesPrecedence')}</p>
      )}

      {!isRunning && (
        <div className="space-y-3">
          <div role="radiogroup" aria-label={t('agents.kiro.login.methodLabel')} className="space-y-2">
            {([
              ['builder-id', 'builderId'],
              ['identity-center', 'organization'],
            ] as const).map(([value, key]) => (
              <label
                key={value}
                className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 text-sm has-[:checked]:border-primary"
              >
                <input
                  type="radio"
                  name="kiro-login-method"
                  className="mt-1"
                  checked={method === value}
                  onChange={() => setMethod(value)}
                />
                <span>
                  <span className="block font-medium text-foreground">{t(`agents.kiro.login.methods.${key}.title`)}</span>
                  <span className="block text-muted-foreground">{t(`agents.kiro.login.methods.${key}.description`)}</span>
                </span>
              </label>
            ))}
          </div>

          {method === 'identity-center' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="kiro-login-start-url" className="text-sm font-medium text-foreground">
                  {t('agents.kiro.login.startUrlLabel')}
                </label>
                <Input
                  id="kiro-login-start-url"
                  type="url"
                  autoComplete="off"
                  value={organization.startUrl}
                  onChange={(event) => setOrganization((current) => ({ ...current, startUrl: event.target.value }))}
                  placeholder="https://your-org.awsapps.com/start"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="kiro-login-region" className="text-sm font-medium text-foreground">
                  {t('agents.kiro.login.regionLabel')}
                </label>
                <Input
                  id="kiro-login-region"
                  autoComplete="off"
                  value={organization.region}
                  onChange={(event) => setOrganization((current) => ({ ...current, region: event.target.value }))}
                  placeholder="us-east-1"
                />
                <p className="text-xs text-muted-foreground">{t('agents.kiro.login.organizationHint')}</p>
              </div>
            </div>
          )}

          <Button onClick={() => void handleStart()} disabled={isStarting || !canStart}>
            {isStarting && <Loader2 className="h-4 w-4 animate-spin" />}
            {status === 'failed' || status === 'cancelled' ? t('agents.kiro.login.tryAgain') : t('agents.kiro.login.start')}
          </Button>
        </div>
      )}

      {status === 'starting' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('agents.kiro.login.starting')}
        </div>
      )}

      {status === 'awaiting_confirmation' && login?.verificationUrl && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-sm text-foreground">{t('agents.kiro.login.openAndConfirm')}</p>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href={login.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              {t('agents.kiro.login.openPage')}
              <ExternalLink className="h-3 w-3" />
            </a>
            <CopyButton value={login.verificationUrl} label={t('agents.kiro.login.copyUrl')} />
          </div>
          <div className="break-all text-xs text-muted-foreground">{login.verificationUrl}</div>

          {login.userCode && (
            <div>
              <div className="text-xs text-muted-foreground">{t('agents.kiro.login.codeLabel')}</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="select-all rounded bg-background px-2 py-1 text-lg font-semibold tracking-widest">
                  {login.userCode}
                </code>
                <CopyButton value={login.userCode} label={t('agents.kiro.login.copyCode')} />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('agents.kiro.login.waiting')}
          </div>
          <Button variant="outline" size="sm" onClick={() => void handleCancel()}>
            {t('agents.kiro.login.cancel')}
          </Button>
        </div>
      )}

      {status === 'succeeded' && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          {t('agents.kiro.login.succeeded')}
        </p>
      )}

      {(error || (status === 'failed' && login?.error)) && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error || login?.error}
        </p>
      )}
    </div>
  );
}
