import { describe, expect, it } from 'vitest';
import { listeningState, reservePlayback } from '../src/playback';
import type { Env } from '../src/types';

type Query = { sql: string; values: unknown[] };
class MemoryD1 {
  visitors = new Map<string, { id: string; token: string }>();
  plays = new Map<string, { visitorId: string; campaignId: string }>();
  campaign: { campaign_id: string; campaign_name: string; song_id: string; title: string; storage_key: string; audio_mime: string; cover_storage_key: null; cover_mime: null } | null = { campaign_id: 'campaign-1', campaign_name: 'Verano', song_id: 'song-1', title: 'Una canción', storage_key: 'audio/secret.mp3', audio_mime: 'audio/mpeg', cover_storage_key: null, cover_mime: null };
  prepare(sql: string) { const query: Query = { sql, values: [] }; return { bind: (...values: unknown[]) => { query.values = values; return this.statement(query); }, ...this.statement(query) }; }
  statement(query: Query) { return { run: async () => this.execute(query), first: async <T>() => this.first<T>(query), all: async () => ({ results: [] }) }; }
  async batch(statements: unknown[]) { return Promise.all((statements as { run: () => Promise<{ meta: { changes: number } }> }[]).map(statement => statement.run())); }
  async execute(query: Query) {
    if (query.sql.includes('INSERT OR IGNORE INTO visitors')) { const [, token] = query.values as [string, string]; if (!this.visitors.has(token)) this.visitors.set(token, { id: String(query.values[0]), token }); return { meta: { changes: 1 } }; }
    if (query.sql.includes('UPDATE visitors')) return { meta: { changes: 1 } };
    if (query.sql.includes('INSERT OR IGNORE INTO plays')) { const [, visitorId, , campaignId] = query.values as [string, string, string, string]; const key = `${visitorId}:${campaignId}`; if (this.plays.has(key)) return { meta: { changes: 0 } }; this.plays.set(key, { visitorId, campaignId }); return { meta: { changes: 1 } }; }
    if (query.sql.includes('INSERT INTO audio_grants')) return { meta: { changes: 1 } };
    return { meta: { changes: 0 } };
  }
  async first<T>(query: Query): Promise<T | null> {
    if (query.sql.includes('SELECT id FROM visitors')) return (this.visitors.get(String(query.values[0])) ?? null) as T | null;
    if (query.sql.includes('FROM campaigns c JOIN songs')) return this.campaign as T | null;
    if (query.sql.includes('SELECT 1 AS found FROM plays')) return [...this.plays.values()].some(play => play.visitorId === query.values[0] && play.campaignId === query.values[1]) ? ({ found: 1 } as T) : null;
    return null;
  }
}

function environment(db: MemoryD1): Env { return { DB: db as unknown as D1Database, AUDIO_BUCKET: {} as R2Bucket, ASSETS: {} as Fetcher, ADMIN_PASSWORD: 'test', VISITOR_PEPPER: 'visitor-pepper', AUTH_SECRET: 'grant-secret', ADMIN_RATE_LIMIT_SECRET: 'rate-secret', COOKIE_SECURE: 'false' }; }
const request = (cookie = '') => new Request('http://local/api/listen', { headers: cookie ? { Cookie: cookie } : {} });

describe('consumo atómico de escuchas', () => {
  it('un visitante nuevo recibe cookie y puede empezar una vez', async () => {
    const db = new MemoryD1(); const env = environment(db); const initial = await listeningState(request(), env);
    expect(initial.body).toMatchObject({ state: 'available', title: 'Una canción' }); expect(initial.setCookie).toContain('HttpOnly');
    const result = await reservePlayback(request(initial.setCookie!.split(';')[0]), env);
    expect(result.kind).toBe('ok');
  });

  it('cookie existente mantiene la identidad y tras recarga muestra usada', async () => {
    const db = new MemoryD1(); const env = environment(db); const first = await listeningState(request(), env); const cookie = first.setCookie!.split(';')[0];
    await reservePlayback(request(cookie), env);
    expect((await listeningState(request(cookie), env)).body).toEqual({ state: 'used' });
  });

  it('campaña desactivada no concede reproducción', async () => {
    const db = new MemoryD1(); db.campaign = null; const env = environment(db);
    expect((await listeningState(request(), env)).body).toEqual({ state: 'inactive' });
    expect(await reservePlayback(request(), env)).toEqual({ kind: 'inactive' });
  });

  it('20 pestañas/peticiones simultáneas producen exactamente una autorización', async () => {
    const db = new MemoryD1(); const env = environment(db); const initial = await listeningState(request(), env); const cookie = initial.setCookie!.split(';')[0];
    const results = await Promise.all(Array.from({ length: 20 }, () => reservePlayback(request(cookie), env)));
    expect(results.filter(result => result.kind === 'ok')).toHaveLength(1);
    expect(results.filter(result => result.kind === 'used')).toHaveLength(19);
    expect(db.plays.size).toBe(1);
  });
});
