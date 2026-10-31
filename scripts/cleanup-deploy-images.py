"""Keep all container references and one rollback per BellTeam image family."""
import importlib.util
import fcntl
import json
from pathlib import Path
import subprocess

SERVER = {'ghcr.io/kitepon/bellteam-server', 'bellteam-server', 'bellteam-bellteam', 'bellteam-rollback'}
REPOS = SERVER | {'bellteam/cloudflared'}


def family(image):
    tags = image.get('RepoTags') or []
    repos = {tag.split('@', 1)[0].rsplit(':', 1)[0] for tag in tags}
    if not tags or not repos <= REPOS:
        return None
    return 'server' if repos <= SERVER else 'cloudflared' if repos == {'bellteam/cloudflared'} else None


def select(images, referenced, rollback):
    protected = set(referenced) | {rollback}
    cloud = sorted((image for image in images if family(image) == 'cloudflared' and image['Id'] not in protected), key=lambda image: image['Created'])
    if cloud:
        protected.add(cloud[-1]['Id'])
    return [image for image in images if family(image) and image['Id'] not in protected]


def references():
    ids = subprocess.check_output(['docker', 'ps', '-aq'], text=True).split()
    return {row['Image'] for row in json.loads(subprocess.check_output(['docker', 'container', 'inspect', *ids]))} if ids else set()


def inspected(image_id):
    result = subprocess.run(['docker', 'image', 'inspect', image_id], text=True, capture_output=True)
    if result.returncode == 1 and result.stderr.strip() == f'Error response from daemon: No such image: {image_id}':
        return None
    result.check_returncode()
    rows = json.loads(result.stdout)
    if len(rows) != 1 or rows[0]['Id'] != image_id:
        raise RuntimeError('image inspect identity mismatch')
    return rows[0]


def remove_image(image):
    original, attempted = set(image['RepoTags']), set()
    while True:
        current = inspected(image['Id'])
        if current is None:
            if not attempted:
                raise RuntimeError('image disappeared before cleanup')
            return {'image': image['Id'], 'tags': image['RepoTags'], 'commands': len(attempted)}
        if image['Id'] in references():
            raise RuntimeError('new container reference')
        tags = set(current.get('RepoTags') or [])
        if not tags <= original or family(current) != family(image):
            raise RuntimeError('image tags changed before cleanup')
        remaining = tags - attempted
        if not remaining:
            raise RuntimeError('image removal made no progress')
        ref = sorted(remaining, key=lambda value: ('@' not in value, value))[0]
        result = subprocess.run(['docker', 'image', 'rm', '--no-prune', ref], text=True, capture_output=True)
        print(json.dumps({'image': image['Id'], 'reference': ref, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}), flush=True)
        result.check_returncode()
        attempted.add(ref)


def main():
    spec = importlib.util.spec_from_file_location('restore', Path(__file__).with_name('save-deploy-restore-point.py'))
    restore = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(restore)
    restore.mount_guard(restore.BASE)
    with (restore.BASE / '.lock').open('r+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        points = restore.validated_points(restore.BASE)
        if not points:
            raise RuntimeError('no accepted rollback point')
        saved = points[-1][1]
        rollback = saved['image']['image']
        ids = set()
        for repo in sorted(REPOS):
            ids.update(subprocess.check_output(['docker', 'image', 'ls', '--no-trunc', '--quiet', repo], text=True).split())
        images = json.loads(subprocess.check_output(['docker', 'image', 'inspect', *sorted(ids)])) if ids else []
        before = references()
        plan = select(images, before, rollback)
        removed = []
        for image in plan:
            # Docker refuses a new container reference too; never force removal.
            if image['Id'] in references():
                continue
            removed.append(remove_image(image))
        print(json.dumps({'rollback': rollback, 'protectedContainerImages': sorted(before), 'removed': removed}))



if __name__ == '__main__':
    main()
