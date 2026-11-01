import assert from 'node:assert/strict';
import test from 'node:test';

import { sumKiroCredits, summarizeKiroTranscriptUsage } from '@/modules/providers/list/kiro/kiro-usage.js';

const line = (payload: Record<string, unknown>) => JSON.stringify({ id: 'x', timestamp: '2026-11-01T00:00:00Z', payload });

test('sumKiroCredits adds credit entries and ignores everything else', () => {
  assert.equal(
    sumKiroCredits([
      { unit: 'credit', usage: 0.5 },
      { unit: 'credit', usage: 0.25 },
      { unit: 'token', usage: 100 },
      { unit: 'credit', usage: 'many' },
      null,
    ]),
    0.75,
  );
  assert.equal(sumKiroCredits(undefined), 0);
});

test('summarizeKiroTranscriptUsage totals credits and keeps the latest context share', () => {
  const usage = summarizeKiroTranscriptUsage([
    line({ type: 'user', content: 'hi' }),
    line({ type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: 2 } }),
    line({ type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', usage: 0.1 }] }),
    'not json but mentions usage_summary',
    line({ type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: 3.5 } }),
    line({ type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', usage: 0.2 }] }),
  ]);

  assert.ok(Math.abs(usage.credits - 0.3) < 1e-9);
  assert.equal(usage.contextPercentage, 3.5);
});

test('summarizeKiroTranscriptUsage reports zero credits and no context share for an empty transcript', () => {
  assert.deepEqual(summarizeKiroTranscriptUsage([]), { credits: 0, contextPercentage: null });
});
