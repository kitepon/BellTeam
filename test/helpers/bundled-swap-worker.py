"""Run one real bundled body swap the way the container worker does (CI only).

Started by bundled-swap-real.sh in a container launched exactly like
ContainerUpdater.launch_service: the OLD body image, root, the updater volume at
its prefix and its Mountpoint, the Docker socket. It calls the real
ContainerUpdater.install (execute_installer -> the old image's install.sh) with a
plan for the NEW image; only the catalog/plan/claim ledger is skipped, because the
new image is not in a signed catalog before promotion.
"""
import importlib.util
import json
import sys
import uuid

spec = importlib.util.spec_from_file_location('service', '/app/scripts/container-update-service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

reference, source = sys.argv[1:3]
updater = service.load()
# Progress only updates the ledger's job record, which this harness does not create.
updater.progress = lambda *_: None
current = updater.inspect_current()
updater.assert_model_binding(current)
identifier = str(uuid.uuid4())
plan = {'planId': identifier, 'expected': current,
        'target': {'componentId': 'container', 'sourceCommit': source, 'artifact': {'kind': 'oci-index', 'reference': reference}}}
directory = updater.state / 'operations' / identifier
directory.mkdir(mode=0o700, parents=True)
result = updater.install(plan, directory)
log = (directory / 'installer.log').read_text(errors='replace')
print(json.dumps({'result': {k: result[k] for k in ('execution', 'verification', 'cleanup', 'rollback', 'error')},
                  'installerLog': log[-20000:]}))
