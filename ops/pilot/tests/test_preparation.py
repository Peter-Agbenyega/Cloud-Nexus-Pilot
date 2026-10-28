import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[3]
OPS=ROOT/'ops/pilot'
spec=importlib.util.spec_from_file_location('pilot_verify',OPS/'verify_config.py')
verify=importlib.util.module_from_spec(spec);spec.loader.exec_module(verify)


def selectors(directory):
    return {'PILOT_CONFIG_DIR':str(directory),'PILOT_PG_VOLUME':'pilot_staging_test',
            **{k:'example/pilot@sha256:'+'a'*64 for k in ('PILOT_POSTGRES_IMAGE','PILOT_AUTH_IMAGE','PILOT_REST_IMAGE','PILOT_REALTIME_IMAGE')},
            'PILOT_IDENTITY_HOST':'identity.pilot.example.com','PILOT_REALTIME_HOST':'realtime.pilot.example.com','PILOT_WEB_ORIGIN':'https://pilot.example.com'}


class PreparationTests(unittest.TestCase):
    def test_valid_shape_does_not_claim_destination(self):
        self.assertEqual(verify.validate(selectors(Path('/private/test'))),Path('/private/test'))

    def test_real_guest_volume_and_content_addressed_image_are_accepted(self):
        v=selectors(Path('/private/test'));v['PILOT_PG_VOLUME']='cnp-pilot-staging-pg17';v['PILOT_REALTIME_IMAGE']='sha256:'+'b'*64
        verify.validate(v)

    def test_placeholder_or_numeric_hosts_block_admission(self):
        for key in ('PILOT_IDENTITY_HOST','PILOT_REALTIME_HOST'):
            for host in ('pilot.example.invalid','pilot.test','192.168.68.54'):
                v=selectors(Path('/private/test'));v[key]=host
                with self.assertRaises(ValueError):verify.validate(v)
        v=selectors(Path('/private/test'));v['PILOT_WEB_ORIGIN']='https://pilot.example.invalid'
        with self.assertRaises(ValueError):verify.validate(v)

    def test_service_identity_and_origin_must_agree(self):
        v=selectors(Path('/private/test'))
        services={'auth':{'API_EXTERNAL_URL':'https://identity.pilot.example.com/auth/v1','GOTRUE_SITE_URL':v['PILOT_WEB_ORIGIN'],'GOTRUE_DISABLE_SIGNUP':'true','GOTRUE_MAILER_AUTOCONFIRM':'false'},'realtime':{'SUPABASE_URL':'https://identity.pilot.example.com','CORS_ORIGIN':v['PILOT_WEB_ORIGIN']}}
        verify.validate_service_identity(v,services)
        for service,key in [('auth','API_EXTERNAL_URL'),('auth','GOTRUE_SITE_URL'),('realtime','CORS_ORIGIN'),('realtime','SUPABASE_URL')]:
            wrong=copy.deepcopy(services);wrong[service][key]='https://foreign.example.com'
            with self.assertRaises(ValueError):verify.validate_service_identity(v,wrong)
        wrong=copy.deepcopy(services);wrong['realtime']['NEXT_PUBLIC_PILOT_TEST_FIXTURE']='1'
        with self.assertRaises(ValueError):verify.validate_service_identity(v,wrong)

    def test_mutable_image_rejected(self):
        for key in ('PILOT_POSTGRES_IMAGE','PILOT_AUTH_IMAGE','PILOT_REST_IMAGE','PILOT_REALTIME_IMAGE'):
            v=selectors(Path('/private/test'));v[key]='example/image:latest'
            with self.subTest(key=key),self.assertRaises(ValueError):verify.validate(v)

    def test_public_origins_must_be_exact_https(self):
        for origin in ('http://pilot.test','https://pilot.test/path','https://user:secret@pilot.test','https://pilot.test?x=1','https://*.pilot.test','https://pilot.test:8888'):
            v=selectors(Path('/private/test'));v['PILOT_WEB_ORIGIN']=origin
            with self.subTest(origin=origin),self.assertRaises(ValueError):verify.validate(v)

    def test_shared_volume_and_relative_configuration_rejected(self):
        for key,value in [('PILOT_PG_VOLUME','datahub'),('PILOT_CONFIG_DIR','relative')]:
            v=selectors(Path('/private/test'));v[key]=value
            with self.assertRaises(ValueError):verify.validate(v)

    def test_duplicate_and_shell_templates_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'test.env'
            for body in ('A=ok\nA=again\n','A=${HOME}\n','A=REPLACE_THIS\n','source secrets\n'):
                p.write_text(body)
                with self.assertRaises(ValueError):verify.read_values(p)

    def test_private_config_must_not_be_world_readable_or_symlinked(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'test.env';p.write_text('KEY=synthetic\n');p.chmod(0o644)
            with self.assertRaises(ValueError):verify.read_values(p,private=True)
            p.chmod(0o600);self.assertEqual(verify.read_values(p,private=True),{'KEY':'synthetic'})
            link=Path(d)/'link';link.symlink_to(p)
            with self.assertRaises(ValueError):verify.read_values(link)

    def test_rendered_compose_is_pilot_only_and_private(self):
        # Actual Compose parser, no daemon, provisioning, credentials or network.
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)
            for name in ('db','auth','rest','realtime','bootstrap','migration'):(folder/(name+'.env')).write_text('SYNTHETIC_CONFIG=literal-$MUST_NOT_EXPAND\n')
            env={**os.environ,**selectors(folder),'MUST_NOT_EXPAND':'wrong-if-expanded'}
            result=subprocess.run(['docker','compose','-f',str(OPS/'compose.yaml'),'--profile','bootstrap','--profile','migrate','config','--format','json'],env=env,text=True,capture_output=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr)
            config=json.loads(result.stdout);services=config['services']
            self.assertEqual(set(services),{'db','auth','rest','realtime','bootstrap','migrate'})
            self.assertFalse(services['db'].get('ports'));self.assertTrue(config['networks']['data']['internal'])
            self.assertTrue(config['volumes']['pgdata']['external'])
            for name in ('auth','rest'):
                self.assertTrue(all(p['host_ip']=='127.0.0.1' for p in services[name]['ports']))
            self.assertEqual(services['db']['networks'],{'data':None})
            # Published APIs need a non-internal bridge on Docker29.
            self.assertEqual(set(services['rest']['networks']),{'data','egress'})
            self.assertFalse(config['networks']['egress'].get('internal',False))
            self.assertEqual(services['realtime']['network_mode'],'host')
            self.assertEqual(services['realtime']['environment']['HOST'],'127.0.0.1')
            self.assertEqual(services['realtime']['environment']['WS_TRUSTED_PROXY_CIDRS'],'127.0.0.1/32')
            for service in services.values():
                self.assertTrue(service['read_only']);self.assertIn('ALL',service['cap_drop'])
                # Compose serialization escapes dollars for re-reading; the
                # isolated container rehearsal separately checks runtime bytes.
                self.assertIn(service['environment']['SYNTHETIC_CONFIG'],('literal-$MUST_NOT_EXPAND','literal-$$MUST_NOT_EXPAND'))
            self.assertFalse(any('build' in service for service in services.values()))

    def test_templates_cannot_pass_preflight(self):
        with self.assertRaises(ValueError):verify.read_values(OPS/'deployment.env.example')


if __name__=='__main__':unittest.main()
