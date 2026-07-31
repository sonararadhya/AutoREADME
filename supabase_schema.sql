-- ============================================================
-- AutoREADME — Database Schema for Supabase PostgreSQL
-- Copy & Run this SQL script in your Supabase SQL Editor
-- ============================================================

-- 1. System Runs Table
CREATE TABLE IF NOT EXISTS runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    repos JSONB DEFAULT '[]'::jsonb,
    triggered_by TEXT DEFAULT 'manual',
    workflow_run_id TEXT DEFAULT 'local',
    files_changed INT DEFAULT 0,
    summary_md TEXT
);

-- 2. Repository Results Table
CREATE TABLE IF NOT EXISTS repo_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID REFERENCES runs(id) ON DELETE CASCADE,
    repo_name TEXT NOT NULL,
    status TEXT NOT NULL,
    branch_name TEXT DEFAULT 'main',
    pr_url TEXT,
    files_changed JSONB DEFAULT '[]'::jsonb,
    error_message TEXT,
    processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Execution Logs Table
CREATE TABLE IF NOT EXISTS run_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID REFERENCES runs(id) ON DELETE CASCADE,
    ts TIMESTAMPTZ DEFAULT NOW(),
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL
);

-- 4. File Hashes Table (Optimizer Cache)
CREATE TABLE IF NOT EXISTS file_hashes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(repo_name, file_path)
);

-- 5. System Configuration Overrides Table
CREATE TABLE IF NOT EXISTS system_config (
    id INT PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default configuration values
INSERT INTO system_config (id, key, value) VALUES
(1, 'MAINTENANCE_MODE', 'false'),
(2, 'DISABLE_BOT', 'false'),
(3, 'GITHUB_ACTIONS_MINUTES', '0'),
(4, 'DASHBOARD_PASSWORD', 'admin123')
ON CONFLICT (key) DO NOTHING;

-- 6. RPC Function for Secure Password Verification
CREATE OR REPLACE FUNCTION verify_dashboard_password(portal_password TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    db_pass TEXT;
BEGIN
    SELECT value INTO db_pass FROM system_config WHERE key = 'DASHBOARD_PASSWORD';
    IF db_pass IS NULL THEN
        db_pass := 'admin123';
    END IF;
    RETURN portal_password = db_pass;
END;
$$;

-- 7. RPC Function for Secure Config Updates
CREATE OR REPLACE FUNCTION update_config_secure(config_key TEXT, config_val TEXT, portal_password TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    db_pass TEXT;
BEGIN
    SELECT value INTO db_pass FROM system_config WHERE key = 'DASHBOARD_PASSWORD';
    IF db_pass IS NULL THEN
        db_pass := 'admin123';
    END IF;

    IF portal_password <> db_pass THEN
        RAISE EXCEPTION 'Unauthorized: Invalid portal password';
    END IF;

    INSERT INTO system_config (id, key, value)
    VALUES (
        COALESCE((SELECT MAX(id) FROM system_config), 0) + 1,
        config_key,
        config_val
    )
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

    RETURN TRUE;
END;
$$;

-- Enable Row Level Security (RLS) & Public Read Policy for Telemetry
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE repo_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_hashes ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public select on runs" ON runs FOR SELECT USING (true);
CREATE POLICY "Allow public select on repo_results" ON repo_results FOR SELECT USING (true);
CREATE POLICY "Allow public select on run_logs" ON run_logs FOR SELECT USING (true);
CREATE POLICY "Allow public select on file_hashes" ON file_hashes FOR SELECT USING (true);
CREATE POLICY "Allow public select on system_config" ON system_config FOR SELECT USING (true);
