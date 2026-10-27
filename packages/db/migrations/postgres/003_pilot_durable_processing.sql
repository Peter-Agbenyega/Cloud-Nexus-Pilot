-- Additive Pilot state and quota boundary for PostgreSQL 17 + GoTrue/PostgREST.
-- Prerequisites: migration 002, auth.uid(), anon/authenticated/service_role.
-- No allowance is created automatically. A privileged operator grants a bounded
-- allowance; browsers cannot grant quota or certify provider completion.
BEGIN;

ALTER TABLE public.interview_sessions
  ADD COLUMN IF NOT EXISTS pilot_consent_version text,
  ADD COLUMN IF NOT EXISTS pilot_expires_at timestamptz;
ALTER TABLE public.transcript_segments
  ADD COLUMN IF NOT EXISTS pilot_sequence bigserial,
  ADD COLUMN IF NOT EXISTS provider_result jsonb;
GRANT USAGE, SELECT ON SEQUENCE public.transcript_segments_pilot_sequence_seq TO authenticated;
CREATE UNIQUE INDEX IF NOT EXISTS pilot_transcript_sequence_unique
  ON public.transcript_segments (pilot_sequence);

CREATE TABLE IF NOT EXISTS public.pilot_usage_accounts (
  owner_id uuid PRIMARY KEY,
  granted_units bigint NOT NULL DEFAULT 0 CHECK (granted_units >= 0),
  consumed_units bigint NOT NULL DEFAULT 0 CHECK (consumed_units >= 0),
  reserved_units bigint NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  max_concurrency integer NOT NULL DEFAULT 2 CHECK (max_concurrency BETWEEN 1 AND 8),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (consumed_units + reserved_units <= granted_units)
);
CREATE TABLE IF NOT EXISTS public.pilot_processing_operations (
  owner_id uuid NOT NULL REFERENCES public.pilot_usage_accounts(owner_id),
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  session_id uuid REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('transcription', 'guidance')),
  state text NOT NULL CHECK (state IN ('reserved', 'succeeded', 'failed', 'unknown')),
  reserved_units integer NOT NULL CHECK (reserved_units BETWEEN 1 AND 2000000),
  used_units integer CHECK (used_units >= 0 AND used_units <= reserved_units),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '90 seconds',
  completed_at timestamptz,
  PRIMARY KEY (owner_id, operation_id)
);
CREATE INDEX IF NOT EXISTS pilot_operations_session_idx
  ON public.pilot_processing_operations (session_id, created_at);
ALTER TABLE public.pilot_usage_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pilot_processing_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pilot_usage_own_read ON public.pilot_usage_accounts;
CREATE POLICY pilot_usage_own_read ON public.pilot_usage_accounts FOR SELECT TO authenticated
  USING (owner_id = auth.uid());
DROP POLICY IF EXISTS pilot_operations_own_read ON public.pilot_processing_operations;
CREATE POLICY pilot_operations_own_read ON public.pilot_processing_operations FOR SELECT TO authenticated
  USING (owner_id = auth.uid());
REVOKE ALL ON public.pilot_usage_accounts, public.pilot_processing_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.pilot_usage_accounts, public.pilot_processing_operations TO authenticated;

