"""Offline fixtures for the separate runtime catalog supply boundary."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('prepare_runtime_catalog', ROOT / 'scripts/prepare-runtime-catalog.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def codex_release():
    source = 'a' * 40
    archive = 'c' * 64
    url = ('https://github.com/kitepon/BellTeam/releases/download/updates-20261108T000000Z/'
           f'runtime-codex-{source}-linux-amd64.tar.gz')
    return dict(componentId='runtime-codex', sourceCommit=source, versionId=archive,
                platform=dict(os='linux', arch='amd64'),
                artifact=dict(kind='archive', signerCommit='b' * 40,
                              archive=dict(url=url, sha256=archive, bytes=42),
                              bundle=dict(url=url + '.sigstore.json', sha256='d' * 64, bytes=41)),
                compatibility=dict(runtimeProtocol=1, nodeMajor=26, libc='glibc'), changes=['Fixture release.'])


def formal_metadata(release):
    artifact = release['artifact']
    return dict(tag_name='updates-20261108T000000Z', draft=False, prerelease=False,
                assets=[dict(name=Path(artifact[kind]['url']).name, size=artifact[kind]['bytes'],
                             digest='sha256:' + artifact[kind]['sha256']) for kind in ('archive', 'bundle')])


class RuntimeCatalogSupplyTest(unittest.TestCase):
    def test_empty_catalog_binds_exact_main_bytes_without_mutation(self):
        raw = b'{ "main": "exact bytes" }\n'
        original = raw[:]
        result = prepare.prepare_runtime_catalog(raw, [])
        self.assertEqual(result, dict(schema='bellteam.runtime-catalog.v1',
                                      catalogSha256=hashlib.sha256(raw).hexdigest(), releases=[]))
        self.assertEqual(raw, original)
        self.assertNotEqual(result['catalogSha256'], hashlib.sha256(raw.rstrip()).hexdigest())

    def test_formal_codex_row_and_closed_schema(self):
        raw = b'{"catalog":1}\n'
        row = codex_release()
        result = prepare.prepare_runtime_catalog(raw, [row], {'updates-20261108T000000Z': formal_metadata(row)})
        self.assertEqual(result['releases'], [row])
        self.assertEqual(result['catalogSha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(prepare.validate_formal_assets(row, formal_metadata(row)), 'updates-20261108T000000Z')
        for mutate in (
            lambda value: value['compatibility'].update(stateCompatibility={'invented': 1}),
            lambda value: value.update(unreviewed=True),
        ):
            broken = json.loads(json.dumps(row))
            mutate(broken)
            with self.assertRaises(ValueError):
                prepare.prepare_runtime_catalog(raw, [broken], {'updates-20261108T000000Z': formal_metadata(row)})

    def test_rejects_nonformal_or_mismatched_release_assets(self):
        row = codex_release()
        metadata = formal_metadata(row)
        for bad in ({**metadata, 'draft': True},
                    {**metadata, 'assets': [dict(metadata['assets'][0], size=0), metadata['assets'][1]]}):
            with self.assertRaises(ValueError):
                prepare.prepare_runtime_catalog(b'{}', [row], {'updates-20261108T000000Z': bad})


if __name__ == '__main__':
    unittest.main()
