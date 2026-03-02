-- ============================================================
-- Supabase SQL Schema for "USA vs IRAN: The Trenches"
-- Run this in your Supabase SQL Editor
-- ============================================================

-- 1. Accounts table (stores player wallets + stats)
CREATE TABLE IF NOT EXISTS accounts (
  public_key TEXT PRIMARY KEY,
  private_key TEXT NOT NULL,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  kills INTEGER DEFAULT 0,
  deaths INTEGER DEFAULT 0,
  last_active TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for leaderboard queries (sorted by wins, filtered by last_active)
CREATE INDEX IF NOT EXISTS idx_accounts_leaderboard
  ON accounts (last_active DESC, wins DESC, losses ASC, kills DESC);

-- 1b. Add balance column to accounts (for SOL entry fee system)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance NUMERIC(20, 9) DEFAULT 0;

-- 1c. Game transactions table (entry fees + payouts)
CREATE TABLE IF NOT EXISTS game_transactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_key TEXT NOT NULL REFERENCES accounts(public_key),
  room_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('entry_fee', 'payout', 'deposit')),
  amount NUMERIC(20, 9) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_transactions_pubkey
  ON game_transactions (public_key, created_at DESC);

-- 2. Chat messages table (persistent live chat)
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_key TEXT NOT NULL,
  player_name TEXT NOT NULL,
  message TEXT NOT NULL CHECK (char_length(message) <= 200),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fetching recent messages
CREATE INDEX IF NOT EXISTS idx_chat_created
  ON chat_messages (created_at DESC);

-- Auto-delete old chat messages (older than 24h) via pg_cron or manual cleanup
-- You can set up a cron job in Supabase Dashboard > Database > Extensions > pg_cron:
-- SELECT cron.schedule('cleanup-chat', '0 * * * *', $$DELETE FROM chat_messages WHERE created_at < NOW() - INTERVAL '24 hours'$$);

-- 3. Enable Realtime for chat_messages table
-- Go to Supabase Dashboard > Database > Replication and enable the chat_messages table
-- OR run:
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;

-- 4. Row Level Security (RLS)
-- Enable RLS on both tables
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Allow server (service_role) full access, anon can read leaderboard + chat
CREATE POLICY "Service role full access on accounts"
  ON accounts FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon can read accounts for leaderboard"
  ON accounts FOR SELECT
  USING (true);

CREATE POLICY "Service role full access on chat"
  ON chat_messages FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon can read chat messages"
  ON chat_messages FOR SELECT
  USING (true);

CREATE POLICY "Anon can insert chat messages"
  ON chat_messages FOR INSERT
  WITH CHECK (true);

-- 5. RLS for game_transactions
ALTER TABLE game_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on game_transactions"
  ON game_transactions FOR ALL
  USING (true)
  WITH CHECK (true);
