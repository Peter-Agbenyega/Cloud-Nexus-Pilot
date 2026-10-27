import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

OPS=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(OPS))
import backup
sys.path.pop(0)


class BackupBoundaryTests(unittest.TestCase):
    def fixture(self):
        values={'PILOT_POSTGRES_IMAGE':'test@sha256:'+'a'*64,'PILOT_PG_VOLUME':'pilot-test'}
        details={'Config':{'Image':values['PILOT_POSTGRES_IMAGE'],'Labels':{'com.docker.compose.project':'cloud-nexus-pilot','com.docker.compose.service':'db'}},'State':{'Running':True},'HostConfig':{'PortBindings':{}},'Image':'sha256:actual','Mounts':[{'Destination':'/pilot-data','Type':'volume','Name':'pilot-test','RW':True}],'NetworkSettings':{'Networks':{'data':{'NetworkID':'private-network'}}}}
        networks=[{'Id':'private-network','Internal':True,'Labels':{'com.docker.compose.project':'cloud-nexus-pilot','com.docker.compose.network':'data'}}]
        return details,values,networks

    def test_exact_image_volume_network_identity_accepted(self):
        d,v,n=self.fixture();backup.validate_database(d,v,'sha256:actual',n)

    def test_wrong_instance_or_published_database_rejected(self):
        for mutate in [lambda d:d['Config']['Labels'].update({'com.docker.compose.project':'other'}),lambda d:d.update(Image='sha256:other'),lambda d:d['State'].update(Running=False),lambda d:d['HostConfig'].update(PortBindings={'5432/tcp':[{'HostIp':'0.0.0.0'}]}),lambda d:d['Mounts'][0].update(Name='shared-data'),lambda d:d['Mounts'][0].update(Type='bind'),lambda d:d['NetworkSettings']['Networks'].update(egress={'NetworkID':'public'})]:
            d,v,n=self.fixture();mutate(d)
            with self.assertRaises(ValueError):backup.validate_database(d,v,'sha256:actual',n)

    def test_external_or_wrong_network_rejected(self):
        for key,value in [('Internal',False),('Id','other-network')]:
            d,v,n=self.fixture();n[0][key]=value
            with self.assertRaises(ValueError):backup.validate_database(d,v,'sha256:actual',n)


class BackupSourceTests(unittest.TestCase):
    def test_private_pre_admission_backup_does_not_require_public_routing(self):
        backup.validate_backup_values({'PILOT_POSTGRES_IMAGE':'pg@sha256:'+'a'*64,'PILOT_PG_VOLUME':'cnp-pilot-staging-pg17','PILOT_CONFIG_DIR':'/private/config'})
        with self.assertRaises(ValueError):backup.validate_backup_values({'PILOT_POSTGRES_IMAGE':'pg:latest'})

    def test_export_requires_explicit_full_source(self):
        with patch.object(backup.subprocess,'run',return_value=subprocess.CompletedProcess([],128,'','')):
            for value in (None,'short','a'*39):
                with self.assertRaises(ValueError):backup.release_source(Path('/tmp'),value)
            self.assertEqual(backup.release_source(Path('/tmp'),'a'*40),('a'*40,'operator-selected-export'))

    def test_export_without_git_binary(self):
        with patch.object(backup.subprocess,'run',side_effect=FileNotFoundError):
            self.assertEqual(backup.release_source(Path('/tmp'),'a'*40),('a'*40,'operator-selected-export'))

    def test_checkout_disagreement_rejected(self):
        with patch.object(backup.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'a'*40+'\n','')):
            with self.assertRaises(ValueError):backup.release_source(Path('/tmp'),'b'*40)
            self.assertEqual(backup.release_source(Path('/tmp'),'a'*40),('a'*40,'git-checkout'))


class BackupEncryptionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name)
        cls.key=cls.root/'synthetic.key';cls.cert=cls.root/'synthetic.crt'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(cls.key),'-out',str(cls.cert),'-days','1','-subj','/CN=Pilot-disposable-backup-test'],check=True,capture_output=True,timeout=30)
        cls.key.chmod(0o600)

    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def test_real_encryption_round_trip_and_stream_hash(self):
        archive=self.root/'success.cms.partial';errors=self.root/'success.errors'
        content=b'Pilot synthetic dump fixture.'*4096
        command=[sys.executable,'-c','import sys; sys.stdout.buffer.write(b"Pilot synthetic dump fixture."*4096)']
        producer,encrypt,digest=backup.encrypt_dump(command,self.cert,archive,errors)
        self.assertEqual((producer,encrypt),(0,0));self.assertEqual(digest,hashlib.sha256(archive.read_bytes()).hexdigest())
        decrypted=subprocess.run(['openssl','cms','-decrypt','-inform','DER','-in',str(archive),'-recip',str(self.cert),'-inkey',str(self.key)],check=True,capture_output=True,timeout=30).stdout
        self.assertEqual(decrypted,content);self.assertNotIn(content[:64],archive.read_bytes())
        self.assertFalse(list(self.root.glob('*.dump')))

    def test_failed_producer_never_counts_as_success(self):
        with self.assertRaises(RuntimeError):backup.encrypt_dump([sys.executable,'-c','raise SystemExit(7)'],self.cert,self.root/'failed.cms.partial',self.root/'failed.errors')
        self.assertFalse((self.root/'failed.cms').exists())

    def test_bad_certificate_never_counts_as_success(self):
        invalid=self.root/'invalid.crt';invalid.write_text('not a certificate')
        with self.assertRaises(RuntimeError):backup.encrypt_dump([sys.executable,'-c','print("synthetic")'],invalid,self.root/'invalid.cms.partial',self.root/'invalid.errors')
        self.assertFalse((self.root/'invalid.cms').exists())


if __name__=='__main__':unittest.main()
