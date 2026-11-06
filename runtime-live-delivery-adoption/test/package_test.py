import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import os
import sys
from contextlib import redirect_stdout
from unittest.mock import patch

PRODUCT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('live_package', PRODUCT / 'package.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class SidecarTests(unittest.TestCase):
    def test_fixed_source_package_and_projected_export_rejection(self):
        with tempfile.TemporaryDirectory(prefix='.package-fixture-', dir=Path(__file__).parent) as work:
            root = Path(work)
            repo = root / 'repo'
            repo.mkdir()
            for name in ['src/adopter.mjs', 'src/client.mjs', 'profile/source.json', 'profile/aiterm-transport.mjs', 'profile/bot-session-state.mjs']:
                destination = repo / package.ROOT / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(PRODUCT / name, destination)
            subprocess.run(['git', 'init', '-q'], cwd=repo, check=True)
            subprocess.run(['git', 'add', package.ROOT], cwd=repo, check=True)
            subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], cwd=repo, check=True)
            source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
            archive = root / 'sidecar.tar.gz'
            result = package.build(repo, source, 'amd64', archive)
            self.assertEqual(result['sourceCommit'], source)
            self.assertEqual(result['manifest']['profile']['baseSourceCommit'], package.BASE)
            self.assertEqual(set(result['manifest']['files']), package.FILES)
            # Exercise CI-user ownership and shared-verifier wiring, without claiming a signature.
            shared_repo = Path(os.environ['BELLTEAM_SOURCE_REPO'])
            sys.path.insert(0, str(PRODUCT))
            sys.path.insert(0, str(shared_repo / 'scripts'))
            verify_spec = importlib.util.spec_from_file_location('live_verify', PRODUCT / 'verify.py')
            verify = importlib.util.module_from_spec(verify_spec)
            verify_spec.loader.exec_module(verify)
            verify.REPO = shared_repo
            bundle = root / 'bundle.json'
            bundle.write_text('{}')
            arguments = ['verify.py', str(archive), str(bundle), '--source', source, '--signer', source, '--arch', 'amd64']
            output = io.StringIO()
            with patch('module_artifact_verifier.verify_signature') as signature, patch.object(sys, 'argv', arguments), redirect_stdout(output):
                verify.main()
                self.assertEqual(signature.call_count, 1)
                self.assertEqual(signature.call_args.kwargs, dict(source=source, signer=source))
            verified = json.loads(output.getvalue())
            self.assertEqual(verified['archiveSha256'], result['archiveSha256'])
            self.assertEqual(verified['manifestSha256'], result['manifestSha256'])
            with self.assertRaises(ValueError):
                package.inspect_archive(archive, source, 'arm64')
            with tarfile.open(archive, 'r:gz') as original:
                content = {m.name: original.extractfile(m).read() for m in original}
            policy_name = 'policy/aiterm-transport.mjs'
            self.assertIn(b"export { AitermClient } from 'file:///app/src/aiterm-client.mjs'", content[policy_name])
            content[policy_name] = content[policy_name].replace(b'file:///app/src/aiterm-client.mjs', b'file:///tmp/aiterm-client.mjs')
            manifest = json.loads(content['manifest.json'])
            manifest['files'][policy_name] = dict(bytes=len(content[policy_name]), sha256=package.sha(content[policy_name]))
            content['manifest.json'] = json.dumps(manifest).encode()
            bad = root / 'wrong-projection.tar.gz'
            with tarfile.open(bad, 'w:gz', format=tarfile.USTAR_FORMAT) as output:
                for name, raw in content.items():
                    member = tarfile.TarInfo(name); member.mode = 0o444; member.size = len(raw)
                    output.addfile(member, io.BytesIO(raw))
            with self.assertRaises(ValueError):
                package.inspect_archive(bad, source, 'amd64')

    def test_fixed_projection_rejects_dynamic_and_outside_imports(self):
        for raw in [b"const x = import('./other.mjs')", b"import x from '../../outside.mjs'"]:
            with self.assertRaises(ValueError):
                package.project_imports(raw, 'aiterm-transport.mjs')


if __name__ == '__main__':
    unittest.main()
