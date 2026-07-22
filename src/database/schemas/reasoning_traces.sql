-- Reasoning Traces Schema
-- Stores AI agent reasoning steps for audit trails and explainability
-- Compatible with SQLite and PostgreSQL

CREATE TABLE IF NOT EXISTS reasoning_traces (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  action TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  confidence REAL,
  reasoning TEXT,
  timestamp DATETIME NOT NULL,
  execution_time INTEGER,
  user_id TEXT,
  metadata TEXT, -- JSON stored as TEXT for SQLite compatibility
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, step_number)
);

-- Index for fast session lookups
CREATE INDEX IF NOT EXISTS idx_reasoning_traces_session_id ON reasoning_traces(session_id);

-- Index for user audit queries
CREATE INDEX IF NOT EXISTS idx_reasoning_traces_user_id ON reasoning_traces(user_id);

-- Index for agent performance analysis
CREATE INDEX IF NOT EXISTS idx_reasoning_traces_agent_name ON reasoning_traces(agent_name);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_reasoning_traces_timestamp ON reasoning_traces(timestamp);

-- AI Sessions table (parent for reasoning traces)
CREATE TABLE IF NOT EXISTS ai_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT,
  workflow_type TEXT,
  started_at DATETIME NOT NULL,
  completed_at DATETIME,
  status TEXT, -- 'running', 'completed', 'failed'
  overall_confidence REAL,
  total_execution_time INTEGER,
  metadata TEXT, -- JSON stored as TEXT
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for session status queries
CREATE INDEX IF NOT EXISTS idx_ai_sessions_status ON ai_sessions(status);

-- Index for user session queries
CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_id ON ai_sessions(user_id);
