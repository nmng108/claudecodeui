import { memo } from 'react';
import { ActivityIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

/** Credits are small fractions, so they keep two decimals instead of the token K/M form. */
const formatCredits = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  return value < 10 ? value.toFixed(2) : value.toFixed(1);
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Rendered by chat's ChatComposer to show the session's context-window usage
 * and open the detailed token breakdown on click.
 */
function TokenUsageSummary({ usage, onClick }: TokenUsageSummaryProps) {
  const { t } = useTranslation();
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;
  // Kiro meters credits, not tokens (`unit: 'credit'`), and reports the context window as a percentage.
  const isCredits = usage?.unit === 'credit';
  const contextPercentage = readUsageNumber(usage?.contextPercentage);
  const formattedUsed = isCredits ? formatCredits(usedTokens) : formatTokenCount(usedTokens);
  const title = isCredits
    ? [
        t('chat:misc.creditsUsed', { value: formattedUsed }),
        contextPercentage > 0 ? t('chat:misc.creditsContext', { percent: contextPercentage.toFixed(1) }) : '',
      ].filter(Boolean).join(' · ')
    : t('chat:misc.tokensUsed', { count: usedTokens });
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={title}
      aria-label={t('chat:misc.showTokenUsage')}
    >
      <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground">{formattedUsed}</span>
      <span className="hidden text-muted-foreground/70 sm:inline">
        {isCredits ? t('chat:misc.creditsLabel') : t('chat:misc.tokensLabel', { count: usedTokens })}
      </span>
    </button>
  );
}

/** Memoized: the composer re-renders on every keystroke and this row's numbers only move when a turn ends. */
export default memo(TokenUsageSummary);
