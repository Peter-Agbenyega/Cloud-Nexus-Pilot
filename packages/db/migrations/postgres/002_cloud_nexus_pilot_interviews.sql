CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  default_interview_mode TEXT NOT NULL DEFAULT 'general',
  retain_transcripts BOOLEAN NOT NULL DEFAULT true,
  retain_screen_context BOOLEAN NOT NULL DEFAULT false,
  allow_screen_context BOOLEAN NOT NULL DEFAULT false,
  guidance_density TEXT NOT NULL DEFAULT 'concise',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS resumes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  title TEXT NOT NULL DEFAULT 'Resume',
  source_filename TEXT,
  raw_text TEXT NOT NULL DEFAULT '',
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_descriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  title TEXT NOT NULL DEFAULT 'Job description',
  company_name TEXT,
  raw_text TEXT NOT NULL DEFAULT '',
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interview_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  resume_id UUID REFERENCES resumes(id) ON DELETE SET NULL,
  job_description_id UUID REFERENCES job_descriptions(id) ON DELETE SET NULL,
  mode TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended', 'failed')),
  title TEXT NOT NULL DEFAULT 'Interview session',
  company_context TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  interview_session_id UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('microphone', 'system-audio', 'screen', 'manual')),
  speaker_id TEXT,
  text TEXT NOT NULL,
  is_partial BOOLEAN NOT NULL DEFAULT false,
  client_event_id TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(interview_session_id, client_event_id)
);

CREATE TABLE IF NOT EXISTS detected_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  interview_session_id UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  transcript_segment_id UUID REFERENCES transcript_segments(id) ON DELETE SET NULL,
  raw_text TEXT NOT NULL,
  normalized_question TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT,
  confidence NUMERIC(4,3) NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'normal',
  requires_visual_context BOOLEAN NOT NULL DEFAULT false,
  requires_resume_context BOOLEAN NOT NULL DEFAULT false,
  requires_code_context BOOLEAN NOT NULL DEFAULT false,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS screen_context_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  interview_session_id UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  extracted_text TEXT NOT NULL DEFAULT '',
  detected_language TEXT,
  error_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  code_snippet TEXT,
  infrastructure_resources JSONB NOT NULL DEFAULT '[]'::jsonb,
  diagram_summary TEXT,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  retain_screenshot BOOLEAN NOT NULL DEFAULT false,
  screenshot_storage_key TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guidance_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  interview_session_id UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  detected_question_id UUID REFERENCES detected_questions(id) ON DELETE SET NULL,
  headline TEXT NOT NULL,
  speak_now TEXT NOT NULL,
  key_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  example TEXT,
  technical_detail TEXT,
  caution TEXT,
  follow_up TEXT,
  provider TEXT,
  model TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interview_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  interview_session_id UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  question_list JSONB NOT NULL DEFAULT '[]'::jsonb,
  category_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  strong_answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  weak_answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  missed_technical_concepts JSONB NOT NULL DEFAULT '[]'::jsonb,
  communication_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_better_answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  likely_follow_up_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  study_recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  overall_score NUMERIC(4,2),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resumes_user_updated ON resumes(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_descriptions_user_updated ON job_descriptions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_interview_sessions_user_updated ON interview_sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_session_time ON transcript_segments(interview_session_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_detected_questions_session_time ON detected_questions(interview_session_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_guidance_items_session_time ON guidance_items(interview_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_screen_context_events_session_time ON screen_context_events(interview_session_id, captured_at);

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_descriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE detected_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE screen_context_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE guidance_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own preferences" ON user_preferences;
CREATE POLICY "Users manage own preferences" ON user_preferences
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users manage own resumes" ON resumes;
CREATE POLICY "Users manage own resumes" ON resumes
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users manage own job descriptions" ON job_descriptions;
CREATE POLICY "Users manage own job descriptions" ON job_descriptions
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users manage own interview sessions" ON interview_sessions;
CREATE POLICY "Users manage own interview sessions" ON interview_sessions
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users manage own transcript segments" ON transcript_segments;
CREATE POLICY "Users manage own transcript segments" ON transcript_segments
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users manage own detected questions" ON detected_questions;
CREATE POLICY "Users manage own detected questions" ON detected_questions
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users manage own screen context events" ON screen_context_events;
CREATE POLICY "Users manage own screen context events" ON screen_context_events
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users manage own guidance items" ON guidance_items;
CREATE POLICY "Users manage own guidance items" ON guidance_items
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users manage own interview reports" ON interview_reports;
CREATE POLICY "Users manage own interview reports" ON interview_reports
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
