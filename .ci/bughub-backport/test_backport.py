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
        metadata={'app':dict(uid=0,gid=0,mode=0o755),'app/src':dict(uid=0,gid=0,mode=0o755),
                  'app/'+c.MODULE:dict(uid=0,gid=0,mode=0o644)}
        c.one_file_layer(self.layer(),metadata)
        for extra in ['app/package.json','app/src/another.mjs','app/.wh.src']:
            with self.subTest(extra=extra),self.assertRaises(ValueError):c.one_file_layer(self.layer(extra),metadata)
        with self.assertRaises(ValueError):c.one_file_layer(self.layer(link=True),metadata)

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


class MetadataDeltaTests(unittest.TestCase):
    def metadata(self,uid):
        return {'app':dict(uid=uid,gid=uid,mode=0o755),'app/src':dict(uid=uid,gid=uid+1,mode=0o750),
                'app/'+c.MODULE:dict(uid=uid,gid=uid+2,mode=0o640)}

    def layer(self,metadata):
        result=io.BytesIO()
        with tarfile.open(fileobj=result,mode='w:gz') as archive:
            for name,value in metadata.items():
                member=tarfile.TarInfo(name);member.uid=value['uid'];member.gid=value['gid'];member.mode=value['mode']
                if name=='app/'+c.MODULE:
                    raw=(c.BASE/'patched-module.mjs').read_bytes();member.size=len(raw);archive.addfile(member,io.BytesIO(raw))
                else:member.type=tarfile.DIRTYPE;archive.addfile(member)
        return result.getvalue()

    def test_observed_root_and_nonroot_values_drive_copy_and_layer(self):
        for uid in (0,1000):
            with self.subTest(uid=uid):
                metadata=self.metadata(uid)
                self.assertIn('--chown='+str(uid)+':'+str(uid+2)+' --chmod=0640',c.copy_instruction(metadata))
                c.one_file_layer(self.layer(metadata),metadata)

    def test_module_or_parent_metadata_change_is_rejected(self):
        original=self.metadata(1000)
        for name in original:
            for key in ('uid','gid','mode'):
                changed=copy.deepcopy(original);changed[name][key]+=1
                with self.subTest(path=name,field=key),self.assertRaises(ValueError):
                    c.one_file_layer(self.layer(changed),original)

    def test_binding_hash_arch_run_and_config_are_required(self):
        row=c.PLAN['baseBinding']['architectures']['amd64']
        record={'schema':'bellteam.bughub-base-metadata.v1','baseIndex':c.PLAN['base'],
            'baseManifest':row['manifest'],'baseConfig':row['config'],'arch':'amd64','run':'12',
            'ciHead':'f'*40,'baseModuleSHA256':c.PLAN['baseModuleSHA256'],
            'metadata':self.metadata(1000),'probeSHA256':'a'*64}
        raw=json.dumps(record).encode()
        with patch.object(c.f,'STATE',{'ciHead':'f'*40}):
            self.assertEqual(c.validate_binding(raw,c.digest(raw),'amd64','12'),record)
            for field in ('arch','run','baseConfig'):
                changed=dict(record);changed[field]='other';body=json.dumps(changed).encode()
                with self.subTest(field=field),self.assertRaises(ValueError):
                    c.validate_binding(body,c.digest(body),'amd64','12')
            with self.assertRaises(ValueError):c.validate_binding(raw+b' ',c.digest(raw),'amd64','12')


if __name__=='__main__':unittest.main(defaultTest='BackportBoundaries',verbosity=2)
