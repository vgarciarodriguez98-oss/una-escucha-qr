import qr from 'qrcode-generator';
import type { Env } from './types';
import { cookie, cookies, extForMime, hash, id, now, timingSafeEqual } from './security';

const SESSION_COOKIE = 'one_listen_admin';
const CSRF_COOKIE = 'one_listen_csrf';
const SESSION_SECONDS = 60 * 60 * 8;

type Session = { id: string; csrf_token_hash: string };

function hasMime(file: File, allowed: string[], maximum: number): boolean {
  return allowed.includes(file.type) && file.size > 0 && file.size <= maximum && extForMime(file.type) !== null;
}

export async function login(request: Request, env: Env): Promise<{ response: object; cookies?: string[]; status?: number }> {
  const body = await request.json<{ password?: string }>().catch(() => ({}));
  const subject = await hash(request.headers.get('CF-Connecting-IP') ?? 'unknown', env.ADMIN_RATE_LIMIT_SECRET);
  const windowStart = Math.floor(Date.now() / (10 * 60 * 1000)) * 10 * 60 * 1000;
  await env.DB.prepare(`INSERT INTO admin_login_attempts (id, subject_hash, window_started_at, attempts) VALUES (?, ?, ?, 1)
    ON CONFLICT(subject_hash, window_started_at) DO UPDATE SET attempts = attempts + 1`).bind(id(), subject, windowStart).run();
  const attempt = await env.DB.prepare('SELECT attempts FROM admin_login_attempts WHERE subject_hash = ? AND window_started_at = ?').bind(subject, windowStart).first<{ attempts: number }>();
  if ((attempt?.attempts ?? 99) > 8) return { response: { error: 'Demasiados intentos. Espera unos minutos.' }, status: 429 };
  if (!body.password || !timingSafeEqual(body.password, env.ADMIN_PASSWORD)) return { response: { error: 'Credenciales incorrectas.' }, status: 401 };
  const sessionToken = id(); const csrfToken = id(); const expires = Date.now() + SESSION_SECONDS * 1000;
  await env.DB.prepare('INSERT INTO admin_sessions (id, token_hash, csrf_token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id(), await hash(sessionToken, env.AUTH_SECRET), await hash(csrfToken, env.AUTH_SECRET), expires, now()).run();
  return { response: { csrfToken }, cookies: [cookie(SESSION_COOKIE, sessionToken, SESSION_SECONDS, env), cookie(CSRF_COOKIE, csrfToken, SESSION_SECONDS, env, false)] };
}

export async function authenticated(request: Request, env: Env, requireCsrf = false): Promise<Session | null> {
  const sessionToken = cookies(request)[SESSION_COOKIE];
  if (!sessionToken) return null;
  const session = await env.DB.prepare('SELECT id, csrf_token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1')
    .bind(await hash(sessionToken, env.AUTH_SECRET), Date.now()).first<Session>();
  if (!session) return null;
  if (requireCsrf) {
    const csrf = request.headers.get('X-CSRF-Token');
    const csrfCookie = cookies(request)[CSRF_COOKIE];
    if (!csrf || !csrfCookie || csrf !== csrfCookie || !timingSafeEqual(await hash(csrf, env.AUTH_SECRET), session.csrf_token_hash)) return null;
  }
  return session;
}

export async function dashboard(env: Env): Promise<object> {
  const songs = await env.DB.prepare(`SELECT s.id, s.title, s.audio_mime, s.cover_storage_key IS NOT NULL AS has_cover, s.created_at,
    (SELECT COUNT(*) FROM campaigns c WHERE c.song_id=s.id) campaign_count FROM songs s ORDER BY s.created_at DESC`).all();
  const campaigns = await env.DB.prepare(`SELECT c.id, c.name, c.song_id, c.is_active, c.created_at, s.title,
    (SELECT COUNT(*) FROM plays p WHERE p.campaign_id=c.id) play_count,
    (SELECT MAX(authorized_at) FROM plays p WHERE p.campaign_id=c.id) last_play_at
    FROM campaigns c JOIN songs s ON s.id=c.song_id ORDER BY c.created_at DESC`).all();
  return { songs: songs.results, campaigns: campaigns.results };
}

export async function uploadSong(request: Request, env: Env): Promise<{ id: string; title: string }> {
  const form = await request.formData();
  const title = String(form.get('title') ?? '').trim();
  const audio = form.get('audio'); const cover = form.get('cover');
  const maxAudio = Number(env.MAX_AUDIO_BYTES ?? 31_457_280); const maxCover = Number(env.MAX_COVER_BYTES ?? 5_242_880);
  if (!title || title.length > 160 || !(audio instanceof File) || !hasMime(audio, ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav'], maxAudio)) throw new Error('Datos de canción no válidos.');
  if (cover !== null && !(cover instanceof File)) throw new Error('Portada no válida.');
  if (cover instanceof File && !hasMime(cover, ['image/jpeg', 'image/png', 'image/webp'], maxCover)) throw new Error('Portada no válida.');
  const songId = id(); const audioKey = `audio/${songId}.${extForMime(audio.type)}`;
  const coverKey = cover instanceof File ? `covers/${songId}.${extForMime(cover.type)}` : null;
  await env.AUDIO_BUCKET.put(audioKey, audio.stream(), { httpMetadata: { contentType: audio.type, contentDisposition: 'inline' } });
  try {
    if (cover instanceof File && coverKey) await env.AUDIO_BUCKET.put(coverKey, cover.stream(), { httpMetadata: { contentType: cover.type, contentDisposition: 'inline' } });
    const time = now();
    await env.DB.prepare('INSERT INTO songs (id, title, storage_key, audio_mime, cover_storage_key, cover_mime, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(songId, title, audioKey, audio.type, coverKey, cover instanceof File ? cover.type : null, time, time).run();
  } catch (error) {
    await env.AUDIO_BUCKET.delete(audioKey);
    if (coverKey) await env.AUDIO_BUCKET.delete(coverKey);
    throw error;
  }
  return { id: songId, title };
}

export async function createCampaign(request: Request, env: Env): Promise<void> {
  const body = await request.json<{ name?: string; songId?: string; active?: boolean }>();
  if (!body.name?.trim() || body.name.trim().length > 160 || !body.songId) throw new Error('Campaña no válida.');
  const song = await env.DB.prepare('SELECT id FROM songs WHERE id = ?').bind(body.songId).first();
  if (!song) throw new Error('La canción no existe.');
  const time = now();
  if (body.active) await env.DB.prepare('UPDATE campaigns SET is_active = 0, updated_at = ? WHERE is_active = 1').bind(time).run();
  await env.DB.prepare('INSERT INTO campaigns (id, name, song_id, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id(), body.name.trim(), body.songId, body.active ? 1 : 0, time, time).run();
}

export async function setCampaignActive(campaignId: string, active: boolean, env: Env): Promise<boolean> {
  const time = now();
  const campaign = await env.DB.prepare('SELECT id FROM campaigns WHERE id = ?').bind(campaignId).first();
  if (!campaign) return false;
  if (active) await env.DB.batch([
    env.DB.prepare('UPDATE campaigns SET is_active = 0, updated_at = ? WHERE is_active = 1').bind(time),
    env.DB.prepare('UPDATE campaigns SET is_active = 1, updated_at = ? WHERE id = ?').bind(time, campaignId)
  ]);
  else await env.DB.prepare('UPDATE campaigns SET is_active = 0, updated_at = ? WHERE id = ?').bind(time, campaignId).run();
  return true;
}

export async function resetCampaign(campaignId: string, env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM audio_grants WHERE play_id IN (SELECT id FROM plays WHERE campaign_id = ?)').bind(campaignId),
    env.DB.prepare('DELETE FROM plays WHERE campaign_id = ?').bind(campaignId)
  ]);
}

export async function deleteCampaign(campaignId: string, env: Env): Promise<boolean> {
  const exists = await env.DB.prepare('SELECT id FROM campaigns WHERE id = ?').bind(campaignId).first();
  if (!exists) return false;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM audio_grants WHERE play_id IN (SELECT id FROM plays WHERE campaign_id = ?)').bind(campaignId),
    env.DB.prepare('DELETE FROM plays WHERE campaign_id = ?').bind(campaignId),
    env.DB.prepare('DELETE FROM campaigns WHERE id = ?').bind(campaignId)
  ]);
  return true;
}

export async function deleteSong(songId: string, env: Env): Promise<boolean> {
  const song = await env.DB.prepare('SELECT storage_key, cover_storage_key FROM songs WHERE id = ?').bind(songId).first<{ storage_key: string; cover_storage_key: string | null }>();
  if (!song) return false;
  const linked = await env.DB.prepare('SELECT 1 FROM campaigns WHERE song_id = ? LIMIT 1').bind(songId).first();
  if (linked) throw new Error('No puedes eliminar una canción con campañas.');
  await env.DB.prepare('DELETE FROM songs WHERE id = ?').bind(songId).run();
  await env.AUDIO_BUCKET.delete(song.storage_key); if (song.cover_storage_key) await env.AUDIO_BUCKET.delete(song.cover_storage_key);
  return true;
}

export function qrSvg(url: string): string {
  const code = qr(0, 'M'); code.addData(url); code.make();
  const count = code.getModuleCount(); const margin = 4; const size = count + margin * 2;
  let paths = '';
  for (let row = 0; row < count; row += 1) for (let col = 0; col < count; col += 1) if (code.isDark(row, col)) paths += `M${col + margin} ${row + margin}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR para escuchar"><rect width="100%" height="100%" fill="#fff"/><path fill="#101118" d="${paths}"/></svg>`;
}
