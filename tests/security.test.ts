import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { hash, parseRange, timingSafeEqual } from '../src/security';

describe('primitivas de protección', () => {
  it('crea hashes estables sin exponer el token original', async () => {
    const value = await hash('visitor-token', 'pepper');
    expect(value).not.toContain('visitor-token');
    expect(value).toBe(await hash('visitor-token', 'pepper'));
    expect(value).not.toBe(await hash('visitor-token', 'other-pepper'));
  });

  it('rechaza una cookie/visitor_id manipulado', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('admite Range Requests, incluido rango final de Safari', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ offset: 0, length: 100, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ offset: 900, length: 100, end: 999 });
    expect(parseRange('bytes=-128', 1000)).toEqual({ offset: 872, length: 128, end: 999 });
    expect(parseRange('bytes=1200-1300', 1000)).toBe('invalid');
  });

  it('declara las restricciones UNIQUE definitivas en la migración', () => {
    const schema = readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
    expect(schema).toContain('UNIQUE(visitor_id, campaign_id)');
    expect(schema).toContain('exactly_one_active_campaign');
    expect(schema).toContain('play_id TEXT NOT NULL UNIQUE');
  });
});
