"""Fixed draft inputs for the reviewed amd64 M parent candidate; never publishes."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

REPO = 'kitepon/BellTeam'
CLI_SOURCE = '9b9d2cc544228226be462fbbad0a9b961ee75eeb'
AITERM_SHA = '214fb376ef70ee47dfc11d362832b17d452350b80207333895cc521926bf3ca9'
CLI_FILES = {'bin/codex', 'bin/codex-code-mode-host', 'bin/codex-exec-server',
             'codex-path/rg', 'codex-resources/bwrap', 'codex-package.json'}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def manifest(value):
    require(type(value) is dict and set(value) == {'schema', 'ready', 'releaseId', 'nativeSource', 'cliVersion', 'cliPackageVersion', 'cli', 'aiterm'}, 'M_INPUT_SCHEMA')
    require(value['schema'] == 'bellteam.m-native-image-input.v1' and value['ready'] is True, 'M_INPUT_NOT_READY')
    require(value['nativeSource'] == CLI_SOURCE and isinstance(value['cliVersion'], str) and re.fullmatch(r'[0-9A-Za-z.+-]{1,100}', value['cliVersion']), 'M_CLI_IDENTITY')
    require(isinstance(value['cliPackageVersion'], str) and re.fullmatch(r'[0-9A-Za-z.+-]{1,100}', value['cliPackageVersion']), 'M_CLI_PACKAGE_VERSION')
    require(type(value['releaseId']) is int and value['releaseId'] > 0, 'M_RELEASE_ID')
    for key in ['cli', 'aiterm']:
        row = value[key]
        require(type(row) is dict and set(row) == {'id', 'bytes', 'sha256'}, 'M_ASSET_SCHEMA')
        require(type(row['id']) is int and row['id'] > 0 and type(row['bytes']) is int and 0 < row['bytes'] <= 2 * 1024**3, 'M_ASSET_SIZE_ID')
        require(isinstance(row['sha256'], str) and re.fullmatch('[a-f0-9]{64}', row['sha256']), 'M_ASSET_DIGEST')
    require(value['cli']['id'] != value['aiterm']['id'], 'M_ASSET_ALIAS')
    require(value['aiterm']['bytes'] == 771892 and value['aiterm']['sha256'] == AITERM_SHA, 'M_AITERM_IDENTITY')
    return value


def check_file(path, expected):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size == expected['bytes'], 'M_INPUT_SIZE')
    with path.open('rb') as stream:
        require(hashlib.file_digest(stream, 'sha256').hexdigest() == expected['sha256'], 'M_INPUT_DIGEST')


def release_identity(value, supplied):
    require(value.get('id') == supplied['releaseId'] and value.get('draft') is True, 'M_RELEASE_NOT_DRAFT')
    for row in [supplied['cli'], supplied['aiterm']]:
        matches = [item for item in value.get('assets', []) if item.get('id') == row['id']]
        require(len(matches) == 1 and matches[0].get('size') == row['bytes']
                and matches[0].get('digest') == 'sha256:' + row['sha256']
                and matches[0].get('state') == 'uploaded', 'M_RELEASE_ASSET_MISMATCH')


def api(path, output=None):
    command = ['gh', 'api', 'repos/' + REPO + '/' + path]
    if output is not None:
        command += ['-H', 'Accept: application/octet-stream']
    result = subprocess.run(command, stdout=output or subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        status = re.search(rb'HTTP (\d{3})', result.stderr)
        raise RuntimeError(json.dumps({'error': 'M_INPUT_FETCH_FAILED', 'endpoint': path,
                                      'httpStatus': int(status[1]) if status else None, 'exit': result.returncode}))
    return None if output is not None else json.loads(result.stdout)


def fetch(config, destination):
    value = manifest(json.loads(config.read_text()))
    release_identity(api('releases/' + str(value['releaseId'])), value)
    destination.mkdir(mode=0o700)
    for key, filename in [('cli', 'cli.tar.gz'), ('aiterm', 'aiterm.tgz')]:
        path = destination / filename
        with path.open('xb') as stream:
            api('releases/assets/' + str(value[key]['id']), stream)
        check_file(path, value[key])
    (destination / 'input.json').write_text(json.dumps(value) + '\n')


def cli_inventory(archive, version):
    members = archive.getmembers()
    require(len(members) <= 16 and len({m.name for m in members}) == len(members), 'M_CLI_INVENTORY')
    require(all((m.isfile() and m.name in CLI_FILES) or (m.isdir() and m.name.rstrip('/') in {'bin', 'codex-path', 'codex-resources'}) for m in members), 'M_CLI_PATH_TYPE')
    require({m.name for m in members if m.isfile()} == CLI_FILES and all(m.size <= 2 * 1024**3 for m in members), 'M_CLI_INVENTORY')
    metadata = json.load(archive.extractfile('codex-package.json'))
    require(metadata == dict(layoutVersion=1, version=version, target='x86_64-unknown-linux-gnu', variant='codex',
                             entrypoint='bin/codex', execServer='bin/codex-exec-server', resourcesDir='codex-resources', pathDir='codex-path'), 'M_CLI_PACKAGE_IDENTITY')
    return members


def install(inputs):
    value = manifest(json.loads((inputs / 'input.json').read_text()))
    for key, filename in [('cli', 'cli.tar.gz'), ('aiterm', 'aiterm.tgz')]:
        check_file(inputs / filename, value[key])
    prefix = Path('/opt/bellteam/native/codex-' + CLI_SOURCE + '/x86_64-unknown-linux-gnu/cli')
    with tarfile.open(inputs / 'cli.tar.gz') as archive:
        members = cli_inventory(archive, value['cliPackageVersion'])
        prefix.mkdir(parents=True, exist_ok=False)
        for member in members:
            if member.isfile():
                target = prefix / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as stream:
                    shutil.copyfileobj(archive.extractfile(member), stream)
                target.chmod(0o644 if member.name.endswith('.json') else 0o755)
    for relative in ['bin/codex', 'bin/codex-code-mode-host', 'bin/codex-exec-server', 'codex-resources/bwrap']:
        result = subprocess.run(['ldd', str(prefix / relative)], capture_output=True, text=True)
        require(result.returncode == 0 and 'not found' not in result.stdout + result.stderr, 'M_NATIVE_ABI_UNRESOLVED')
    link = Path('/usr/local/bin/codex')
    require(link.is_symlink(), 'M_NORMAL_CLI_ENTRY')
    link.unlink()
    link.symlink_to(prefix / 'bin/codex')
    with tempfile.TemporaryDirectory(prefix='bellteam-m-npm-') as cache:
        subprocess.run(['npm', 'install', '--global', '--prefix', '/usr/local', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, str(inputs / 'aiterm.tgz')], check=True)
        subprocess.run(['npm', 'ci', '--prefix', '/usr/local/lib/node_modules/aiterm-mcp', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], check=True)
    installed = Path('/usr/local/lib/node_modules/aiterm-mcp')
    with tarfile.open(inputs / 'aiterm.tgz') as archive:
        selected = [m for m in archive.getmembers() if m.isfile() and m.name.startswith('package/dist/') and m.name.endswith('.js')]
        require(len(selected) == 147, 'M_AITERM_CODE_INVENTORY')
        for member in [*selected, archive.getmember('package/npm-shrinkwrap.json')]:
            require((installed / member.name.removeprefix('package/')).read_bytes() == archive.extractfile(member).read(), 'M_AITERM_INSTALLED_CODE_LOCK')
    subprocess.run(['node', '-e', 'const p="/usr/local/lib/node_modules/aiterm-mcp"; if(require(p+"/node_modules/@modelcontextprotocol/sdk/package.json").version!=="1.32.2") process.exit(1)'], check=True)
    version = subprocess.check_output([str(link), '--version'], text=True).strip()
    require(version == 'codex-cli ' + value['cliVersion'], 'M_CLI_VERSION')
    for command in [['app-server', '--help'], ['resume', '--help']]:
        subprocess.run([str(link), *command], stdout=subprocess.DEVNULL, check=True)
    print(json.dumps({'nativeSource': CLI_SOURCE, 'cliVersion': value['cliVersion'], 'sdk': '1.32.2', 'normalCli': str(prefix / 'bin/codex'), 'actualRootSequence': False}))


if __name__ == '__main__':
    require(sys.argv[1] in ['fetch', 'install'], 'M_INPUT_COMMAND')
    if sys.argv[1] == 'fetch':
        fetch(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        require(os.getuid() == 0 and os.uname().machine == 'x86_64', 'M_IMAGE_PLATFORM')
        install(Path(sys.argv[2]))
