-- HandymanCleaners client + request database (Cloudflare D1)
-- Apply locally:  npx wrangler d1 execute handymancleaners --local --file=schema.sql
-- Apply remote:   npx wrangler d1 execute handymancleaners --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,          -- normalized digits; dedupe key
  email TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  service_type TEXT NOT NULL,          -- turnover | recurring | office | handyman | restocking | other
  address TEXT,
  requested_date TEXT,
  details TEXT NOT NULL,               -- JSON of every submitted field
  status TEXT NOT NULL DEFAULT 'new',  -- new -> contacted -> confirmed -> done | declined
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_requests_client ON requests(client_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at);
