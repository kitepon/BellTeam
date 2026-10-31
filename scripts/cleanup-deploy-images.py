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
            current = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image['Id']]))[0]
            if current.get('RepoTags') != image.get('RepoTags') or family(current) != family(image):
                raise RuntimeError('image tags changed before cleanup')
            refs = sorted(image['RepoTags'], key=lambda ref: ('@' not in ref, ref))
            subprocess.run(['docker', 'image', 'rm', '--no-prune', *refs], check=True)
            removed.append({'image': image['Id'], 'tags': image['RepoTags']})
        print(json.dumps({'rollback': rollback, 'protectedContainerImages': sorted(before), 'removed': removed}))



if __name__ == '__main__':
    main()
