-- v2: recall index for fast matching, match cache, B2B sellers/cases
CREATE TABLE IF NOT EXISTS rh.recall_index (
  recall_id     int PRIMARY KEY REFERENCES rh.recalls,
  brand         text,
  norm_name     text,            -- normalized product name, lowercase
  category      text,            -- short category, e.g. "nursing pillow", "french press"
  models        text[],          -- model numbers / SKUs (uppercased, stripped)
  upcs          text[],
  keywords      text,            -- brand + name + models + category, for BM25
  text_emb      vector(768),
  img_emb       vector(768),
  built_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recall_index_text_emb ON rh.recall_index USING diskann (text_emb vector_cosine_ops);
CREATE INDEX IF NOT EXISTS recall_index_kw_bm25 ON rh.recall_index USING bm25(keywords) WITH (text_config='english');

CREATE TABLE IF NOT EXISTS rh.product_verdicts (
  site         text NOT NULL,
  product_id   text NOT NULL,
  status       text NOT NULL,   -- clean | possible | recalled
  recall_id    int,
  confidence   real,
  reason       text,
  stage        int,             -- 1 = Tiger-only filter, 2 = Gemini confirm, 3 = Gemini vision
  title        text,
  checked_at   timestamptz DEFAULT now(),
  PRIMARY KEY (site, product_id)
);

CREATE TABLE IF NOT EXISTS rh.match_requests (
  at          timestamptz NOT NULL DEFAULT now(),
  site        text,
  n_products  int,
  n_flagged   int,
  latency_ms  int,
  cache_hits  int
);
SELECT create_hypertable('rh.match_requests', 'at', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS rh.sellers (
  seller_id        text PRIMARY KEY,   -- platform:seller
  platform         text,
  name             text,
  profile_url      text,
  first_seen       timestamptz DEFAULT now(),
  listings_count   int DEFAULT 0,
  confirmed_count  int DEFAULT 0,
  likely_count     int DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rh.cases (
  case_id      text PRIMARY KEY,
  listing_id   text UNIQUE REFERENCES rh.listings,
  seller_id    text REFERENCES rh.sellers,
  recall_id    int REFERENCES rh.recalls,
  platform     text,
  status       text NOT NULL DEFAULT 'open',  -- open | notified | removed | verified | dismissed
  severity     text,                           -- CONFIRMED | LIKELY
  opened_at    timestamptz DEFAULT now(),
  notified_at  timestamptz,
  removed_at   timestamptz,
  verified_at  timestamptz,
  assignee     text,
  notice_text  text,
  notes        text
);

CREATE TABLE IF NOT EXISTS rh.case_events (
  at       timestamptz NOT NULL DEFAULT now(),
  case_id  text NOT NULL,
  type     text,     -- opened | notice_drafted | notified | verify_live | verify_gone | removed | dismissed | note
  actor    text,
  payload  jsonb
);
SELECT create_hypertable('rh.case_events', 'at', if_not_exists => TRUE);
