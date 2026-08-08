import type { Env } from './types';

const encoder = new TextEncoder();

export function id(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return bytesToBase64Url(bytes);
}

export function now(): string { return new Date().toISOString(); }

export function cookies(request: Request): Record<string, string> {
  return Object.fromEntries((request.headers.get('Cookie') ?? '').split(';').flatMap((part) => {
    const index = part.indexOf('=');
    if (index < 1) return [];
    return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
  }));
}

export async function hash(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

export function secureCookies(env: Env): boolean { return env.COOKIE_SECURE !== 'false'; }

export function cookie(name: string, value: string, maxAge: number, env: Env, httpOnly = true): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Strict${httpOnly ? '; HttpOnly' : ''}${secureCookies(env) ? '; Secure' : ''}`;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function text(data: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(data, { ...init, headers });
}

export function withSecurity(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  headers.set('Content-Security-Policy', "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'");
  if (new URL(request.url).protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return result === 0;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function extForMime(mime: string): string | null {
  return ({ 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[mime] ?? null;
}

export function parseRange(header: string | null, size: number): { offset: number; length: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return 'invalid';
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return 'invalid';
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1, end };
}
