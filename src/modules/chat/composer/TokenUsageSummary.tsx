import { memo } from 'react';
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

const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Ring color steps up as the context window fills. */
const ringColorClass = (percent: number) => {
  if (percent >= 90) return 'text-red-500';
  if (percent >= 70) return 'text-amber-500';
  return 'text-primary';
};

/** Circular gauge showing how much of the context window is used. */
function ContextRing({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const dash = (clamped / 100) * RING_CIRCUMFERENCE;
  return (
    <span className="relative grid h-6 w-6 place-items-center" data-testid="context-ring" data-percent={clamped.toFixed(1)}>
      <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90" aria-hidden="true">
        <circle cx="12" cy="12" r={RING_RADIUS} fill="none" strokeWidth="2.5" className="stroke-muted-foreground/20" />
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${RING_CIRCUMFERENCE}`}
          className={`stroke-current ${ringColorClass(clamped)}`}
        />
      </svg>
      <span className="absolute text-[8px] font-semibold leading-none text-foreground">{Math.round(clamped)}</span>
    </span>
  );
}
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
  const totalTokens = readUsageNumber(usage?.total);
  const contextPercentage = readUsageNumber(usage?.contextPercentage);
  const ringPercent = contextPercentage > 0 ? contextPercentage : totalTokens > 0 ? (usedTokens / totalTokens) * 100 : 0;
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
      <ContextRing percent={ringPercent} />
      <span className="font-medium text-foreground">{formattedUsed}</span>
      <span className="hidden text-muted-foreground/70 sm:inline">
        {isCredits ? t('chat:misc.creditsLabel') : t('chat:misc.tokensLabel', { count: usedTokens })}
      </span>
    </button>
  );
}

/** Memoized: the composer re-renders on every keystroke and this row's numbers only move when a turn ends. */
export default memo(TokenUsageSummary);
