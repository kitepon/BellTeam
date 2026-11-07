#!/usr/bin/env python3
"""Build one clean, native Node 26/glibc runtime closure archive."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform as host_platform
import posixpath
import re
import shutil
import subprocess
import tarfile
import tempfile

import runtime_update as runtime

SOURCE = re.compile(r'[a-f0-9]{40}')
VERSION = re.compile(r'\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?')
NODE = shutil.which('node') or '/usr/local/bin/node'
NPM = shutil.which('npm') or '/usr/local/bin/npm'
BASE_ENV = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'CI': '1'}
PLATFORMS = {
    'amd64': {'os': 'linux', 'arch': 'amd64', 'libc': 'glibc', 'nodeMajor': 26},
    'arm64': {'os': 'linux', 'arch': 'arm64', 'libc': 'glibc', 'nodeMajor': 26},
}
THROUGHLINE_APPROVED = '0.16.56'
MAX_ARCHIVE_BYTES = 512 * 1024 ** 2


def run(args, *, env, cwd, timeout=120, input=None):
    return subprocess.run(args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=timeout, check=True, input=input)


def package_env(home, prefix=None):
    user_npmrc = home / '.user-npmrc'
    global_npmrc = home / '.global-npmrc'
    user_npmrc.touch(exist_ok=True)
    global_npmrc.touch(exist_ok=True)
    env = {**BASE_ENV, 'HOME': str(home), 'npm_config_cache': str(home / '.npm'),
           'npm_config_update_notifier': 'false', 'npm_config_audit': 'false',
           'npm_config_fund': 'false', 'npm_config_yes': 'true',
           'npm_config_userconfig': str(user_npmrc), 'npm_config_globalconfig': str(global_npmrc),
           'npm_config_registry': 'https://registry.npmjs.org/', 'DISABLE_AUTOUPDATER': '1'}
    if prefix is not None:
        env['npm_config_prefix'] = str(prefix)
    return env


def npm_metadata(component, work, env):
    package = runtime.COMPONENTS[component]['package']
    raw = run([NPM, 'view', package + '@latest', 'version', 'dist', '--json'],
              env=env, cwd=work, timeout=90).stdout
    metadata = json.loads(raw)
    if type(metadata) is not dict or not VERSION.fullmatch(str(metadata.get('version', ''))):
        raise ValueError('npm latest did not resolve to a stable exact version')
    if component == 'runtime-throughline' and metadata['version'] != THROUGHLINE_APPROVED:
        raise ValueError('Throughline latest differs from the accepted 0.16.56 compatibility decision')
    integrity = metadata.get('dist', {}).get('integrity')
    if type(integrity) is not str or not integrity.startswith('sha512-'):
        raise ValueError('npm latest metadata has no sha512 integrity')
    return package, metadata, integrity


def inspect_prefix(prefix):
    """Return manifest files without following links or changing package bytes."""
    root = prefix.resolve()
    files = []
    for path in sorted(prefix.rglob('*'), key=lambda p: p.relative_to(prefix).as_posix()):
        rel = 'prefix/' + path.relative_to(prefix).as_posix()
        if path.is_symlink():
            target = os.readlink(path)
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(rel), target))
            if target.startswith('/') or (resolved != 'prefix' and not resolved.startswith('prefix/')):
                raise ValueError('prefix contains an escaping symlink: ' + rel)
            files.append({'path': rel, 'type': 'symlink', 'target': target})
        elif path.is_file():
            mode = 0o555 if path.stat().st_mode & 0o111 else 0o444
            files.append({'path': rel, 'type': 'file', 'bytes': path.stat().st_size,
                          'sha256': sha256_file(path), 'mode': mode})
        elif not path.is_dir():
            raise ValueError('prefix contains a special file: ' + rel)
    # The public extractor only creates parent directories for leaf records.
    if not root.is_dir() or not files:
        raise ValueError('npm prefix is empty')
    return files


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def write_archive(prefix, manifest, output):
    raw_manifest = (json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode()
    with tarfile.open(output, 'w:gz', format=tarfile.PAX_FORMAT) as archive:
        first = tarfile.TarInfo('manifest.json')
        first.mode = 0o444
        first.size = len(raw_manifest)
        archive.addfile(first, io.BytesIO(raw_manifest))
        for item in manifest['files']:
            name = item['path']
            member = tarfile.TarInfo(name)
            if item['type'] == 'symlink':
                member.type = tarfile.SYMTYPE
                member.linkname = item['target']
                member.mode = 0o777
                archive.addfile(member)
            else:
                source = prefix / PurePosixPath(name).relative_to('prefix')
                member.size = item['bytes']
                member.mode = item['mode']
                with source.open('rb') as stream:
                    archive.addfile(member, stream)
    return raw_manifest


def probe_throughline(binary, temp, env):
    root = temp / 'throughline-probe'
    project = root / 'project'
    project.mkdir(parents=True)
    env.update({'HOME': str(root), 'USERPROFILE': str(root), 'CODEX_HOME': str(root / 'codex'),
                'XDG_STATE_HOME': str(root / 'state'), 'LOCALAPPDATA': str(root / 'state')})
    version = run([str(binary), '--version'], env=env, cwd=project, timeout=10)
    if version.stderr or version.stdout.strip() != THROUGHLINE_APPROVED:
        raise ValueError('Throughline version probe did not report exactly 0.16.56')

    def check(after):
        request = {'schema': 'throughline.observer_check_request.v1',
                   'projects': [{'id': 'runtime-package', 'projectPath': str(project), 'after': after}]}
        result = run([str(binary), 'observer-check', '--json'], env=env, cwd=project,
                     input=json.dumps(request), timeout=10)
        if result.stderr:
            raise ValueError('Throughline observer-check wrote stderr')
        return json.loads(result.stdout)

    first = check(None)
    rows = first.get('results', [])
    if (first.get('schema') != 'throughline.observer_check_result.v1' or first.get('status') != 'complete'
            or len(rows) != 1 or rows[0].get('id') != 'runtime-package' or rows[0].get('status') != 'changed'
            or not re.fullmatch(r'tloc1\..+', str(rows[0].get('token', '')))):
        raise ValueError('Throughline first observer-check was not changed')
    second = check(rows[0]['token'])
    expected = {**first, 'results': [{**rows[0], 'status': 'unchanged'}]}
    if second != expected:
        raise ValueError('Throughline second observer-check was not unchanged')
    if (root / '.throughline').exists() or (root / 'state').exists():
        raise ValueError('Throughline observer-check created a database/state path')
    return {'version': version.stdout.strip(), 'firstStatus': 'changed', 'secondStatus': 'unchanged',
            'databaseCreated': False}


def extract_and_probe(archive_path, manifest, source, platform, temp):
    extracted = temp / 'extracted'
    extracted.mkdir()
    receipt = {'component': manifest['component'], 'manifest': manifest,
               'manifestSha256': hashlib.sha256((json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode()).hexdigest()}
    # The runtime verifier compares parsed JSON to the manifest and hashes the exact first member bytes.
    with tarfile.open(archive_path, 'r:gz') as archive:
        raw = archive.extractfile(archive.next()).read()
        receipt['manifestSha256'] = hashlib.sha256(raw).hexdigest()
    runtime.extract(archive_path, receipt, {'sourceCommit': source}, extracted, platform)
    installed = extracted / 'prefix'
    home = temp / 'probe-home'
    home.mkdir()
    env = package_env(home)
    env['PATH'] = str(installed / 'bin') + ':' + BASE_ENV['PATH']
    node = run([NODE, '--version'], env=env, cwd=temp).stdout.strip()
    probes = {'nodeVersion': node}
    if manifest['component'] == 'runtime-throughline':
        probes['throughlineObserverCheck'] = probe_throughline(installed / 'bin/throughline', temp, env)
    elif manifest['component'] == 'runtime-aiterm-mcp':
        package_json = installed / 'lib/node_modules/aiterm-mcp/package.json'
        package_data = json.loads(package_json.read_text())
        entry = package_data.get('bin', {}).get('aiterm-mcp') if isinstance(package_data.get('bin'), dict) else package_data.get('bin')
        if not entry:
            raise ValueError('aiterm-mcp has no declared CLI entry')
        entry_path = package_json.parent / entry
        run([NODE, '--check', str(entry_path)], env=env, cwd=temp)
        probes['entrySyntax'] = str(entry)
        probes['packageVersion'] = package_data.get('version')
    else:
        binary = runtime.COMPONENTS[manifest['component']]['bins'][0]
        result = run([str(installed / 'bin' / binary), '--version'], env=env, cwd=temp)
        probes['versionOutput'] = (result.stdout + result.stderr).strip()[:500]
    modules = installed / 'lib/node_modules'
    pty_manifests = sorted(modules.rglob('node-pty/package.json')) if modules.exists() else []
    if pty_manifests:
        js = """const pty=require(process.argv[1]); const p=pty.spawn('/bin/sh',['-c','exit 0'],{name:'xterm',cols:80,rows:24,cwd:process.cwd(),env:process.env}); const t=setTimeout(()=>{try{p.kill()}catch{};process.exit(1)},5000); p.on('exit',()=>{clearTimeout(t);process.exit(0)});"""
        probes['nodePty'] = []
        for package_json in pty_manifests:
            pty_dir = package_json.parent
            pty_info = json.loads(package_json.read_text())
            run([NODE, '-e', js, str(pty_dir)], env=env, cwd=temp, timeout=10)
            probes['nodePty'].append({'path': pty_dir.relative_to(installed).as_posix(),
                                      'version': pty_info.get('version'), 'result': 'loaded-and-spawned'})
    else:
        probes['nodePty'] = []
    return probes


def build(component, output_path, source, arch):
    if component not in runtime.COMPONENTS:
        raise ValueError('component is not in runtime_update.COMPONENTS')
    if not SOURCE.fullmatch(source):
        raise ValueError('--source must be a 40-character lowercase commit SHA')
    if arch not in PLATFORMS:
        raise ValueError('--arch must be amd64 or arm64')
    expected_arch = {'amd64': 'x64', 'arm64': 'arm64'}[arch]
    if host_platform.machine() not in ({'amd64': ('x86_64', 'amd64'), 'arm64': ('aarch64', 'arm64')}[arch]):
        raise ValueError('builder host is not the requested native architecture')
    output_path = Path(output_path)
    stem = f'{component}-{source}-linux-{arch}'
    if output_path.name != f'{stem}.tar.gz':
        raise ValueError(f'archive filename must be exactly {stem}.tar.gz')
    receipt_path = output_path.with_name(f'{stem}.json')
    if output_path.exists() or receipt_path.exists():
        raise FileExistsError('runtime archive or sidecar receipt already exists')
    with tempfile.TemporaryDirectory(prefix='runtime-package-') as scratch:
        work = Path(scratch)
        home = work / 'home'
        prefix = work / 'prefix'
        home.mkdir(); prefix.mkdir()
        env = package_env(home, prefix)
        node_version = run([NODE, '--version'], env=env, cwd=work).stdout.strip()
        node_arch = run([NODE, '-p', 'process.arch'], env=env, cwd=work).stdout.strip()
        if not node_version.startswith('v26.') or node_arch != expected_arch:
            raise ValueError('builder must use native Node 26 for the requested architecture')
        ldd_result = run(['ldd', '--version'], env=env, cwd=work)
        ldd = ldd_result.stdout + ldd_result.stderr
        glibc = next((line.strip() for line in ldd.splitlines() if 'GNU libc' in line or 'GLIBC' in line.upper()), '')
        if not glibc:
            raise ValueError('builder must use glibc')
        package, upstream, integrity = npm_metadata(component, work, env)
        run([NPM, 'install', '--global', '--include=optional', '--prefix', str(prefix), '--no-audit', '--no-fund', f'{package}@{upstream["version"]}'],
            env=env, cwd=work, timeout=900)
        installed_manifest = prefix / 'lib/node_modules' / Path(*package.split('/')) / 'package.json'
        installed_package = json.loads(installed_manifest.read_text())
        if installed_package.get('name') != package or installed_package.get('version') != upstream['version']:
            raise ValueError('installed top-level package differs from the exact freshly resolved target')
        closure = json.loads(run([NPM, 'ls', '--global', '--all', '--json', '--prefix', str(prefix)],
                                 env=env, cwd=work, timeout=120).stdout)
        files = inspect_prefix(prefix)
        manifest = {'schema': runtime.ARTIFACT_SCHEMA, 'component': component, 'package': package,
                    'upstreamVersion': upstream['version'], 'sourceCommit': source,
                    'platform': PLATFORMS[arch], 'files': files}
        runtime.validate_manifest(manifest, component, {'sourceCommit': source}, PLATFORMS[arch])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        archive_path = output_path
        raw_manifest = write_archive(prefix, manifest, archive_path)
        if archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
            raise ValueError('runtime archive exceeds the consumer 512 MiB limit')
        probes = extract_and_probe(archive_path, manifest, source, PLATFORMS[arch], work)
        receipt = {'schema': 'bellteam.runtime.package-receipt.v1', 'component': component,
                   'package': package, 'sourceCommit': source, 'platform': PLATFORMS[arch],
                   'upstream': upstream, 'integrity': integrity, 'dependencyClosure': closure,
                   'runtime': {'node': node_version, 'nodeArch': node_arch, 'hostMachine': host_platform.machine(), 'glibc': glibc},
                   'probes': probes, 'manifestSha256': hashlib.sha256(raw_manifest).hexdigest(),
                   'archiveSha256': sha256_file(archive_path), 'archive': archive_path.name,
                   'manifest': manifest}
        receipt_path.write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        print(json.dumps({'archive': str(archive_path), 'receipt': str(receipt_path),
                          'archiveSha256': receipt['archiveSha256'], 'version': upstream['version']}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('component', choices=sorted(runtime.COMPONENTS))
    parser.add_argument('output', help='exact component-source-linux-architecture.tar.gz path')
    parser.add_argument('--source', required=True)
    parser.add_argument('--arch', required=True, choices=sorted(PLATFORMS))
    args = parser.parse_args()
    build(args.component, args.output, args.source, args.arch)


if __name__ == '__main__':
    main()
