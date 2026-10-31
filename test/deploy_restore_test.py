import importlib.util,pathlib,tempfile,unittest,unittest.mock,io,json,sys,os
spec=importlib.util.spec_from_file_location('restore',pathlib.Path(__file__).resolve().parents[1]/'scripts/save-deploy-restore-point.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Checks(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.p=pathlib.Path(self.tmp.name)
 def test_stream_digest_and_actual_readback(self):
  p=self.p/'image.tar';v=m.archive(p,[sys.executable,'-c','import sys;sys.stdout.buffer.write(b"image-bytes")'],rate=0)
  self.assertEqual(p.read_bytes(),b'image-bytes');self.assertEqual(v['bytes'],11);self.assertEqual(p.stat().st_mode&0o777,0o600);self.assertFalse(p.with_suffix('.tar.partial').exists())
 def test_failed_producer_is_not_published_and_partial_is_cleaned(self):
  p=self.p/'image.tar'
  with self.assertRaises(RuntimeError):m.archive(p,[sys.executable,'-c','import sys;print("partial");sys.exit(17)'],rate=0)
  self.assertFalse(p.exists());self.assertFalse(p.with_suffix('.tar.partial').exists())
 def test_corrupt_readback_refused(self):
  p=self.p/'image.tar';real=m.copy_hash
  def changed(source,target=None,rate=0):
   v=real(source,target,0)
   if target is None:v['sha256']='0'*64
   return v
  with unittest.mock.patch.object(m,'copy_hash',side_effect=changed):
   with self.assertRaises(RuntimeError):m.archive(p,[sys.executable,'-c','print("image")'],rate=0)
  self.assertFalse(p.exists());self.assertFalse(p.with_suffix('.tar.partial').exists())
 def test_same_image_is_saved_once_and_tampered_blob_refused(self):
  calls=[]
  def run(p,cmd):calls.append(cmd);return m.archive(p,[sys.executable,'-c','print("same-image")'],rate=0)
  image='sha256:'+'a'*64;a=m.image_blob(self.p,image,run);b=m.image_blob(self.p,image,run)
  self.assertFalse(a['reused']);self.assertTrue(b['reused']);self.assertEqual(len(calls),1)
  pathlib.Path(a['path']).write_bytes(b'changed')
  with self.assertRaises(RuntimeError):m.image_blob(self.p,image,run)
  self.assertEqual(len(calls),1)
 def test_mount_refusal_creates_no_local_backup(self):
  with unittest.mock.patch.object(m,'BASE',self.p/'missing'/'backup'),unittest.mock.patch.object(m,'mount_guard',side_effect=RuntimeError('NAS unavailable')):
   with self.assertRaises(RuntimeError):m.main()
  self.assertEqual(list(self.p.iterdir()),[])
 def test_redirect_rejected(self):
  (self.p/'real').mkdir();(self.p/'link').symlink_to(self.p/'real',target_is_directory=True)
  with self.assertRaises(RuntimeError):m.mount_guard(self.p/'link')
 def test_same_cid_full_cursor_volume_can_restore_symlink_and_mode(self):
  volume=self.p/'volume';(volume/'bin').mkdir(parents=True);(volume/'releases').mkdir();(volume/'state').mkdir();cli=volume/'releases'/'cli';cli.write_text('old-cli');cli.chmod(0o755);(volume/'bin'/'cursor-agent').symlink_to('../releases/cli');(volume/'state'/'keep.json').write_text('{"latest":true}')
  script=pathlib.Path(__file__).resolve().parents[1]/'scripts/archive-live-volume.py';tar=self.p/'cursor.tar';m.archive(tar,[sys.executable,str(script),'create',str(volume)],rate=0)
  restore=self.p/'restored';m.subprocess.run([sys.executable,str(script),'restore',str(tar),str(restore)],check=True,capture_output=True)
  self.assertEqual((restore/'releases'/'cli').read_text(),'old-cli');self.assertEqual((restore/'releases'/'cli').stat().st_mode&0o777,0o755);self.assertEqual(os.readlink(restore/'bin'/'cursor-agent'),'../releases/cli');self.assertEqual((restore/'state'/'keep.json').read_text(),'{"latest":true}')
 def test_retention_keeps_two_points_and_one_shared_image_blob(self):
  images=self.p/'images';images.mkdir();image='sha256:'+'b'*64
  def run(p,cmd):return m.archive(p,[sys.executable,'-c','print("shared-image")'],rate=0)
  blob=m.image_blob(images,image,run)
  for i in range(3):
   p=self.p/f'20261031T12300{i}.000000Z';p.mkdir();cursor=p/'cursor.tar';v=m.archive(cursor,[sys.executable,'-c',f'print("cursor-{i}")'],rate=0);m.json_save(p/'restore.json',{'image':blob,'cursor':{**v,'path':str(cursor)}})
  m.prune_points(self.p)
  self.assertFalse((self.p/'20261031T123000.000000Z').exists());self.assertTrue((self.p/'20261031T123001.000000Z'/'cursor.tar').exists());self.assertTrue((self.p/'20261031T123002.000000Z'/'cursor.tar').exists());self.assertTrue(pathlib.Path(blob['path']).exists())
 def test_changed_old_point_prevents_retirement(self):
  (self.p/'images').mkdir()
  for i in range(3):
   p=self.p/f'20261031T12300{i}.000000Z';p.mkdir();cursor=p/'cursor.tar';v=m.archive(cursor,[sys.executable,'-c','print("cursor")'],rate=0);m.json_save(p/'restore.json',{'image':{'image':'sha256:'+'b'*64},'cursor':{**v,'path':str(cursor)}})
  (self.p/'20261031T123000.000000Z'/'cursor.tar').write_bytes(b'replaced')
  with self.assertRaises(RuntimeError):m.prune_points(self.p)
  self.assertTrue((self.p/'20261031T123000.000000Z'/'cursor.tar').exists())
 def test_image_cleanup_retains_stopped_container_and_rollback_and_other_products(self):
  spec=importlib.util.spec_from_file_location('image_cleanup',pathlib.Path(__file__).resolve().parents[1]/'scripts/cleanup-deploy-images.py');cleanup=importlib.util.module_from_spec(spec);spec.loader.exec_module(cleanup)
  def image(id,tag,created='2026-10-01T00:00:00Z'):return {'Id':id,'RepoTags':[tag],'Created':created}
  images=[image('live','ghcr.io/kitepon/bellteam-server:latest'),image('stopped','bellteam-server:old'),image('rollback','bellteam-rollback:previous'),image('obsolete','ghcr.io/kitepon/bellteam-server:retired'),image('other','relay:latest'),image('cloud1','bellteam/cloudflared:old'),image('cloud2','bellteam/cloudflared:recent','2026-10-02T00:00:00Z')]
  self.assertEqual({x['Id'] for x in cleanup.select(images,{'live','stopped'},'rollback')},{'obsolete','cloud1'})
  images[3]['RepoTags'].append('other-product:shared')
  self.assertEqual({x['Id'] for x in cleanup.select(images,{'live','stopped'},'rollback')},{'cloud1'})
 def test_bad_retained_image_preserves_older_complete_point_and_blob(self):
  images=self.p/'images';images.mkdir();blobs=[]
  for i in range(3):
   image='sha256:'+str(i+1)*64
   def run(p,cmd):return m.archive(p,[sys.executable,'-c',f'print("image-{i}")'],rate=0)
   blob=m.image_blob(images,image,run);blobs.append(blob)
   p=self.p/f'20261031T12300{i}.000000Z';p.mkdir();cursor=p/'cursor.tar';v=m.archive(cursor,[sys.executable,'-c',f'print("cursor-{i}")'],rate=0);m.json_save(p/'restore.json',{'image':blob,'cursor':{**v,'path':str(cursor)}})
  second=pathlib.Path(blobs[1]['path']);original=second.read_bytes();second.write_bytes(b'corrupt-previous')
  with self.assertRaises(RuntimeError):m.prune_points(self.p)
  self.assertTrue(pathlib.Path(blobs[0]['path']).exists());self.assertTrue((self.p/'20261031T123000.000000Z'/'cursor.tar').exists())
  with self.assertRaises(RuntimeError):m.validated_points(self.p)
  second.unlink()
  with self.assertRaises((RuntimeError,FileNotFoundError)):m.prune_points(self.p)
  self.assertTrue(pathlib.Path(blobs[0]['path']).exists())
 def test_empty_successful_producer_is_not_a_restore_point(self):
  p=self.p/'empty.tar'
  with self.assertRaises(RuntimeError):m.archive(p,[sys.executable,'-c','pass'],rate=0)
  self.assertFalse(p.exists());self.assertFalse(p.with_suffix('.tar.partial').exists())
if __name__=='__main__':unittest.main()
