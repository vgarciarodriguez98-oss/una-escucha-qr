PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  storage_key TEXT NOT NULL UNIQUE,
  audio_mime TEXT NOT NULL,
  cover_storage_key TEXT,
  cover_mime TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS exactly_one_active_campaign
  ON campaigns(is_active) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plays (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('authorized', 'started', 'completed')),
  authorized_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(visitor_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS plays_campaign_authorized_at ON plays(campaign_id, authorized_at DESC);

CREATE TABLE IF NOT EXISTS audio_grants (
  id TEXT PRIMARY KEY,
  play_id TEXT NOT NULL UNIQUE REFERENCES plays(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  first_access_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id TEXT PRIMARY KEY,
  subject_hash TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(subject_hash, window_started_at)
);
