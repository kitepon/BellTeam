# 公開も本番操作もせず、同じ商用contextの実同梱物をnative runnerで検査する。
import hashlib
import json
import pathlib
import subprocess
import sys
import tarfile
import urllib.request

image, source, version, arch = sys.argv[1:]
workspace = pathlib.Path.cwd()
out = workspace/'runtime'/('commercial-native-'+arch)
out.mkdir(parents=True, exist_ok=True)
tools = pathlib.Path(__file__).resolve().parent
tests = workspace/'runtime/aiterm-source/test'
report = {'source': source, 'expected_aiterm': version, 'architecture': arch, 'published': False, 'cases': []}
def docker(args, label, timeout=180):
    result = subprocess.run(['docker', *args], text=True, capture_output=True, timeout=timeout)
    (out/(label+'.stdout.log')).write_text(result.stdout)
    (out/(label+'.stderr.log')).write_text(result.stderr)
    report['cases'].append({'name': label, 'exit': result.returncode})
    if result.returncode:
        raise RuntimeError(label+' exit '+str(result.returncode))
    return result.stdout
try:
    manifest = json.load(urllib.request.urlopen('https://registry.npmjs.org/aiterm-mcp/'+version))
    package = out/('aiterm-mcp-'+version+'.tgz')
    package.write_bytes(urllib.request.urlopen(manifest['dist']['tarball']).read())
    assert hashlib.sha256(package.read_bytes()).hexdigest() == '5c47b0640bc07262fc9362dca49d8c57d5e6d545181524938cb9da8263acda42'
    with tarfile.open(package) as tar:
        files = {m.name.removeprefix('package/'): hashlib.sha256(tar.extractfile(m).read()).hexdigest() for m in tar.getmembers() if m.isfile()}
    check = """const fs=require('fs'),c=require('crypto');const d=JSON.parse(fs.readFileSync('/app/distribution.json'));if(d.sourceCommit!==process.argv[2])throw Error('source');const pkg='/usr/local/lib/node_modules/aiterm-mcp/';if(JSON.parse(fs.readFileSync(pkg+'package.json')).version!==process.argv[3])throw Error('version');if(require('child_process').spawnSync('sh',['-c','command -v op']).status===0||fs.existsSync('/srv/bellteam/shared/tools/onepassword')||Object.keys(process.env).some(k=>/^(OP_|ONEPASSWORD_)/.test(k)))throw Error('owner-private OP input');let o={};for(const p of JSON.parse(process.argv[1]))o[p]=c.createHash('sha256').update(fs.readFileSync(pkg+p)).digest('hex');console.log(JSON.stringify(o))"""
    actual = json.loads(docker(['run','--rm','--network','none','--read-only','--entrypoint','node',image,'-e',check,json.dumps(list(files)),source,version], 'package-provenance'))
    assert actual == files
    report['matched_aiterm_files'] = len(files)
    report['op_entry_private_directory_and_op_env_absent'] = True
    script = """import os,pathlib,shutil
r=pathlib.Path('/tmp/native-tests');t=r/'test';t.mkdir(parents=True)
names=['execution-configure-host-native.test.mjs','execution-dispatch.test.mjs','execution-launch-reconcile.test.mjs','execution-launch-reconcile-native.test.mjs']
for n in ['seat-env.mjs',*names]:shutil.copyfile('/audit/'+n,t/n)
(r/'dist').symlink_to('/usr/local/lib/node_modules/aiterm-mcp/dist',target_is_directory=True)
(r/'node_modules').symlink_to('/usr/local/lib/node_modules/aiterm-mcp/node_modules',target_is_directory=True)
os.execv('/usr/local/bin/node',['node','--test',*[str(t/n)for n in names]])
"""
    docker(['run','--rm','--network','none','--read-only','--tmpfs','/tmp:exec,size=2g','--mount','type=bind,src='+str(tests)+',dst=/audit,readonly','--entrypoint','python3',image,'-c',script], 'management-native')
    docker(['run','--rm','--network','none','--read-only','--tmpfs','/tmp:exec,size=512m','--mount','type=bind,src='+str(tools)+',dst=/audit,readonly','--entrypoint','node',image,'/audit/commercial-receipt-generation.mjs','/usr/local/lib/node_modules/aiterm-mcp','fixed'], 'receipt-generation')
    details = json.loads(docker(['image','inspect',image], 'image'))[0]
    assert details['Architecture'] == arch
    report['image_id'] = details['Id']
    report['passed'] = True
except Exception as error:
    report['passed'] = False
    report['error'] = str(error)
    raise
finally:
    (out/'results.json').write_text(json.dumps(report, indent=2)+'\n')
    # 実行コードは正規registryの固定hashで照合し、成果物には証拠だけを残す。
    for package in out.glob('*.tgz'): package.unlink()
