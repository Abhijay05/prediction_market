-- infra/seed/seed.sql
-- Run automatically by docker-compose on first Postgres start

-- ── Users ─────────────────────────────────────────────────────────────────────
INSERT INTO users (id, wallet_address, ens_name, nonce, created_at, updated_at) VALUES
  ('u1', '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 'alice.eth',   gen_random_uuid()::text, NOW(), NOW()),
  ('u2', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', 'bob.eth',     gen_random_uuid()::text, NOW(), NOW()),
  ('u3', '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',  NULL,          gen_random_uuid()::text, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- ── Markets ───────────────────────────────────────────────────────────────────
INSERT INTO markets (
  id, contract_address, router_address, chain_id,
  question, description, category,
  collateral_token, initial_liquidity,
  yes_reserve, no_reserve, total_volume, total_liquidity,
  created_at_block, expires_at, status, creator_id, created_at, updated_at
) VALUES
  (
    'm1', '0xmarket0000000000000000000000000000000001',
    '0xrouter000000000000000000000000000000001', 11155111,
    'Will ETH price exceed $5000 before January 1, 2026?',
    'Resolves YES if ETH/USD spot price on Coinbase exceeds $5000 at any point before 2026-01-01 00:00 UTC.',
    'crypto',
    '0xcollateral00000000000000000000000000000001',
    '1000000000000000000000',
    '600000000000000000000',
    '400000000000000000000',
    '250000000000000000000',
    '1000000000000000000000',
    5000000, '2026-01-01 00:00:00+00', 'ACTIVE', 'u1', NOW() - INTERVAL '7 days', NOW()
  ),
  (
    'm2', '0xmarket0000000000000000000000000000000002',
    '0xrouter000000000000000000000000000000001', 11155111,
    'Will the Fed cut rates in Q3 2025?',
    'Resolves YES if the Federal Reserve announces a rate cut at any FOMC meeting in Q3 2025.',
    'macro',
    '0xcollateral00000000000000000000000000000001',
    '500000000000000000000',
    '450000000000000000000',
    '550000000000000000000',
    '80000000000000000000',
    '500000000000000000000',
    5000100, '2025-09-30 00:00:00+00', 'ACTIVE', 'u2', NOW() - INTERVAL '3 days', NOW()
  ),
  (
    'm3', '0xmarket0000000000000000000000000000000003',
    '0xrouter000000000000000000000000000000001', 11155111,
    'Will Bitcoin reach a new all-time high in 2025?',
    'Resolves YES if BTC/USD on any major exchange sets a new all-time high above $73,750 before 2025-12-31.',
    'crypto',
    '0xcollateral00000000000000000000000000000001',
    '2000000000000000000000',
    '1400000000000000000000',
    '600000000000000000000',
    '500000000000000000000',
    '2000000000000000000000',
    5000200, '2025-12-31 00:00:00+00', 'ACTIVE', 'u1', NOW() - INTERVAL '14 days', NOW()
  )
ON CONFLICT DO NOTHING;

-- ── Positions ─────────────────────────────────────────────────────────────────
INSERT INTO positions (
  id, user_id, market_id,
  yes_tokens, no_tokens,
  total_spent, total_received, realized_pnl,
  created_at, updated_at
) VALUES
  ('p1', 'u1', 'm1', '100000000000000000000', '0', '60000000000000000000', '0', '0', NOW(), NOW()),
  ('p2', 'u2', 'm1', '0', '150000000000000000000', '90000000000000000000', '0', '0', NOW(), NOW()),
  ('p3', 'u1', 'm3', '200000000000000000000', '0', '140000000000000000000', '0', '0', NOW(), NOW()),
  ('p4', 'u3', 'm2', '50000000000000000000', '80000000000000000000', '70000000000000000000', '0', '0', NOW(), NOW())
ON CONFLICT DO NOTHING;

-- ── Trades ────────────────────────────────────────────────────────────────────
INSERT INTO trades (
  id, tx_hash, block_number, log_index, chain_id,
  direction, outcome, collateral_in, token_amount, avg_price, fee_amount,
  yes_price_before, no_price_before, yes_price_after, no_price_after, price_impact,
  market_id, trader_id, created_at
) VALUES
  (
    't1', '0xtx0000000000000000000000000000000000000000000000000000000000001', 5000001, 0, 11155111,
    'BUY', 'YES', '60000000000000000000', '100000000000000000000', '0.6', '300000000000000000',
    '0.5', '0.5', '0.6', '0.4', '0.02',
    'm1', 'u1', NOW() - INTERVAL '6 days'
  ),
  (
    't2', '0xtx0000000000000000000000000000000000000000000000000000000000002', 5000050, 0, 11155111,
    'BUY', 'NO', '90000000000000000000', '150000000000000000000', '0.4', '450000000000000000',
    '0.6', '0.4', '0.55', '0.45', '0.015',
    'm1', 'u2', NOW() - INTERVAL '5 days'
  ),
  (
    't3', '0xtx0000000000000000000000000000000000000000000000000000000000003', 5000100, 0, 11155111,
    'BUY', 'YES', '140000000000000000000', '200000000000000000000', '0.7', '700000000000000000',
    '0.55', '0.45', '0.65', '0.35', '0.018',
    'm3', 'u1', NOW() - INTERVAL '13 days'
  ),
  (
    't4', '0xtx0000000000000000000000000000000000000000000000000000000000004', 5000150, 0, 11155111,
    'BUY', 'YES', '35000000000000000000', '50000000000000000000', '0.45', '175000000000000000',
    '0.5', '0.5', '0.45', '0.55', '0.01',
    'm2', 'u3', NOW() - INTERVAL '2 days'
  ),
  (
    't5', '0xtx0000000000000000000000000000000000000000000000000000000000005', 5000200, 0, 11155111,
    'BUY', 'NO', '35000000000000000000', '80000000000000000000', '0.55', '175000000000000000',
    '0.45', '0.55', '0.42', '0.58', '0.008',
    'm2', 'u3', NOW() - INTERVAL '1 day'
  )
ON CONFLICT DO NOTHING;

-- ── Price snapshots (1m buckets for chart rendering) ──────────────────────────
INSERT INTO price_snapshots (
  id, market_id, interval_secs, bucket_start,
  yes_open, yes_high, yes_low, yes_close,
  volume, start_block, end_block, trade_count
)
SELECT
  gen_random_uuid()::text,
  'm1',
  60,
  NOW() - (n || ' minutes')::interval,
  0.5 + (random() * 0.2 - 0.1),
  0.5 + (random() * 0.25),
  0.5 - (random() * 0.1),
  0.5 + (random() * 0.2 - 0.05),
  (random() * 1000 * 1e18)::numeric,
  5000000 + n,
  5000000 + n,
  floor(random() * 5 + 1)::int
FROM generate_series(1, 120) AS n
ON CONFLICT DO NOTHING;