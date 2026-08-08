import { authenticated, createCampaign, dashboard, deleteCampaign, deleteSong, login, qrSvg, resetCampaign, setCampaignActive, uploadSong } from './admin';
import { activeCampaign, listeningState, recordAudioStart, recordCompleted, reservePlayback, validateAudio } from './playback';
import { json, parseRange, text, withSecurity } from './security';
import { adminPage, listenPage } from './pages';
import type { Env } from './types';

function response(data: unknown, init: ResponseInit = {}, cookies: string[] = []): Response {
  const out = json(data, init);
  for (const value of cookies) out.headers.append('Set-Cookie', value);
  return out;
}

function methodNotAllowed(): Response { return text('Método no permitido', { status: 405 }); }

async function audio(request: Request, env: Env): Promise<Response> {
  const grant = await validateAudio(request, env);
  if (!grant) return text('Autorización de audio no válida o expirada.', { status: 403 });
  const head = await env.AUDIO_BUCKET.head(grant.storage_key);
  if (!head) return text('Audio no disponible.', { status: 404 });
  const range = parseRange(request.headers.get('Range'), head.size);
  if (range === 'invalid') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}`, 'Cache-Control': 'no-store' } });
  const object = await env.AUDIO_BUCKET.get(grant.storage_key, range ? { range: { offset: range.offset, length: range.length } } : undefined);
  if (!object) return text('Audio no disponible.', { status: 404 });
  await recordAudioStart(grant.play_id, grant.grant_id, env);
  const headers = new Headers({
    'Content-Type': grant.audio_mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff'
  });
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.end}/${head.size}`);
    headers.set('Content-Length', String(range.length));
  } else headers.set('Content-Length', String(head.size));
  return new Response(request.method === 'HEAD' ? null : object.body, { status: range ? 206 : 200, headers });
}

async function cover(env: Env): Promise<Response> {
  const campaign = await activeCampaign(env);
  if (!campaign?.cover_storage_key || !campaign.cover_mime) return text('Sin portada', { status: 404 });
  const object = await env.AUDIO_BUCKET.get(campaign.cover_storage_key);
  if (!object) return text('Sin portada', { status: 404 });
  return new Response(object.body, { headers: { 'Content-Type': campaign.cover_mime, 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline' } });
}

async function adminApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/api/admin/login') {
    if (request.method !== 'POST') return methodNotAllowed();
    const result = await login(request, env);
    return response(result.response, { status: result.status ?? 200 }, result.cookies);
  }
  const needsCsrf = !['GET', 'HEAD'].includes(request.method);
  if (!(await authenticated(request, env, needsCsrf))) return response({ error: 'No autorizado.' }, { status: 401 });
  if (url.pathname === '/api/admin/dashboard' && request.method === 'GET') return response(await dashboard(env));
  if (url.pathname === '/api/admin/songs' && request.method === 'POST') return response(await uploadSong(request, env), { status: 201 });
  if (url.pathname === '/api/admin/campaigns' && request.method === 'POST') { await createCampaign(request, env); return response({ ok: true }, { status: 201 }); }
  if (url.pathname === '/api/admin/qr.svg' && request.method === 'GET') {
    const svg = qrSvg(new URL('/escuchar', url).toString());
    return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="una-escucha-qr.svg"' } });
  }
  const active = /^\/api\/admin\/campaigns\/([^/]+)\/active$/.exec(url.pathname);
  if (active && request.method === 'POST') return response({ ok: await setCampaignActive(active[1], (await request.json<{ active?: boolean }>()).active === true, env) });
  const reset = /^\/api\/admin\/campaigns\/([^/]+)\/reset$/.exec(url.pathname);
  if (reset && request.method === 'POST') { await resetCampaign(reset[1], env); return response({ ok: true }); }
  const campaign = /^\/api\/admin\/campaigns\/([^/]+)$/.exec(url.pathname);
  if (campaign && request.method === 'DELETE') return response({ ok: await deleteCampaign(campaign[1], env) });
  const song = /^\/api\/admin\/songs\/([^/]+)$/.exec(url.pathname);
  if (song && request.method === 'DELETE') return response({ ok: await deleteSong(song[1], env) });
  return text('No encontrado', { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      let result: Response;
      if (url.pathname === '/escuchar' && request.method === 'GET') result = new Response(listenPage, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      else if (url.pathname === '/admin' && request.method === 'GET') result = new Response(adminPage, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      else if (url.pathname === '/api/listening-state') {
        if (request.method !== 'GET') result = methodNotAllowed();
        else { const state = await listeningState(request, env); result = response(state.body, {}, state.setCookie ? [state.setCookie] : []); }
      } else if (url.pathname === '/api/listen') {
        if (request.method !== 'POST') result = methodNotAllowed();
        else { const outcome = await reservePlayback(request, env); result = outcome.kind === 'ok' ? response({ state: 'authorized', audioUrl: '/api/audio' }, {}, outcome.setCookies) : response({ state: outcome.kind }, { status: outcome.kind === 'used' ? 409 : 410 }); }
      } else if (url.pathname === '/api/audio') {
        if (!['GET', 'HEAD'].includes(request.method)) result = methodNotAllowed(); else result = await audio(request, env);
      } else if (url.pathname === '/api/listen/completed') {
        if (request.method !== 'POST') result = methodNotAllowed(); else { await recordCompleted(request, env); result = new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }); }
      } else if (url.pathname === '/api/cover' && request.method === 'GET') result = await cover(env);
      else if (url.pathname.startsWith('/api/admin/')) result = await adminApi(request, env, url);
      else if (url.pathname === '/') result = Response.redirect(new URL('/escuchar', url), 302);
      else result = await env.ASSETS.fetch(request);
      return withSecurity(result, request);
    } catch (error) {
      console.error(error);
      const message = error instanceof Error && ['Datos de canción no válidos.', 'Portada no válida.', 'Campaña no válida.', 'La canción no existe.', 'No puedes eliminar una canción con campañas.'].includes(error.message) ? error.message : 'Error interno. Inténtalo de nuevo.';
      return withSecurity(response({ error: message }, { status: 400 }), request);
    }
  }
} satisfies ExportedHandler<Env>;
