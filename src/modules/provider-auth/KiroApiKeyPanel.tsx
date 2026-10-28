import { useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import type { ProviderAuthStatus } from '@/shared/types';

const KIRO_KEY_GENERATION_URL = 'https://app.kiro.dev';

type KiroApiKeySaveResponse = {
  success?: boolean;
  data?: {
    masked?: string | null;
    method?: string | null;
  };
  error?: {
    message?: string;
  };
  message?: string;
};

type KiroApiKeyPanelProps = {
  /** Current auth status for `kiro`, used to show the masked key and method already on file. */
  authStatus: ProviderAuthStatus;
  /** Called after a successful save or clear so the caller can refresh the auth status. */
  onChanged: () => void;
};

/**
 * Rendered by ProviderLoginModal for the `kiro` provider instead of the
 * embedded-shell CLI login every other provider uses: Kiro authenticates with
 * a pasted API key, saved and cleared through
 * `POST`/`DELETE /api/providers/kiro/api-key`. The key is never echoed back by
 * the server, so this panel only ever shows the masked form it returns.
 */
export default function KiroApiKeyPanel({ authStatus, onChanged }: KiroApiKeyPanelProps) {
  const { t } = useTranslation('settings');
  const [apiKey, setApiKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEnvironmentManaged = authStatus.method === 'environment';
  const hasStoredKey = authStatus.authenticated && authStatus.method === 'credentials_file';

  const handleSave = async () => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      return;
    }

    setError(null);
    setIsSaving(true);
    try {
      const response = await api.providers.saveApiKey('kiro', trimmedKey);
      const body = (await response.json()) as KiroApiKeySaveResponse;
      if (!response.ok || !body.success) {
        throw new Error(
          body.error?.message || body.message || t('agents.kiro.apiKey.errors.saveFailed'),
        );
      }

      // Never keep the pasted key in the input or in memory longer than the request.
      setApiKey('');
      onChanged();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : t('agents.kiro.apiKey.errors.saveFailed'),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    setError(null);
    setIsClearing(true);
    try {
      const response = await api.providers.deleteApiKey('kiro');
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as KiroApiKeySaveResponse | null;
        throw new Error(
          body?.error?.message || body?.message || t('agents.kiro.apiKey.errors.clearFailed'),
        );
      }

      onChanged();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : t('agents.kiro.apiKey.errors.clearFailed'),
      );
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div>
        <h3 className="text-base font-medium text-foreground">{t('agents.kiro.apiKey.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('agents.kiro.apiKey.description')}</p>
        <a
          href={KIRO_KEY_GENERATION_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          {t('agents.kiro.apiKey.generateLink')}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      <div className="rounded-lg border border-border bg-muted/40 p-3">
        <div className="text-sm font-medium text-foreground">{t('agents.kiro.apiKey.currentState')}</div>
        <div className="mt-1 text-sm text-muted-foreground">
          {isEnvironmentManaged ? (
            t('agents.kiro.apiKey.managedByEnvironment')
          ) : authStatus.authenticated && authStatus.email ? (
            authStatus.email
          ) : (
            t('agents.kiro.apiKey.noKeyStored')
          )}
        </div>
        {isEnvironmentManaged && (
          <div className="mt-2 text-xs text-muted-foreground">
            {t('agents.kiro.apiKey.environmentKeyCannotBeCleared')}
          </div>
        )}
      </div>

      {!isEnvironmentManaged && (
        <>
          <div className="space-y-2">
            <label htmlFor="kiro-api-key-input" className="text-sm font-medium text-foreground">
              {t('agents.kiro.apiKey.inputLabel')}
            </label>
            <Input
              id="kiro-api-key-input"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t('agents.kiro.apiKey.inputPlaceholder')}
              disabled={isSaving}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void handleSave()}
              disabled={isSaving || !apiKey.trim()}
            >
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('agents.kiro.apiKey.saveButton')}
            </Button>
            {hasStoredKey && (
              <Button
                variant="outline"
                onClick={() => void handleClear()}
                disabled={isClearing}
              >
                {isClearing && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('agents.kiro.apiKey.clearButton')}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