-- Existing 002 policies check row.user_id; additionally bind child rows to
-- an actually owned parent session, including writes through direct PostgREST.
DO $policy$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['transcript_segments','detected_questions','screen_context_events','guidance_items','interview_reports'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS pilot_owned_parent ON public.%I', relation_name);
    EXECUTE format('CREATE POLICY pilot_owned_parent ON public.%1$I AS RESTRICTIVE FOR ALL TO authenticated USING (user_id = auth.uid() AND EXISTS (SELECT 1 FROM public.interview_sessions s WHERE s.id = %1$I.interview_session_id AND s.user_id = auth.uid())) WITH CHECK (user_id = auth.uid() AND EXISTS (SELECT 1 FROM public.interview_sessions s WHERE s.id = %1$I.interview_session_id AND s.user_id = auth.uid()))', relation_name);
  END LOOP;
END $policy$;

-- RLS does not constrain TRUNCATE. Preserve existing client DML while
-- removing administrative grants that can bypass row ownership.
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.user_preferences,public.transcript_records,
  public.resumes,public.job_descriptions,public.interview_sessions,public.transcript_segments,
  public.detected_questions,public.screen_context_events,public.guidance_items,public.interview_reports
  FROM PUBLIC,anon,authenticated;

-- Caller-supplied browser metadata is never a server-certified final event.
-- A SECURITY DEFINER completion RPC runs as its trusted migration owner; direct
-- PostgREST client DML runs as authenticated and cannot forge certification.
CREATE OR REPLACE FUNCTION public.pilot_guard_transcript_event()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.pilot_sequence := nextval('public.transcript_segments_pilot_sequence_seq'::regclass);
      NEW.provider_result := NULL;
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD.provider_result IS NOT NULL OR NEW.pilot_sequence IS DISTINCT FROM OLD.pilot_sequence OR
         NEW.provider_result IS DISTINCT FROM OLD.provider_result THEN
        RAISE EXCEPTION 'certified_event_immutable' USING ERRCODE='42501';
      END IF;
    ELSIF OLD.provider_result IS NOT NULL THEN
      RAISE EXCEPTION 'certified_event_immutable' USING ERRCODE='42501';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pilot_guard_transcript_event ON public.transcript_segments;
CREATE TRIGGER pilot_guard_transcript_event BEFORE INSERT OR UPDATE OR DELETE ON public.transcript_segments
  FOR EACH ROW EXECUTE FUNCTION public.pilot_guard_transcript_event();

CREATE OR REPLACE FUNCTION public.pilot_guard_session_metadata()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF TG_OP='INSERT' THEN
      NEW.pilot_expires_at := NULL; NEW.pilot_consent_version := NULL;
    ELSIF NEW.pilot_expires_at IS DISTINCT FROM OLD.pilot_expires_at OR
          NEW.pilot_consent_version IS DISTINCT FROM OLD.pilot_consent_version OR
          (OLD.pilot_expires_at IS NOT NULL AND (NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.started_at IS DISTINCT FROM OLD.started_at)) THEN
      RAISE EXCEPTION 'processing_session_metadata_immutable' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pilot_guard_session_metadata ON public.interview_sessions;
CREATE TRIGGER pilot_guard_session_metadata BEFORE INSERT OR UPDATE ON public.interview_sessions
  FOR EACH ROW EXECUTE FUNCTION public.pilot_guard_session_metadata();
REVOKE ALL ON FUNCTION public.pilot_guard_transcript_event(),public.pilot_guard_session_metadata() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.pilot_create_session(
  p_session_id uuid, p_mode text, p_consent_version text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner uuid := auth.uid(); v_row public.interview_sessions%ROWTYPE;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  IF p_session_id IS NULL OR p_mode IS NULL OR p_mode NOT IN ('general', 'mock', 'meeting', 'interview') OR
     p_consent_version IS NULL OR length(p_consent_version) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_session_input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.interview_sessions WHERE id = p_session_id AND user_id = v_owner;
  IF FOUND THEN RETURN to_jsonb(v_row); END IF;
  IF (SELECT count(*) FROM public.interview_sessions WHERE user_id = v_owner) >= 100 THEN
    RAISE EXCEPTION 'session_limit_reached' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.interview_sessions(id, user_id, mode, status, started_at, pilot_consent_version, pilot_expires_at)
  VALUES(p_session_id, v_owner, p_mode, 'active', now(), p_consent_version, now() + interval '30 minutes')
  ON CONFLICT (id) DO NOTHING;
  SELECT * INTO v_row FROM public.interview_sessions WHERE id = p_session_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_unavailable' USING ERRCODE = '42501'; END IF;
  RETURN to_jsonb(v_row);
END $$;

CREATE OR REPLACE FUNCTION public.pilot_read_session(p_session_id uuid, p_after_sequence bigint DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner uuid := auth.uid(); v_session jsonb; v_events jsonb; v_guidance jsonb;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  SELECT to_jsonb(s) INTO v_session FROM public.interview_sessions s WHERE id = p_session_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_unavailable' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.pilot_sequence), '[]'::jsonb) INTO v_events
  FROM (SELECT id, client_event_id, pilot_sequence, source, text, captured_at, provider_result
        FROM public.transcript_segments WHERE interview_session_id = p_session_id AND user_id = v_owner
        AND pilot_sequence > greatest(p_after_sequence, 0) ORDER BY pilot_sequence LIMIT 1000) e;
  SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.created_at), '[]'::jsonb) INTO v_guidance
  FROM (SELECT operation_id, state, result, created_at FROM public.pilot_processing_operations
        WHERE session_id = p_session_id AND owner_id = v_owner AND kind = 'guidance'
        ORDER BY created_at DESC LIMIT 500) g;
  RETURN jsonb_build_object('session', v_session, 'events', v_events, 'guidance', v_guidance);
END $$;

CREATE OR REPLACE FUNCTION public.pilot_stop_session(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner uuid := auth.uid(); v_row public.interview_sessions%ROWTYPE; v_account public.pilot_usage_accounts%ROWTYPE;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_account FROM public.pilot_usage_accounts WHERE owner_id=v_owner FOR UPDATE;
  UPDATE public.interview_sessions SET status = 'ended', ended_at = coalesce(ended_at, now()), updated_at = now()
    WHERE id = p_session_id AND user_id = v_owner RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_unavailable' USING ERRCODE = '42501'; END IF;
  WITH closing AS (
    UPDATE public.pilot_processing_operations SET state='unknown',used_units=reserved_units,completed_at=now(),
      result=jsonb_build_object('error',jsonb_build_object('code','processing_stopped'))
    WHERE owner_id=v_owner AND session_id=p_session_id AND state='reserved' RETURNING reserved_units
  ) UPDATE public.pilot_usage_accounts SET consumed_units=consumed_units+coalesce((SELECT sum(reserved_units) FROM closing),0),
    reserved_units=reserved_units-coalesce((SELECT sum(reserved_units) FROM closing),0),updated_at=now() WHERE owner_id=v_owner;
  RETURN to_jsonb(v_row);
END $$;

CREATE OR REPLACE FUNCTION public.pilot_delete_session(p_session_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner uuid := auth.uid(); v_account public.pilot_usage_accounts%ROWTYPE;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  -- A reservation may already have reached a provider. Never return its budget
  -- merely because the session was deleted: conservatively charge its bound.
  SELECT * INTO v_account FROM public.pilot_usage_accounts WHERE owner_id = v_owner FOR UPDATE;
  WITH closing AS (
    UPDATE public.pilot_processing_operations SET state = 'unknown', used_units = reserved_units, completed_at = now()
    WHERE owner_id = v_owner AND session_id = p_session_id AND state = 'reserved' RETURNING reserved_units
  ) UPDATE public.pilot_usage_accounts SET consumed_units = consumed_units + coalesce((SELECT sum(reserved_units) FROM closing),0),
    reserved_units = reserved_units - coalesce((SELECT sum(reserved_units) FROM closing),0), updated_at = now() WHERE owner_id = v_owner;
  DELETE FROM public.interview_sessions WHERE id = p_session_id AND user_id = v_owner;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.pilot_reserve_operation(
  p_session_id uuid, p_operation_id text, p_max_units integer, p_request_hash text, p_kind text DEFAULT 'transcription'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_owner uuid := auth.uid(); v_account public.pilot_usage_accounts%ROWTYPE;
  v_existing public.pilot_processing_operations%ROWTYPE; v_expired bigint; v_count integer;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'; END IF;
  IF p_operation_id IS NULL OR length(p_operation_id) NOT BETWEEN 1 AND 128 OR
     p_max_units IS NULL OR p_max_units NOT BETWEEN 1 AND 2000000 OR
     p_request_hash IS NULL OR p_request_hash !~ '^[a-f0-9]{64}$' OR
     p_kind IS NULL OR p_kind NOT IN ('transcription', 'guidance') THEN
    RAISE EXCEPTION 'invalid_operation_input' USING ERRCODE = '22023';
  END IF;
  IF p_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.interview_sessions WHERE id = p_session_id AND user_id = v_owner
  ) THEN RAISE EXCEPTION 'session_unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_account FROM public.pilot_usage_accounts WHERE owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('acquired',false,'state','quota_exhausted'); END IF;
  -- Lost/expired requests have unknown provider outcomes. Charge their bound,
  -- retain their operation ID, and never dispatch the same operation again.
  WITH expired AS (
    UPDATE public.pilot_processing_operations SET state='unknown', used_units=reserved_units, completed_at=now(),
      result=jsonb_build_object('error',jsonb_build_object('code','processing_outcome_unknown'))
    WHERE owner_id=v_owner AND state='reserved' AND expires_at <= now() RETURNING reserved_units
  ) SELECT coalesce(sum(reserved_units),0) INTO v_expired FROM expired;
  UPDATE public.pilot_usage_accounts SET consumed_units=consumed_units+v_expired,
    reserved_units=reserved_units-v_expired, updated_at=now() WHERE owner_id=v_owner RETURNING * INTO v_account;
  SELECT * INTO v_existing FROM public.pilot_processing_operations WHERE owner_id=v_owner AND operation_id=p_operation_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash OR v_existing.session_id IS DISTINCT FROM p_session_id OR v_existing.kind <> p_kind
       OR v_existing.reserved_units <> p_max_units THEN
      RAISE EXCEPTION 'operation_conflict' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('acquired',false,'state',v_existing.state,'result',v_existing.result);
  END IF;
  IF p_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.interview_sessions WHERE id=p_session_id AND user_id=v_owner
      AND status IN ('active','paused') AND pilot_expires_at > now()
      AND created_at > now() - interval '30 minutes'
  ) THEN RETURN jsonb_build_object('acquired',false,'state','session_inactive'); END IF;
  SELECT count(*) INTO v_count FROM public.pilot_processing_operations WHERE owner_id=v_owner AND state='reserved';
  IF v_count >= v_account.max_concurrency THEN RETURN jsonb_build_object('acquired',false,'state','concurrency_exceeded'); END IF;
  IF v_account.granted_units-v_account.consumed_units-v_account.reserved_units < p_max_units THEN
    RETURN jsonb_build_object('acquired',false,'state','quota_exhausted');
  END IF;
  INSERT INTO public.pilot_processing_operations(owner_id,operation_id,session_id,request_hash,kind,state,reserved_units)
    VALUES(v_owner,p_operation_id,p_session_id,p_request_hash,p_kind,'reserved',p_max_units);
  UPDATE public.pilot_usage_accounts SET reserved_units=reserved_units+p_max_units,updated_at=now() WHERE owner_id=v_owner;
  RETURN jsonb_build_object('acquired',true,'state','reserved','result',null);
END $$;

CREATE OR REPLACE FUNCTION public.pilot_complete_operation(
  p_owner_id uuid, p_operation_id text, p_request_hash text, p_used_units integer,
  p_outcome text, p_result jsonb, p_transcript_text text DEFAULT NULL, p_source text DEFAULT 'microphone'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_account public.pilot_usage_accounts%ROWTYPE; v_op public.pilot_processing_operations%ROWTYPE; v_used integer; v_event_id uuid;
BEGIN
  -- EXECUTE is restricted to service_role. No browser role can certify a
  -- provider result or release an outstanding reservation.
  SELECT * INTO v_account FROM public.pilot_usage_accounts WHERE owner_id=p_owner_id FOR UPDATE;
  SELECT * INTO v_op FROM public.pilot_processing_operations WHERE owner_id=p_owner_id AND operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_op.request_hash <> p_request_hash THEN RAISE EXCEPTION 'operation_unavailable' USING ERRCODE='22023'; END IF;
  IF v_op.state <> 'reserved' THEN RETURN jsonb_build_object('state',v_op.state,'result',v_op.result); END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded','failed','unknown') OR p_used_units IS NULL OR
    p_used_units < 0 OR p_used_units > v_op.reserved_units OR p_result IS NULL OR octet_length(p_result::text)>262144 OR
    (p_transcript_text IS NOT NULL AND (length(p_transcript_text)>100000 OR p_source IS NULL OR p_source NOT IN ('microphone','system-audio'))) THEN
    RAISE EXCEPTION 'invalid_operation_result' USING ERRCODE='22023';
  END IF;
  v_used := CASE WHEN p_outcome='unknown' THEN v_op.reserved_units ELSE p_used_units END;
  IF v_op.expires_at <= now() THEN p_outcome := 'unknown'; v_used := v_op.reserved_units; END IF;
  IF p_outcome='succeeded' AND v_op.kind='transcription' AND p_transcript_text IS NOT NULL AND v_op.session_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.interview_sessions WHERE id=v_op.session_id AND user_id=p_owner_id) THEN
      RAISE EXCEPTION 'session_unavailable' USING ERRCODE='42501';
    END IF;
    INSERT INTO public.transcript_segments(user_id,interview_session_id,source,text,is_partial,client_event_id,provider_result)
      VALUES(p_owner_id,v_op.session_id,p_source,p_transcript_text,false,p_operation_id,p_result)
      ON CONFLICT(interview_session_id,client_event_id) DO UPDATE
        SET source=excluded.source,text=excluded.text,is_partial=false,provider_result=excluded.provider_result,
            pilot_sequence=nextval('public.transcript_segments_pilot_sequence_seq'::regclass)
        WHERE public.transcript_segments.user_id=p_owner_id AND public.transcript_segments.provider_result IS NULL
      RETURNING id INTO v_event_id;
    IF v_event_id IS NULL THEN RAISE EXCEPTION 'operation_event_conflict' USING ERRCODE='22023'; END IF;
  END IF;
  UPDATE public.pilot_processing_operations SET state=p_outcome,used_units=v_used,result=p_result,completed_at=now()
    WHERE owner_id=p_owner_id AND operation_id=p_operation_id;
  UPDATE public.pilot_usage_accounts SET reserved_units=reserved_units-v_op.reserved_units,
    consumed_units=consumed_units+v_used,updated_at=now() WHERE owner_id=p_owner_id;
  RETURN jsonb_build_object('state',p_outcome,'result',p_result);
END $$;

CREATE OR REPLACE FUNCTION public.pilot_set_allowance(p_owner_id uuid,p_granted_units bigint,p_max_concurrency integer DEFAULT 2)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.pilot_usage_accounts(owner_id,granted_units,max_concurrency)
    VALUES(p_owner_id,p_granted_units,p_max_concurrency)
    ON CONFLICT(owner_id) DO UPDATE SET granted_units=excluded.granted_units,max_concurrency=excluded.max_concurrency,updated_at=now();
END $$;

REVOKE ALL ON FUNCTION public.pilot_create_session(uuid,text,text), public.pilot_read_session(uuid,bigint),
  public.pilot_stop_session(uuid),public.pilot_delete_session(uuid),
  public.pilot_reserve_operation(uuid,text,integer,text,text),
  public.pilot_complete_operation(uuid,text,text,integer,text,jsonb,text,text),
  public.pilot_set_allowance(uuid,bigint,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pilot_create_session(uuid,text,text),public.pilot_read_session(uuid,bigint),
  public.pilot_stop_session(uuid),public.pilot_delete_session(uuid),
  public.pilot_reserve_operation(uuid,text,integer,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pilot_complete_operation(uuid,text,text,integer,text,jsonb,text,text),
  public.pilot_set_allowance(uuid,bigint,integer) TO service_role;
COMMIT;
