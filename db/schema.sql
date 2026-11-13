CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
CREATE SCHEMA IF NOT EXISTS rh;

CREATE TABLE IF NOT EXISTS rh.recalls (
  recall_id      int PRIMARY KEY,
  recall_number  text,
  recall_date    date,
  title          text,
  description    text,
  url            text,
  product_name   text,
  models         text,
  units          text,
  hazard         text,
  hazard_class   text,
  injuries       text,
  remedy         text,
  retailers      text,
  image_urls     text[],
  is_child       bool DEFAULT false,
  priority       int DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rh.listings (
  listing_id   text PRIMARY KEY,
  recall_id    int REFERENCES rh.recalls,
  run_id       text,
  platform     text,
  url          text,
  title        text,
  description  text,
  price        numeric,
  currency     text,
  seller       text,
  location     text,
  lat          double precision,
  lon          double precision,
  image_url    text,
  first_seen   timestamptz DEFAULT now(),
  embedding    vector(768),
  raw          jsonb
);
CREATE INDEX IF NOT EXISTS listings_recall_idx ON rh.listings(recall_id);
CREATE INDEX IF NOT EXISTS listings_fts_idx ON rh.listings USING gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')));

CREATE TABLE IF NOT EXISTS rh.recall_embeddings (
  recall_id  int REFERENCES rh.recalls,
  image_url  text,
  embedding  vector(768),
  PRIMARY KEY (recall_id, image_url)
);

CREATE TABLE IF NOT EXISTS rh.verdicts (
  listing_id      text PRIMARY KEY REFERENCES rh.listings,
  recall_id       int,
  category        text,
  match_score     real,
  code_in_range   bool,
  remedy_applied  bool,
  confidence      real,
  tier_reached    int,
  label_box       jsonb,
  reason          text,
  final           text,
  evidence_url    text,
  report_text     text,
  latency_ms      int,
  decided_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rh.hunt_runs (
  run_id      text PRIMARY KEY,
  recall_id   int,
  started_at  timestamptz DEFAULT now(),
  finished_at timestamptz,
  status      text,
  stats       jsonb
);

CREATE TABLE IF NOT EXISTS rh.listing_observations (
  observed_at  timestamptz NOT NULL,
  listing_id   text NOT NULL,
  recall_id    int,
  platform     text,
  is_live      bool,
  price        numeric,
  http_status  int
);
SELECT create_hypertable('rh.listing_observations', 'observed_at', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS rh.api_calls (
  called_at   timestamptz NOT NULL DEFAULT now(),
  sponsor     text,
  product     text,
  endpoint    text,
  status      text,
  latency_ms  int,
  records     int,
  cost_usd    numeric,
  sample      jsonb
);
SELECT create_hypertable('rh.api_calls', 'called_at', if_not_exists => TRUE);
