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
spec = importlib.util.spec_from_file_location("artifact", Path(__file__).resolve().parents[1] / "scripts/web_gateway_artifact.py")
artifact = importlib.util.module_from_spec(spec); spec.loader.exec_module(artifact)

class ConversationWriterTest(unittest.TestCase):
    def setUp(self):
        self.f = base.IsolatedWriterTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        manifest = dict(schema='bellteam.conversation.artifact.v1', component='conversation', sourceCommit='a'*40,
            entry='payload/src/conversation-entry.mjs', runtime=dict(os='linux',arch='amd64',nodeMajor=26,parentProtocol=1,stateSchema=None,stateCompatibility=dict(directRecordSchemas=['bellteam.direct-message.v1','bellteam.interim-word.v1','bellteam.delivery-status.v1'],roomRecordSchemas=['bellteam.room-message.v1','bellteam.room-routing-status.v1','bellteam.room-delivery-status.v1'],roomSchema='bellteam.room.v1',scheduleSchema='bellteam.schedule.v1',selfTurnsSchema='bellteam.self-turns.v1',imageMimeTypes=['image/png','image/jpeg','image/webp','image/gif'],readerContract='bellteam.conversation-reader.v1')))
        files={name: b'fixture\n' for name in artifact.contract('conversation')[2]}
        manifest['files']=[dict(path=k,bytes=len(v),sha256=hashlib.sha256(v).hexdigest()) for k,v in files.items()]
        self.manifest=manifest
        self.make_archive()
    def make_archive(self):
        manifest=self.manifest
        files={name: b'fixture\n' for name in artifact.contract('conversation')[2]}
        metadata=(json.dumps(manifest)+'\n').encode();out=io.BytesIO()
        with tarfile.open(fileobj=out,mode='w:gz') as archive:
            for name,content in [('manifest.json',metadata),*files.items()]:
                member=tarfile.TarInfo(name);member.size=len(content);archive.addfile(member,io.BytesIO(content))
        raw=out.getvalue();digest=hashlib.sha256(raw).hexdigest()
        directory=self.f.incoming/digest;directory.mkdir(exist_ok=True)
        (directory/'archive.tar.gz').write_bytes(raw);(directory/'bundle.json').write_bytes(b'unsigned receipt stub')
        self.f.expected=base.writer.expectation(digest,'a'*40,'b'*40)
        self.f.receipt=dict(schema='bellteam.conversation.verification.v1',archiveSha256=digest,manifestSha256=hashlib.sha256(metadata).hexdigest(),
            manifest=manifest,verification=dict(method='github-oidc-attestation',repositoryId='1404510084'))
        self.f.verify.side_effect=lambda archive,bundle,expected,component: self.verify(archive,bundle,expected,component)
    def verify(self,archive,bundle,expected,component):
        self.assertEqual(component,'conversation')
        return self.f.verified_fixture(archive,bundle,expected)
    def install(self):
        return base.writer.install(self.f.private,self.f.incoming,self.f.expected,'conversation')
    def test_conversation_publication_does_not_adopt_or_change_web(self):
        self.install();self.f.preserved()
        target=self.f.private/'conversation/releases'/self.f.expected['archiveSha256']
        receipt=json.loads((target/'installation.json').read_bytes())
        self.assertEqual(receipt['component'],'conversation')
        self.assertEqual(receipt['schema'],'bellteam.conversation.installation.v1')
        self.assertEqual(list((self.f.private/'conversation').glob('.staging-*')),[])
        with self.assertRaisesRegex(ValueError,'GATEWAY_RELEASE_EXISTS'): self.install()
    def test_web_receipt_and_incompatible_state_are_rejected_before_publication(self):
        self.f.receipt['schema']='bellteam.web-gateway.verification.v1'
        with self.assertRaisesRegex(ValueError,'GATEWAY_INSTALL_RECEIPT'):self.install()
        self.manifest['runtime']['stateCompatibility']['readerContract']='unknown';self.make_archive()
        with self.assertRaisesRegex(ValueError,'GATEWAY_INSTALL_RECEIPT'):self.install()
        self.assertEqual(list((self.f.private/'conversation/releases').iterdir()),[])
    def test_conversation_component_lock_excludes_second_installer(self):
        import fcntl,os
        component=self.f.private/'conversation';component.mkdir()
        lock=os.open(component/'.install.lock',os.O_RDWR|os.O_CREAT,0o600)
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):self.install()
        finally:os.close(lock)

if __name__=='__main__':unittest.main()
