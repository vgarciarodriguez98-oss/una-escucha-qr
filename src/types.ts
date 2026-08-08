export interface Env {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
  VISITOR_PEPPER: string;
  AUTH_SECRET: string;
  ADMIN_RATE_LIMIT_SECRET: string;
  COOKIE_SECURE?: string;
  MAX_AUDIO_BYTES?: string;
  MAX_COVER_BYTES?: string;
}

export interface CampaignRow {
  campaign_id: string;
  campaign_name: string;
  song_id: string;
  title: string;
  storage_key: string;
  audio_mime: string;
  cover_storage_key: string | null;
  cover_mime: string | null;
}
