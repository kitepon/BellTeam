import copy
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

class ContainerInspection(unittest.TestCase):
    def setUp(self):
        self.before = dict(id='container', image='image', pid=7, running=True, restarting=False,
            readOnly=True, user='1001:1001', mounts=[
                dict(Type='volume', Name='private', Source='/volumes/private/_data', Destination='/state',
                     Mode='z', RW=True, Propagation=''),
                dict(Type='bind', Source='/fixture', Destination='/fixture', Mode='ro', RW=False, Propagation='rprivate')],
            specMounts=[dict(Type='volume', Source='private', Target='/state', ReadOnly=False,
                             VolumeOptions=dict(NoCopy=True, Subpath='state')),
                        dict(Type='bind', Source='/fixture', Target='/fixture', ReadOnly=True)])

    def compare(self, before, after, error=None):
        original = copy.deepcopy([before, after])
        with tempfile.TemporaryDirectory() as t:
            if error:
                with self.assertRaisesRegex((AssertionError, ValueError), error):
                    m.compare_inspections(before, after, Path(t))
            else: m.compare_inspections(before, after, Path(t))
            self.assertEqual(json.loads((Path(t) / 'container-after.json').read_text()), after)
        self.assertEqual([before, after], original)

    def test_only_mount_order_is_ignored_and_raw_after_is_preserved(self):
        for fields in [('mounts',), ('specMounts',), ('mounts', 'specMounts')]:
            with self.subTest(fields=fields):
                after = copy.deepcopy(self.before)
                for field in fields: after[field].reverse()
                self.compare(self.before, after)

    def test_identity_mount_fields_nested_options_and_unknown_fields_are_compared(self):
        changes = [(('id',), 'new'), (('image',), 'new'), (('pid',), 8), (('running',), False),
                   (('restarting',), True), (('readOnly',), False), (('user',), '0:0')]
        for field in ['Type', 'Name', 'Source', 'Destination', 'Mode', 'RW', 'Propagation']:
            changes.append((('mounts', 0, field), False if field == 'RW' else '/changed' if field == 'Destination' else 'changed'))
        for field in ['Type', 'Source', 'Target', 'ReadOnly']:
            changes.append((('specMounts', 0, field), True if field == 'ReadOnly' else '/changed' if field == 'Target' else 'changed'))
        changes += [(('specMounts', 0, 'VolumeOptions', 'NoCopy'), False),
                    (('specMounts', 0, 'VolumeOptions', 'Subpath'), 'rooms'),
                    (('mounts', 0, 'futureOption'), 'new'), (('futureArray',), [2, 1])]
        for keys, value in changes:
            with self.subTest(keys=keys):
                after = copy.deepcopy(self.before); node = after
                for key in keys[:-1]: node = node[key]
                node[keys[-1]] = value
                self.compare(self.before, after, keys[0])
        before = dict(self.before, futureArray=[1, 2])
        self.compare(before, dict(before, futureArray=[2, 1]), 'futureArray')
        after = copy.deepcopy(self.before); del after['mounts'][0]['Mode']
        self.compare(self.before, after, 'mounts')

    def test_removed_duplicate_and_missing_targets_are_rejected_on_either_side(self):
        for field, key in [('mounts', 'Destination'), ('specMounts', 'Target')]:
            for mutation in ['removed', 'duplicate', 'missing', 'relative', 'null']:
                for side in ['before', 'after']:
                    with self.subTest(field=field, mutation=mutation, side=side):
                        changed = copy.deepcopy(self.before)
                        if mutation == 'removed': changed[field].pop()
                        elif mutation == 'duplicate': changed[field].append(copy.deepcopy(changed[field][0]))
                        elif mutation == 'missing': del changed[field][0][key]
                        else: changed[field][0][key] = None if mutation == 'null' else 'relative'
                        self.compare(changed if side == 'before' else self.before,
                                     changed if side == 'after' else self.before, field)

if __name__ == '__main__': unittest.main()
