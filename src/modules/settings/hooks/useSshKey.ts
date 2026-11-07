import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { SshKeyInfo } from '@/shared/types';

type SshKeyController = {
  key: SshKeyInfo | null;
  isLoading: boolean;
  isGenerating: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Creates the key, or replaces one the app generated earlier when `replace` is set. */
  generate: (options?: { replace?: boolean }) => Promise<boolean>;
};

/** Loads the SSH key git uses over SSH and creates it on request. */
export function useSshKey(): SshKeyController {
  const [key, setKey] = useState<SshKeyInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    try {
      const body = await readApiJson<{ data: SshKeyInfo }>(await api.sshKeys.get());
      setKey(body.data);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const generate = useCallback(async (options: { replace?: boolean } = {}) => {
    setIsGenerating(true);
    setError(null);
    try {
      const body = await readApiJson<{ data: SshKeyInfo }>(await api.sshKeys.generate(options));
      setKey(body.data);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setIsGenerating(false);
    }
  }, []);

  return { key, isLoading, isGenerating, error, reload, generate };
}