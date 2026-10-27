"""Synthetic checker tests, not product acceptance tests."""
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from check_release_evidence import REQUIRED, read_manifest, validate
SHA, WORKER = 'a' * 40, 'b' * 40
NOW = '2026-10-19T18:00:00+00:00'

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)/'evidence'; self.root.mkdir()
        self.artifact = self.root/'result.txt'; self.artifact.write_text('Synthetic result, NOT product evidence.\n')
        self.sources = {'app': SHA, 'worker': WORKER}
        self.record = {'status': 'passed', 'sources': self.sources, 'executed_at': NOW,
                       'kind': 'command', 'command': ['synthetic'], 'exit_code': 0,
                       'summary': 'Synthetic fixture only', 'artifacts': [{'path':'result.txt',
                       'sha256': hashlib.sha256(self.artifact.read_bytes()).hexdigest()}],
                       'unresolved_high_critical': 0, 'advisories_checked_at': NOW}
        self.manifest = {'schema_version':2,'product':'apply','sources':copy.deepcopy(self.sources),
                         'blockers':[], 'stages':{n:copy.deepcopy(self.record) for n in REQUIRED['apply']}}
    def errors(self):
        return validate(self.manifest,self.root,'apply',SHA,WORKER)
    def test_valid_apply(self): self.assertEqual(self.errors(),[])
    def test_valid_pilot(self):
        m=copy.deepcopy(self.manifest);m['product']='pilot';m['sources']={'pilot':SHA}
        m['stages']={k:copy.deepcopy(self.record) for k in REQUIRED['pilot']}
        for r in m['stages'].values():r['sources']={'pilot':SHA}
        self.assertEqual(validate(m,self.root,'pilot',SHA),[])
    def test_missing_worker_argument(self):self.assertTrue(validate(self.manifest,self.root,'apply',SHA))
    def test_wrong_worker_argument(self):self.assertTrue(validate(self.manifest,self.root,'apply',SHA,'c'*40))
    def test_pilot_rejects_worker_argument(self):self.assertTrue(validate({},self.root,'pilot',SHA,WORKER))
    def test_nonobject(self):self.assertTrue(validate([],self.root,'apply',SHA,WORKER))
    def test_unknown_product(self):self.assertTrue(validate({},self.root,'other',SHA))
    def test_invalid_sha(self):self.assertTrue(validate(self.manifest,self.root,'apply','main',WORKER))
    def test_missing_root(self):self.assertTrue(validate(self.manifest,self.root/'absent','apply',SHA,WORKER))
    def test_schema_one(self):self.manifest['schema_version']=1;self.assertTrue(self.errors())
    def test_boolean_schema(self):self.manifest['schema_version']=True;self.assertTrue(self.errors())
    def test_product_mismatch(self):self.manifest['product']='pilot';self.assertTrue(self.errors())
    def test_blockers(self):self.manifest['blockers']=['production unknown'];self.assertTrue(self.errors())
    def test_missing_blockers(self):del self.manifest['blockers'];self.assertTrue(self.errors())
    def test_extra_source(self):self.manifest['sources']['extra']=SHA;self.assertTrue(self.errors())
    def test_stale_source(self):self.manifest['sources']['app']='c'*40;self.assertTrue(self.errors())
    def test_missing_gate(self):del self.manifest['stages']['dependency_audit'];self.assertTrue(self.errors())
    def test_missing_worker_audit(self):del self.manifest['stages']['worker_dependency_audit'];self.assertTrue(self.errors())
    def test_wrong_stages_type(self):self.manifest['stages']=[];self.assertTrue(self.errors())
    def test_pending_gate(self):self.manifest['stages']['lint']['status']='pending';self.assertTrue(self.errors())
    def test_skipped_gate(self):self.manifest['stages']['lint']['status']='skipped';self.assertTrue(self.errors())
    def test_failed_gate(self):self.manifest['stages']['lint']['status']='failed';self.assertTrue(self.errors())
    def test_stale_gate_worker(self):self.manifest['stages']['lint']['sources']['worker']='c'*40;self.assertTrue(self.errors())
    def test_no_timezone(self):self.manifest['stages']['lint']['executed_at']='2026-10-19T18:00:00';self.assertTrue(self.errors())
    def test_bad_time(self):self.manifest['stages']['lint']['executed_at']='tomorrow';self.assertTrue(self.errors())
    def test_empty_summary(self):self.manifest['stages']['lint']['summary']=' ';self.assertTrue(self.errors())
    def test_bad_kind(self):self.manifest['stages']['lint']['kind']='claim';self.assertTrue(self.errors())
    def test_command_exit_nonzero(self):self.manifest['stages']['lint']['exit_code']=1;self.assertTrue(self.errors())
    def test_boolean_exit(self):self.manifest['stages']['lint']['exit_code']=False;self.assertTrue(self.errors())
    def test_empty_command(self):self.manifest['stages']['lint']['command']=[];self.assertTrue(self.errors())
    def test_string_command(self):self.manifest['stages']['lint']['command']='true';self.assertTrue(self.errors())
    def test_review_requires_reviewer(self):self.manifest['stages']['lint']['kind']='review';self.assertTrue(self.errors())
    def test_valid_review(self):self.manifest['stages']['lint'].update(kind='review',reviewer='synthetic-reviewer');self.assertEqual(self.errors(),[])
    def test_empty_artifacts(self):self.manifest['stages']['lint']['artifacts']=[];self.assertTrue(self.errors())
    def test_bad_artifact_record(self):self.manifest['stages']['lint']['artifacts']=['bad'];self.assertTrue(self.errors())
    def test_hash_mismatch(self):self.artifact.write_text('changed');self.assertTrue(self.errors())
    def test_empty_file(self):self.artifact.write_text('');self.assertTrue(self.errors())
    def test_missing_file(self):self.artifact.unlink();self.assertTrue(self.errors())
    def test_absolute_path(self):self.manifest['stages']['lint']['artifacts'][0]['path']=str(self.artifact);self.assertTrue(self.errors())
    def test_traversal(self):self.manifest['stages']['lint']['artifacts'][0]['path']='../result.txt';self.assertTrue(self.errors())
    def test_windows_path(self):self.manifest['stages']['lint']['artifacts'][0]['path']='C:\\result.txt';self.assertTrue(self.errors())
    def test_symlink_inside(self):
        (self.root/'link').symlink_to(self.artifact);self.manifest['stages']['lint']['artifacts'][0]['path']='link';self.assertTrue(self.errors())
    def test_symlink_outside(self):
        outside=self.root.parent/'out';outside.write_text('test');(self.root/'link').symlink_to(outside)
        self.manifest['stages']['lint']['artifacts'][0]['path']='link';self.assertTrue(self.errors())
    def test_directory_not_file(self):self.manifest['stages']['lint']['artifacts'][0]['path']='.';self.assertTrue(self.errors())
    def test_malformed_digest(self):self.manifest['stages']['lint']['artifacts'][0]['sha256']='bad';self.assertTrue(self.errors())
    def test_high_finding_blocks(self):self.manifest['stages']['dependency_audit']['unresolved_high_critical']=1;self.assertTrue(self.errors())
    def test_boolean_audit_count(self):self.manifest['stages']['dependency_audit']['unresolved_high_critical']=False;self.assertTrue(self.errors())
    def test_audit_date_required(self):del self.manifest['stages']['dependency_audit']['advisories_checked_at'];self.assertTrue(self.errors())
    def test_duplicate_json_keys(self):
        p=self.root/'bad.json';p.write_text('{"a":1,"a":2}')
        with self.assertRaises(ValueError):read_manifest(p)
    def test_nan_rejected(self):
        p=self.root/'bad.json';p.write_text('{"x":NaN}')
        with self.assertRaises(ValueError):read_manifest(p)
    def test_infinity_rejected(self):
        p=self.root/'bad.json';p.write_text('{"x":Infinity}')
        with self.assertRaises(ValueError):read_manifest(p)
    def test_large_manifest(self):
        p=self.root/'big.json';p.write_text(' '*1048577)
        with self.assertRaises(ValueError):read_manifest(p)
    def test_cli_denies_authorization_even_when_valid(self):
        p=self.root/'manifest.json';p.write_text(json.dumps(self.manifest))
        cmd=[sys.executable,str(Path(__file__).with_name('check_release_evidence.py')),str(p),
             '--evidence-root',str(self.root),'--product','apply','--expected-sha',SHA,'--expected-worker-sha',WORKER]
        result=subprocess.run(cmd,capture_output=True,text=True)
        self.assertEqual(result.returncode,0);self.assertFalse(json.loads(result.stdout)['release_authorization_granted'])

if __name__=='__main__':unittest.main()
