#!/usr/bin/env python3
"""One bounded dependency install and complete Node test suite on a hosted VM."""
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

SOURCE = '3cb6ffe0f3f5ac93bd293428d0f53fdfcb24a1f3'
BRANCH = 'refs/heads/ci/centi-security-full-20261026'
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.ci/security-full/output'


def require_identity(env):
    if (env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or
            env.get('GITHUB_REF') != BRANCH or env.get('GITHUB_RUN_ATTEMPT') != '1' or
            env.get('CI_RUNNER_ENVIRONMENT') != 'github-hosted'):
        raise ValueError('CI_IDENTITY_REFUSED')


def clean_env(node, private):
    # Fixture scripts may prepend their own fake commands; these names deny real CLIs.
    return {'PATH': f'{private / "deny"}:{Path(node).parent}:/usr/bin:/bin',
            'HOME': str(private / 'home'), 'TMPDIR': str(private / 'tmp'),
            'LANG': 'C.UTF-8', 'CI': 'true', 'NODE_OPTIONS': '--max-old-space-size=256',
            'TESTGATE_FULL': '1', 'NPM_CONFIG_USERCONFIG': str(private / 'user.npmrc'),
            'NPM_CONFIG_GLOBALCONFIG': str(private / 'global.npmrc'), 'NPM_CONFIG_CACHE': str(private / 'npm-cache'),
            'NPM_CONFIG_REGISTRY': 'https://registry.npmjs.org/',
            'FORBIDDEN_CI_CALLS': str(private / 'forbidden.log')}


def full_argv(node, files):
    if not files or len(files) != len(set(files)):
        raise ValueError('FULL_FILE_SET_REFUSED')
    return [node, '--max-old-space-size=256', '--test', '--test-concurrency=1',
            '--test-reporter=tap', *sorted(files)]


def tap_totals(text):
    totals = {}
    for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
        matches = re.findall(r'^# ' + key + r' (\d+)\s*$', text, re.M)
        if len(matches) != 1:
            raise ValueError('FULL_TAP_INCOMPLETE')
        totals[key] = int(matches[0])
    if (totals['tests'] < 1 or totals['pass'] != totals['tests'] or
            any(totals[k] for k in ['fail', 'cancelled', 'skipped', 'todo'])):
        raise ValueError('FULL_NOT_ALL_PASS')
    return totals


def run():
    require_identity(os.environ)
    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / 'once.claim').open('x') as f:
        f.write(os.environ['GITHUB_RUN_ID'] + '\n')
    started = time.monotonic()
    result = {'source': SOURCE, 'ciHead': os.environ['GITHUB_SHA'], 'stages': [],
              'fullStarted': False, 'fullAccepted': False, 'productionActions': 0}
    try:
        subprocess.run(['git', 'merge-base', '--is-ancestor', SOURCE, 'HEAD'], check=True)
        changed = subprocess.check_output(['git', 'diff', '--name-only', SOURCE, 'HEAD'], text=True).splitlines()
        if any(p != '.github/workflows/publish-server-image.yml' and
               not p.startswith('.ci/security-full/') for p in changed):
            raise ValueError('PRODUCT_SOURCE_DRIFT')
        subprocess.run(['git', 'diff', '--exit-code', 'HEAD'], check=True)
        manifest = json.loads((ROOT / '.ci/security-full/source-manifest.json').read_text())
        for ref in manifest['productFiles']:
            if hashlib.sha256((ROOT / ref['path']).read_bytes()).hexdigest() != ref['sha256']:
                raise ValueError('PRODUCT_SHA_MISMATCH')
        node = shutil.which('node')
        npm = shutil.which('npm')
        if not node or not npm:
            raise ValueError('NODE_NPM_MISSING')
        private = OUT / 'private'
        for name in ['home', 'tmp', 'deny', 'npm-cache']:
            (private / name).mkdir(parents=True)
        for name in ['docker', 'ssh', 'aiterm', 'cursor-agent', 'claude', 'codex', 'grok']:
            path = private / 'deny' / name
            path.write_text('#!/bin/sh\nprintf "forbidden-command\\n" >> "$FORBIDDEN_CI_CALLS"\nexit 125\n')
            path.chmod(0o700)
        for name in ['user.npmrc', 'global.npmrc']:
            (private / name).write_text('')
        env = clean_env(node, private)
        mem = int(re.search(r'^MemAvailable:\s+(\d+)', Path('/proc/meminfo').read_text(), re.M)[1]) * 1024
        free = shutil.disk_usage(ROOT).free
        result['initialResources'] = {'memAvailableBytes': mem, 'diskFreeBytes': free}
        if mem < 2 * 1024**3 or free < 4 * 1024**3:
            raise ValueError('CI_RESOURCE_HEADROOM')
        result['nodeVersion'] = subprocess.check_output([node, '--version'], env=env, text=True).strip()
        if int(result['nodeVersion'].split('.')[0].lstrip('v')) != 26:
            raise ValueError('NODE_MAJOR_MISMATCH')
        files = sorted(glob.glob('test/*.test.mjs', root_dir=ROOT))
        result['fullFiles'] = files
        for stage, argv, limit in [
            ('npm-ci', [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 240),
            ('full', full_argv(node, files), 840),
        ]:
            remaining = min(limit, int(1140 - (time.monotonic() - started)))
            if remaining <= 0:
                raise ValueError('TOTAL_DEADLINE')
            record = {'stage': stage, 'argv': argv, 'limitSeconds': remaining,
                      'startedAt': time.time()}
            result['stages'].append(record)
            if stage == 'full':
                result['fullStarted'] = True
            with (OUT / (stage + '.log')).open('wb') as log:
                child = subprocess.Popen(['timeout', '--signal=TERM', '--kill-after=5s',
                                          str(remaining) + 's', *argv], cwd=ROOT, env=env,
                                         stdout=log, stderr=subprocess.STDOUT)
                record['pid'] = child.pid
                record['exitCode'] = child.wait()
            record['finishedAt'] = time.time()
            if record['exitCode'] != 0:
                raise ValueError('STAGE_FAILED_OR_TIMED_OUT')
            if (private / 'forbidden.log').exists():
                raise ValueError('FORBIDDEN_EXTERNAL_COMMAND')
        result['totals'] = tap_totals((OUT / 'full.log').read_text())
        result['fullAccepted'] = True
    except Exception as error:
        result['failureType'] = type(error).__name__
        result['failure'] = str(error) if isinstance(error, ValueError) else 'CI_FAILED'
    finally:
        result['durationSeconds'] = time.monotonic() - started
        (OUT / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        refs = [{'path': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                for p in OUT.iterdir() if p.is_file()]
        (OUT / 'artifact-index.json').write_text(json.dumps(refs, indent=2) + '\n')
    return 0 if result['fullAccepted'] else 1


if __name__ == '__main__':
    sys.exit(run())
