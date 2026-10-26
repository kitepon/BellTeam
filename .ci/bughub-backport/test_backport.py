import copy
import io
import json
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch

import candidate as c


class BackportBoundaries(unittest.TestCase):
    def base(self):
        return json.loads((c.BASE/'base-anonymous/amd64-config.json').read_text())

    def updated(self):
        before=self.base();after=copy.deepcopy(before)
        after['rootfs']['diff_ids'].append('sha256:'+'f'*64)
        after['history'].append({'created_by':'COPY module'})
        after['config']['Labels']=c.labels(before['config'].get('Labels'))
        return before,after

    def layer(self,extra=None,link=False):
        target=io.BytesIO()
        with tarfile.open(fileobj=target,mode='w:gz') as archive:
            raw=(c.BASE/'patched-module.mjs').read_bytes()
            member=tarfile.TarInfo('app/src/bughub-security.mjs');member.mode=0o644
            member.size=len(raw)
            if link:member.type=tarfile.SYMTYPE;member.linkname='/private';member.size=0
            archive.addfile(member,None if link else io.BytesIO(raw))
            if extra:
                member=tarfile.TarInfo(extra);member.mode=0o644;member.size=1
                archive.addfile(member,io.BytesIO(b'x'))
        return target.getvalue()

    def test_only_one_file_layer_is_accepted(self):
        c.one_file_layer(self.layer())
        for extra in ['app/package.json','app/src/another.mjs','app/.wh.src']:
            with self.subTest(extra=extra),self.assertRaises(ValueError):c.one_file_layer(self.layer(extra))
        with self.assertRaises(ValueError):c.one_file_layer(self.layer(link=True))

    def test_only_provenance_and_one_diff_id_can_change(self):
        before,after=self.updated();c.config_delta(before,after)
        for change in ('env','rootfs','history','cmd'):
            value=copy.deepcopy(after)
            if change=='env':value['config']['Env'].append('SECRET=x')
            elif change=='rootfs':value['rootfs']['diff_ids'][0]='sha256:'+'a'*64
            elif change=='history':value['history'][0]={'created_by':'other'}
            else:value['config']['Cmd']=['different']
            with self.subTest(change=change),self.assertRaises(ValueError):c.config_delta(before,value)

    def test_finite_unique_candidate_tags(self):
        self.assertIn(c.SOURCE,c.tag('123','amd64'))
        for run in ['latest','stable','12;false']:
            with self.assertRaises(ValueError):c.tag(run)
        with self.assertRaises(ValueError):c.tag('12','other')

    def test_publish_without_delta_probe_and_cleanup_never_calls_docker(self):
        with patch.object(c.f,'STATE',{}),patch.object(c.f,'command') as call:
            with self.assertRaises(ValueError):c.publish('amd64','123')
            call.assert_not_called()

    def test_extra_product_file_is_rejected_before_packaging_or_build(self):
        with patch.object(c.f,'command') as call:
            call.return_value.read_text.return_value='src/bughub-security.mjs\npackage.json\n'
            with self.assertRaisesRegex(ValueError,'BACKPORT_SOURCE_SCOPE'):c.source_check()
            self.assertEqual(call.call_count,1)

    def test_index_requires_both_arch_artifacts(self):
        with patch.object(c.f,'ROOT',Path('/path-that-does-not-exist')),patch.object(c.f,'command') as call:
            with self.assertRaises(ValueError):c.index('123')
            call.assert_not_called()


if __name__=='__main__':unittest.main(defaultTest='BackportBoundaries',verbosity=2)
