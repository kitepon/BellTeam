import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('boundary', Path(__file__).parent / 'helpers/web-gateway-real-boundary.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class BoundaryInputs(unittest.TestCase):
    def zipped(self, names):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as z:
            for name, data in names: z.writestr(name, data)
        return stream.getvalue()

    def api(self, raw, *, digest=None):
        record = dict(name='expected', id=12, expired=False, size_in_bytes=len(raw), digest=digest or 'sha256:' + hashlib.sha256(raw).hexdigest())
        return [json.dumps(dict(artifacts=[record])).encode(), raw]

    def test_api_digest_and_size_bind_exact_zip_and_extracted_bytes(self):
        raw = self.zipped([('bundle.json', b'signed-bytes')])
        with tempfile.TemporaryDirectory() as t, patch.object(m, 'api', side_effect=self.api(raw)):
            p = Path(t) / 'artifact'; m.extract_artifact(1, 'expected', p)
            self.assertEqual((p / 'bundle.json').read_bytes(), b'signed-bytes')
            self.assertEqual((p / 'artifact.zip').read_bytes(), raw)
        with tempfile.TemporaryDirectory() as t, patch.object(m, 'api', side_effect=self.api(raw, digest='sha256:'+'0'*64)):
            with self.assertRaises(AssertionError): m.extract_artifact(1, 'expected', Path(t) / 'bad')

    def test_unsafe_archive_paths_and_duplicate_overwrite_are_rejected(self):
        for name in ['..', '../outside', '/absolute', 'nested/file', 'bad\\file', 'artifact.zip']:
            raw = self.zipped([(name, b'x')])
            with self.subTest(name=name), tempfile.TemporaryDirectory() as t, patch.object(m, 'api', side_effect=self.api(raw)):
                with self.assertRaises(AssertionError): m.extract_artifact(1, 'expected', Path(t) / 'bad')
        raw = self.zipped([('bundle.json', b'x'), ('bundle.json', b'y')])
        with tempfile.TemporaryDirectory() as t, patch.object(m, 'api', side_effect=self.api(raw)):
            with self.assertRaises(FileExistsError): m.extract_artifact(1, 'expected', Path(t) / 'bad')

    def test_mutable_or_foreign_image_and_foreign_cleanup_never_call_docker(self):
        with tempfile.TemporaryDirectory() as t, patch.object(m, 'execute') as execute:
            for image in ['latest', 'ghcr.io/kitepon/bellteam-server:main', 'ghcrxio/kitepon/bellteam-server@sha256:'+'a'*64]:
                with self.assertRaises(AssertionError): m.run_fixture(image, Path(t) / 'out', Path(t))
            save = Path(t) / 'allocation.json'
            save.write_text(json.dumps(dict(prefix='production', volumes=[], work='/srv/bellteam')))
            with self.assertRaises(AssertionError): m.cleanup(Path(t))
            execute.assert_not_called()

if __name__ == '__main__': unittest.main()
