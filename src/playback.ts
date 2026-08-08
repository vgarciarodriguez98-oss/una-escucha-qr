import type { CampaignRow, Env } from './types';
import { cookie, cookies, hash, id, now } from './security';

const VISITOR_COOKIE = 'one_listen_visitor';
const GRANT_COOKIE = 'one_listen_grant';

export interface Visitor { id: string; token: string; setCookie?: string; }

export async function getVisitor(request: Request, env: Env): Promise<Visitor> {
  const token = cookies(request)[VISITOR_COOKIE] ?? id();
  const tokenHash = await hash(token, env.VISITOR_PEPPER);
  const timestamp = now();
  await env.DB.prepare('INSERT OR IGNORE INTO visitors (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)').bind(id(), tokenHash, timestamp, timestamp).run();
  const visitor = await env.DB.prepare('SELECT id FROM visitors WHERE token_hash = ?').bind(tokenHash).first<{ id: string }>();
  if (!visitor) throw new Error('No se pudo crear el visitante');
  const existing = cookies(request)[VISITOR_COOKIE];
  if (existing) {
    await env.DB.prepare('UPDATE visitors SET last_seen_at = ? WHERE id = ?').bind(timestamp, visitor.id).run();
  }
  return { id: visitor.id, token, setCookie: existing ? undefined : cookie(VISITOR_COOKIE, token, 60 * 60 * 24 * 365 * 2, env) };
}

export async function activeCampaign(env: Env): Promise<CampaignRow | null> {
  return env.DB.prepare(`SELECT c.id campaign_id, c.name campaign_name, s.id song_id, s.title, s.storage_key, s.audio_mime, s.cover_storage_key, s.cover_mime
    FROM campaigns c JOIN songs s ON s.id = c.song_id WHERE c.is_active = 1 LIMIT 1`).first<CampaignRow>();
}

export async function listeningState(request: Request, env: Env): Promise<{ body: object; setCookie?: string }> {
  const visitor = await getVisitor(request, env);
  const campaign = await activeCampaign(env);
  if (!campaign) return { body: { state: 'inactive' }, setCookie: visitor.setCookie };
  const consumed = await env.DB.prepare('SELECT 1 AS found FROM plays WHERE visitor_id = ? AND campaign_id = ? LIMIT 1').bind(visitor.id, campaign.campaign_id).first();
  return {
    body: consumed ? { state: 'used' } : { state: 'available', title: campaign.title, campaign: campaign.campaign_name, hasCover: Boolean(campaign.cover_storage_key) },
    setCookie: visitor.setCookie
  };
}

export async function reservePlayback(request: Request, env: Env): Promise<{ kind: 'ok'; setCookies: string[] } | { kind: 'used' } | { kind: 'inactive' }> {
  const visitor = await getVisitor(request, env);
  const campaign = await activeCampaign(env);
  if (!campaign) return { kind: 'inactive' };
  const playId = id();
  const grantToken = id();
  const grantHash = await hash(grantToken, env.AUTH_SECRET);
  const expiresAt = Date.now() + 2 * 60 * 1000;
  const timestamp = now();
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO plays (id, visitor_id, campaign_id, status, authorized_at)
      SELECT ?, ?, c.id, 'authorized', ? FROM campaigns c WHERE c.id = ? AND c.is_active = 1`).bind(playId, visitor.id, timestamp, campaign.campaign_id),
    env.DB.prepare(`INSERT INTO audio_grants (id, play_id, token_hash, expires_at, created_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM plays WHERE id = ?)`)
      .bind(id(), playId, grantHash, expiresAt, timestamp, playId)
  ]);
  if (results[0].meta.changes !== 1) return { kind: 'used' };
  const value = cookie(GRANT_COOKIE, grantToken, 120, env);
  return { kind: 'ok', setCookies: visitor.setCookie ? [visitor.setCookie, value] : [value] };
}

export async function validateAudio(request: Request, env: Env): Promise<CampaignRow & { play_id: string; grant_id: string; expires_at: number } | null> {
  const allCookies = cookies(request);
  if (!allCookies[GRANT_COOKIE] || !allCookies[VISITOR_COOKIE]) return null;
  const grantHash = await hash(allCookies[GRANT_COOKIE], env.AUTH_SECRET);
  const visitorHash = await hash(allCookies[VISITOR_COOKIE], env.VISITOR_PEPPER);
  const data = await env.DB.prepare(`SELECT p.id play_id, g.id grant_id, g.expires_at, c.id campaign_id, c.name campaign_name, s.id song_id, s.title, s.storage_key, s.audio_mime, s.cover_storage_key, s.cover_mime
    FROM audio_grants g JOIN plays p ON p.id = g.play_id JOIN visitors v ON v.id = p.visitor_id JOIN campaigns c ON c.id = p.campaign_id JOIN songs s ON s.id = c.song_id
    WHERE g.token_hash = ? AND v.token_hash = ? AND g.expires_at > ? LIMIT 1`).bind(grantHash, visitorHash, Date.now()).first<CampaignRow & { play_id: string; grant_id: string; expires_at: number }>();
  return data ?? null;
}

export async function recordAudioStart(playId: string, grantId: string, env: Env): Promise<void> {
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE plays SET status = 'started', started_at = COALESCE(started_at, ?) WHERE id = ?").bind(timestamp, playId),
    env.DB.prepare('UPDATE audio_grants SET first_access_at = COALESCE(first_access_at, ?) WHERE id = ?').bind(timestamp, grantId)
  ]);
}

export async function recordCompleted(request: Request, env: Env): Promise<boolean> {
  const audio = await validateAudio(request, env);
  if (!audio) return false;
  await env.DB.prepare("UPDATE plays SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?").bind(now(), audio.play_id).run();
  return true;
}
