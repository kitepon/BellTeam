"""Current-UID placement with a receipt stub, never root/crypto acceptance."""
import hashlib
import importlib.util
import io
import json
import tarfile
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('web_test', Path(__file__).with_name('web-gateway-install.test.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

class NotificationsWriterTest(unittest.TestCase):
    def setUp(self):
        self.f = base.IsolatedWriterTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        manifest = dict(schema='bellteam.notifications.artifact.v1', component='notifications', sourceCommit='a'*40,
            entry='payload/src/notifications-entry.mjs', runtime=dict(os='linux',arch='amd64',nodeMajor=26,parentProtocol=2,stateSchema=2))
        files={'payload/src/notifications-entry.mjs': b'export {}\n','payload/package.json':b'{}\n','payload/package-lock.json':b'{}\n'}
        manifest['files']=[dict(path=k,bytes=len(v),sha256=hashlib.sha256(v).hexdigest()) for k,v in files.items()]
        self.manifest=manifest
        self.make_archive()
    def make_archive(self):
        manifest=self.manifest
        files={'payload/src/notifications-entry.mjs': b'export {}\n','payload/package.json':b'{}\n','payload/package-lock.json':b'{}\n'}
        metadata=(json.dumps(manifest)+'\n').encode();out=io.BytesIO()
        with tarfile.open(fileobj=out,mode='w:gz') as archive:
            for name,content in [('manifest.json',metadata),*files.items()]:
                member=tarfile.TarInfo(name);member.size=len(content);archive.addfile(member,io.BytesIO(content))
        raw=out.getvalue();digest=hashlib.sha256(raw).hexdigest()
        directory=self.f.incoming/digest;directory.mkdir(exist_ok=True)
        (directory/'archive.tar.gz').write_bytes(raw);(directory/'bundle.json').write_bytes(b'unsigned receipt stub')
        self.f.expected=base.writer.expectation(digest,'a'*40,'b'*40)
        self.f.receipt=dict(schema='bellteam.notifications.verification.v1',archiveSha256=digest,manifestSha256=hashlib.sha256(metadata).hexdigest(),
            manifest=manifest,verification=dict(method='github-oidc-attestation',repositoryId='1404510084'))
        self.f.verify.side_effect=lambda archive,bundle,expected,component: self.verify(archive,bundle,expected,component)
    def verify(self,archive,bundle,expected,component):
        self.assertEqual(component,'notifications')
        return self.f.verified_fixture(archive,bundle,expected)
    def install(self):
        return base.writer.install(self.f.private,self.f.incoming,self.f.expected,'notifications')
    def test_notification_publication_does_not_adopt_or_change_web(self):
        self.install();self.f.preserved()
        target=self.f.private/'notifications/releases'/self.f.expected['archiveSha256']
        receipt=json.loads((target/'installation.json').read_bytes())
        self.assertEqual(receipt['component'],'notifications')
        self.assertEqual(receipt['schema'],'bellteam.notifications.installation.v1')
        self.assertEqual(list((self.f.private/'notifications').glob('.staging-*')),[])
        with self.assertRaisesRegex(ValueError,'GATEWAY_RELEASE_EXISTS'): self.install()
    def test_web_receipt_and_incompatible_state_are_rejected_before_publication(self):
        self.f.receipt['schema']='bellteam.web-gateway.verification.v1'
        with self.assertRaisesRegex(ValueError,'GATEWAY_INSTALL_RECEIPT'):self.install()
        self.manifest['runtime']['stateSchema']=1;self.make_archive()
        with self.assertRaisesRegex(ValueError,'GATEWAY_INSTALL_RECEIPT'):self.install()
        self.assertEqual(list((self.f.private/'notifications/releases').iterdir()),[])
    def test_notification_component_lock_queues_second_installer(self):
        component = self.f.private / 'notifications'; component.mkdir()
        lock = component / '.install.lock'; lock.touch(mode=0o600)
        self.f.assert_install_waits(lock, base.fcntl.LOCK_EX, self.install)

if __name__=='__main__':unittest.main()
