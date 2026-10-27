#!/usr/bin/env python3
"""Disposable PostgreSQL 17 contract tests; no external DB URL is accepted.

Runs migration 003 verbatim. Fixture uses migration 002 with only the unavailable
pgvector extension and unrelated resume/job embedding types replaced (double[]).
This is not a full pgvector/GoTrue deployment or hosted JWT acceptance test.
"""
import json
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PG_BIN = Path(os.environ.get("PILOT_TEST_PG_BIN", "/opt/homebrew/opt/postgresql@17/bin"))
A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
S = "33333333-3333-4333-8333-333333333333"
HASH = "a" * 64


class DurableStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = Path(tempfile.mkdtemp(prefix="pilot-db-contract-", dir="/private/tmp"))
        cls.data = cls.directory / "data"
        cls.socket = cls.directory / "socket"
        cls.socket.mkdir(mode=0o700)
        cls.log = cls.directory / "postgres.log"
        try:
            cls.run_pg("initdb", "-D", str(cls.data), "--no-locale", "--encoding=UTF8", "--auth=trust")
            # Only a private Unix socket is exposed. No TCP listener or shared DB.
            cls.run_pg("pg_ctl", "-D", str(cls.data), "-l", str(cls.log), "-o",
                       f"-c listen_addresses='' -c unix_socket_directories='{cls.socket}' -c max_connections=20", "-w", "start")
            cls.run_pg("psql", "-h", str(cls.socket), "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1", "-c",
                       "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;")
        except Exception:
            if cls.log.exists():
                print(cls.log.read_text())
            cls.run_pg("pg_ctl", "-D", str(cls.data), "-m", "immediate", "stop", check=False)
            shutil.rmtree(cls.directory)
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            cls.run_pg("pg_ctl", "-D", str(cls.data), "-m", "fast", "-w", "stop")
        finally:
            shutil.rmtree(cls.directory)

    @classmethod
    def run_pg(cls, binary, *args, check=True):
        env = os.environ.copy()
        # Never inherit PGHOST, PGPORT, PGDATABASE, PGSERVICE, PGPASSWORD etc.
        env = {key: value for key, value in env.items() if not key.startswith("PG")}
        result = subprocess.run([str(PG_BIN / binary), *args], text=True, capture_output=True, env=env)
        if check and result.returncode:
            raise RuntimeError(f"{binary} exited {result.returncode}: {result.stdout}\n{result.stderr}")
        return result

    def setUp(self):
        self.database = "pilot_" + self.id().split(".")[-1]
        self.run_pg("createdb", "-h", str(self.socket), self.database)
        baseline = (ROOT / "packages/db/migrations/postgres/002_cloud_nexus_pilot_interviews.sql").read_text()
        self.assertEqual(baseline.count('CREATE EXTENSION IF NOT EXISTS "vector";'), 1)
        self.assertEqual(baseline.count("embedding vector(1536)"), 2)
        baseline = baseline.replace('CREATE EXTENSION IF NOT EXISTS "vector";', "-- pgvector absent in local test fixture")
        baseline = baseline.replace("embedding vector(1536)", "embedding double precision[]")
        bootstrap = """
        CREATE SCHEMA auth;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
          $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
        GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;
        """
        self.sql(bootstrap + baseline + "GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;")
        # Seed a previous-release row before applying 003; it must remain readable.
        self.sql("INSERT INTO public.interview_sessions(id,user_id,status,notes) VALUES('44444444-4444-4444-8444-444444444444','" + B + "','ended','legacy-upgrade-note');")
        self.migration = (ROOT / "packages/db/migrations/postgres/003_pilot_durable_processing.sql").read_text()
        self.sql(self.migration)

    def tearDown(self):
        self.run_pg("dropdb", "-h", str(self.socket), self.database)

    def sql(self, sql, role=None, owner=None, okay=True):
        prefix = ""
        if owner is not None:
            prefix += f"SELECT set_config('request.jwt.claim.sub','{owner}',false);"
        if role is not None:
            prefix += f"SET ROLE {role};"
        result = self.run_pg("psql", "-h", str(self.socket), "-d", self.database,
                             "-qAt", "-v", "ON_ERROR_STOP=1", "-c", prefix + sql, check=False)
        if okay:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""

    def create(self, owner=A):
        return json.loads(self.sql(f"SELECT public.pilot_create_session('{S}','general','test-consent-v1');", "authenticated", owner))

    def allowance(self, units=1000):
        self.sql(f"SELECT public.pilot_set_allowance('{A}',{units},2);", "service_role")

    def reserve(self, operation="op1", owner=A, hash=HASH, units=100):
        return json.loads(self.sql(f"SELECT public.pilot_reserve_operation('{S}','{operation}',{units},'{hash}','transcription');", "authenticated", owner))

    def complete(self, operation="op1", owner=A, outcome="succeeded", units=70, text="Synthetic transcript"):
        return json.loads(self.sql(f"SELECT public.pilot_complete_operation('{owner}','{operation}','{HASH}',{units},'{outcome}','{{\"text\":\"synthetic\"}}','{text}','microphone');", "service_role"))

    def test_anonymous_cannot_create_or_reserve(self):
        self.sql(f"SELECT public.pilot_create_session('{S}','general','test');", "anon", okay=False)
        self.sql(f"SELECT public.pilot_reserve_operation(NULL,'op',1,'{HASH}');", "anon", okay=False)
        self.sql(f"SELECT public.pilot_create_session('{S}','general','test');", "authenticated", okay=False)

    def test_owned_create_and_idempotent_same_id(self):
        self.assertEqual(self.create()["user_id"], A)
        self.assertEqual(self.create()["id"], S)
        self.sql(f"SELECT public.pilot_create_session('{S}','general','test');", "authenticated", B, okay=False)

    def test_foreign_session_read_stop_delete_reserve(self):
        self.create()
        for call in [f"pilot_read_session('{S}')", f"pilot_stop_session('{S}')", f"pilot_reserve_operation('{S}','op',1,'{HASH}')"]:
            self.sql("SELECT public." + call + ";", "authenticated", B, okay=False)
        self.assertEqual(self.sql(f"SELECT public.pilot_delete_session('{S}');", "authenticated", B), "f")
        self.assertEqual(json.loads(self.sql(f"SELECT public.pilot_read_session('{S}');", "authenticated", A))["session"]["id"], S)

    def test_allowance_is_privileged_and_missing_account_fails_closed(self):
        self.create()
        self.assertEqual(self.reserve()["state"], "quota_exhausted")
        self.sql(f"SELECT public.pilot_set_allowance('{A}',1000000,8);", "authenticated", A, okay=False)
        self.sql(f"INSERT INTO public.pilot_usage_accounts(owner_id,granted_units) VALUES('{A}',1000000);", "authenticated", A, okay=False)

    def test_quota_and_concurrency_are_atomic(self):
        self.create(); self.allowance(150)
        self.assertTrue(self.reserve(units=100)["acquired"])
        self.assertEqual(self.reserve("op2", units=100)["state"], "quota_exhausted")
        self.allowance(1000)
        self.assertTrue(self.reserve("op2")["acquired"])
        self.assertEqual(self.reserve("op3")["state"], "concurrency_exceeded")
        self.assertEqual(self.sql(f"SELECT reserved_units FROM public.pilot_usage_accounts WHERE owner_id='{A}';"), "200")

    def test_pending_retry_never_reacquires_and_hash_mismatch_rejects(self):
        self.create(); self.allowance()
        self.assertTrue(self.reserve()["acquired"])
        self.assertEqual(self.reserve(), {"acquired": False, "state": "reserved", "result": None})
        self.sql(f"SELECT public.pilot_reserve_operation('{S}','op1',100,'{'b'*64}');", "authenticated", A, okay=False)
        self.assertEqual(self.sql("SELECT count(*) FROM public.pilot_processing_operations;"), "1")

    def test_success_settles_and_deduplicates_final_record(self):
        self.create(); self.allowance(); self.reserve()
        self.assertEqual(self.complete()["state"], "succeeded")
        self.assertEqual(self.complete(text="Duplicate must not overwrite")["state"], "succeeded")
        replay = self.reserve()
        self.assertFalse(replay["acquired"]); self.assertEqual(replay["state"], "succeeded")
        self.assertEqual(self.sql("SELECT count(*) FROM public.transcript_segments;"), "1")
        self.assertEqual(self.sql("SELECT text FROM public.transcript_segments;"), "Synthetic transcript")
        self.assertEqual(self.sql("SELECT consumed_units||':'||reserved_units FROM public.pilot_usage_accounts;"), "70:0")

    def test_authenticated_cannot_forge_settlement(self):
        self.create(); self.allowance(); self.reserve()
        self.sql(f"SELECT public.pilot_complete_operation('{A}','op1','{HASH}',0,'succeeded','{{}}',NULL,'microphone');", "authenticated", A, okay=False)
        self.sql("UPDATE public.pilot_processing_operations SET state='succeeded';", "authenticated", A, okay=False)
        self.sql("UPDATE public.pilot_usage_accounts SET consumed_units=0,reserved_units=0;", "authenticated", A, okay=False)
        self.assertEqual(self.reserve()["state"], "reserved")

    def test_expired_reservation_charges_unknown_without_repeating(self):
        self.create(); self.allowance(); self.reserve()
        self.sql("UPDATE public.pilot_processing_operations SET expires_at=now()-interval '1 second';")
        self.assertEqual(self.reserve()["state"], "unknown")
        self.assertEqual(self.sql("SELECT consumed_units||':'||reserved_units FROM public.pilot_usage_accounts;"), "100:0")
        self.assertEqual(self.complete()["state"], "unknown")
        self.assertEqual(self.sql("SELECT count(*) FROM public.transcript_segments;"), "0")

    def test_failed_and_unknown_outcomes_do_not_release_unknown_cost(self):
        self.create(); self.allowance(); self.reserve()
        self.complete(outcome="failed", units=0)
        self.assertEqual(self.sql("SELECT consumed_units||':'||reserved_units FROM public.pilot_usage_accounts;"), "0:0")
        self.reserve("op2"); self.complete("op2", outcome="unknown", units=0)
        self.assertEqual(self.sql("SELECT consumed_units||':'||reserved_units FROM public.pilot_usage_accounts;"), "100:0")

    def test_new_database_connection_restores_owned_cursor(self):
        self.create(); self.allowance(); self.reserve(); self.complete()
        # Each sql() call creates a brand-new backend connection, no runtime Map.
        first = json.loads(self.sql(f"SELECT public.pilot_read_session('{S}',0);", "authenticated", A))
        sequence = first["events"][0]["pilot_sequence"]
        self.assertEqual(first["events"][0]["client_event_id"], "op1")
        later = json.loads(self.sql(f"SELECT public.pilot_read_session('{S}',{sequence});", "authenticated", A))
        self.assertEqual(later["events"], [])

    def test_stop_idempotent_and_prevents_new_processing(self):
        self.create(); self.allowance()
        one = json.loads(self.sql(f"SELECT public.pilot_stop_session('{S}');", "authenticated", A))
        two = json.loads(self.sql(f"SELECT public.pilot_stop_session('{S}');", "authenticated", A))
        self.assertEqual(one["ended_at"], two["ended_at"])
        self.assertEqual(self.reserve()["state"], "session_inactive")

    def test_delete_owned_records_and_charge_pending_bound(self):
        self.create(); self.allowance(); self.reserve(); self.complete(); self.reserve("op2")
        self.assertEqual(self.sql(f"SELECT public.pilot_delete_session('{S}');", "authenticated", A), "t")
        self.assertEqual(self.sql("SELECT count(*) FROM public.transcript_segments;"), "0")
        self.assertEqual(self.sql("SELECT count(*) FROM public.pilot_processing_operations;"), "0")
        self.assertEqual(self.sql("SELECT consumed_units||':'||reserved_units FROM public.pilot_usage_accounts;"), "170:0")
        self.assertEqual(self.sql(f"SELECT public.pilot_delete_session('{S}');", "authenticated", A), "f")

    def test_usage_rows_are_owner_scoped(self):
        self.create(); self.allowance(); self.reserve()
        self.assertEqual(self.sql("SELECT count(*) FROM public.pilot_usage_accounts;", "authenticated", A), "1")
        self.assertEqual(self.sql("SELECT count(*) FROM public.pilot_usage_accounts;", "authenticated", B), "0")
        self.assertEqual(self.sql("SELECT count(*) FROM public.pilot_processing_operations;", "authenticated", B), "0")

    def test_reapplying_additive_migration_preserves_existing_data(self):
        self.create(); self.allowance(); self.reserve(); self.complete()
        self.sql(self.migration)
        self.assertEqual(self.reserve()["state"], "succeeded")
        self.assertEqual(self.sql("SELECT text FROM public.transcript_segments;"), "Synthetic transcript")

    def test_parallel_reservations_do_not_overspend(self):
        self.create(); self.allowance(150)
        with ThreadPoolExecutor(max_workers=4) as workers:
            results = list(workers.map(lambda index: self.reserve(f"parallel{index}"), range(4)))
        self.assertEqual(sum(result["acquired"] for result in results), 1)
        self.assertEqual(self.sql("SELECT reserved_units FROM public.pilot_usage_accounts;"), "100")

    def test_storage_survives_database_process_restart(self):
        self.create(); self.allowance(); self.reserve(); self.complete()
        self.run_pg("pg_ctl", "-D", str(self.data), "-m", "fast", "-w", "stop")
        self.run_pg("pg_ctl", "-D", str(self.data), "-l", str(self.log), "-o",
                    f"-c listen_addresses='' -c unix_socket_directories='{self.socket}' -c max_connections=20", "-w", "start")
        recovered = json.loads(self.sql(f"SELECT public.pilot_read_session('{S}');", "authenticated", A))
        self.assertEqual(recovered["events"][0]["text"], "Synthetic transcript")
        self.assertEqual(self.reserve()["state"], "succeeded")

    def test_child_row_cannot_attach_to_foreign_parent(self):
        self.create()
        self.sql(f"INSERT INTO public.transcript_segments(user_id,interview_session_id,source,text) VALUES('{B}','{S}','manual','foreign');", "authenticated", B, okay=False)
        self.assertEqual(self.sql("SELECT count(*) FROM public.transcript_segments;"), "0")

    def test_session_lifetime_cannot_be_extended_by_editing_expiry(self):
        self.create(); self.allowance()
        self.sql("UPDATE public.interview_sessions SET created_at=now()-interval '31 minutes',pilot_expires_at=now()+interval '1 year';")
        self.assertEqual(self.reserve()["state"], "session_inactive")

    def test_existing_owned_client_write_remains_permitted(self):
        self.create()
        self.sql(f"INSERT INTO public.transcript_segments(user_id,interview_session_id,source,text) VALUES('{A}','{S}','manual','owned manual note');", "authenticated", A)
        self.assertEqual(self.sql("SELECT text FROM public.transcript_segments;", "authenticated", A), "owned manual note")

    def test_upgrade_preserves_preexisting_session(self):
        old = json.loads(self.sql("SELECT public.pilot_read_session('44444444-4444-4444-8444-444444444444');", "authenticated", B))
        self.assertEqual(old["session"]["notes"], "legacy-upgrade-note")
        self.assertIsNone(old["session"]["pilot_expires_at"])

    def test_client_cannot_forge_event_certification_or_cursor(self):
        self.create()
        self.sql(f"INSERT INTO public.transcript_segments(user_id,interview_session_id,source,text,client_event_id,pilot_sequence,provider_result) VALUES('{A}','{S}','manual','untrusted','manual',999999,'{{\"forged\":true}}');", "authenticated", A)
        result = json.loads(self.sql("SELECT json_build_object('sequence',pilot_sequence,'result',provider_result) FROM public.transcript_segments;"))
        self.assertNotEqual(result["sequence"],999999); self.assertIsNone(result["result"])
        self.sql("UPDATE public.transcript_segments SET pilot_sequence=999999;", "authenticated", A, okay=False)
        self.sql("UPDATE public.transcript_segments SET provider_result='{}';", "authenticated", A, okay=False)
        self.sql("UPDATE public.transcript_segments SET text='legitimate manual edit';", "authenticated", A)
        self.assertEqual(self.sql("SELECT text FROM public.transcript_segments;"), "legitimate manual edit")

    def test_certified_result_cannot_be_edited_or_deleted_by_client(self):
        self.create(); self.allowance(); self.reserve(); self.complete()
        self.sql("UPDATE public.transcript_segments SET text='forged';", "authenticated", A, okay=False)
        self.sql("DELETE FROM public.transcript_segments;", "authenticated", A, okay=False)
        self.assertEqual(self.sql("SELECT text FROM public.transcript_segments;"), "Synthetic transcript")
        self.assertEqual(self.sql(f"SELECT public.pilot_delete_session('{S}');", "authenticated", A), "t")

    def test_preexisting_untrusted_event_is_upgraded_not_silently_accepted(self):
        self.create(); self.allowance()
        self.sql(f"INSERT INTO public.transcript_segments(user_id,interview_session_id,source,text,client_event_id) VALUES('{A}','{S}','manual','poisoned text','op1');", "authenticated", A)
        previous_sequence = int(self.sql("SELECT pilot_sequence FROM public.transcript_segments;"))
        self.reserve(); self.complete()
        self.assertEqual(self.sql("SELECT count(*) FROM public.transcript_segments;"), "1")
        self.assertEqual(self.sql("SELECT text FROM public.transcript_segments;"), "Synthetic transcript")
        self.assertEqual(self.sql("SELECT provider_result IS NOT NULL FROM public.transcript_segments;"), "t")
        self.assertGreater(int(self.sql("SELECT pilot_sequence FROM public.transcript_segments;")), previous_sequence)
        resumed = json.loads(self.sql(f"SELECT public.pilot_read_session('{S}',{previous_sequence});", "authenticated", A))
        self.assertEqual(resumed["events"][0]["text"], "Synthetic transcript")

    def test_client_cannot_truncate_other_users_data(self):
        self.create()
        self.sql("TRUNCATE public.interview_sessions CASCADE;", "authenticated", B, okay=False)
        self.assertEqual(self.sql("SELECT count(*) FROM public.interview_sessions WHERE id='" + S + "';"), "1")

    def test_client_cannot_forge_processing_session_expiry(self):
        self.create(); self.allowance()
        self.sql("UPDATE public.interview_sessions SET pilot_expires_at=now()+interval '1 year';", "authenticated", A, okay=False)
        self.sql("UPDATE public.interview_sessions SET created_at=now();", "authenticated", A, okay=False)
        self.sql("UPDATE public.interview_sessions SET notes='permitted note';", "authenticated", A)
        self.assertEqual(self.sql("SELECT notes FROM public.interview_sessions WHERE id='" + S + "';"), "permitted note")

    def test_stop_settles_pending_as_unknown_and_rejects_late_final(self):
        self.create(); self.allowance(); self.reserve()
        self.sql(f"SELECT public.pilot_stop_session('{S}');", "authenticated", A)
        self.assertEqual(self.complete()["state"], "unknown")
        self.assertEqual(self.sql("SELECT count(*) FROM public.transcript_segments;"), "0")
        self.sql(f"SELECT public.pilot_stop_session('{S}');", "authenticated", A)
        self.assertEqual(self.sql("SELECT consumed_units||':'||reserved_units FROM public.pilot_usage_accounts;"), "100:0")

    def test_guidance_association_is_durable(self):
        self.create(); self.allowance()
        self.sql(f"SELECT public.pilot_reserve_operation('{S}','guide1',100,'{HASH}','guidance');", "authenticated", A)
        self.sql(f"SELECT public.pilot_complete_operation('{A}','guide1','{HASH}',80,'succeeded','{{\"suggestion\":\"synthetic\"}}');", "service_role")
        saved = json.loads(self.sql(f"SELECT public.pilot_read_session('{S}');", "authenticated", A))
        self.assertEqual(saved["guidance"][0]["operation_id"], "guide1")
        self.assertEqual(saved["events"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
