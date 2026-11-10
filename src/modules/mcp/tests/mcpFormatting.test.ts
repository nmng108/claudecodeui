import { describe, expect, it } from 'vitest';

import { formatKeyValueLines, parseKeyValueLines } from '@/modules/mcp/utils/mcpFormatting';

describe('parseKeyValueLines', () => {
  it('keeps "=" inside values, trims, and accepts CRLF line endings', () => {
    expect(parseKeyValueLines('A==\r\nB = x y \r\n\r\n# note\nC=')).toEqual({ A: '=', B: 'x y', C: '' });
  });

  it('round-trips what formatKeyValueLines produces', () => {
    const env = { TOKEN: 'a=b==', EMPTY: '' };
    expect(parseKeyValueLines(formatKeyValueLines(env))).toEqual(env);
  });

  it('rejects a line it cannot read instead of silently dropping the variable', () => {
    expect(() => parseKeyValueLines('A=1\nBROKEN')).toThrow('expected KEY=value');
    expect(() => parseKeyValueLines('=value')).toThrow('name before');
  });
});
