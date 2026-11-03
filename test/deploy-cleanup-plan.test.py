import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).resolve().parents[1] / 'scripts/cleanup-deploy-images.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class PlanBoundary(unittest.TestCase):
    def test_missing_explicit_previous_fails_without_nas_fallback_or_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); (base / '.lock').touch()
            restore = SimpleNamespace(BASE=base, image_lock=contextlib.nullcontext, mount_guard=lambda _: None,
                validated_points=lambda _: (_ for _ in ()).throw(AssertionError('NAS fallback forbidden')))
            fake_spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _: None))
            with patch.object(cleanup.importlib.util, 'spec_from_file_location', return_value=fake_spec), \
                 patch.object(cleanup.importlib.util, 'module_from_spec', return_value=restore), \
                 patch.object(cleanup, 'inspected', return_value=None), \
                 patch.object(cleanup.subprocess, 'check_output') as docker, \
                 contextlib.redirect_stdout(io.StringIO()) as out:
                with self.assertRaisesRegex(RuntimeError, 'previous runtime image missing'):
                    cleanup.main(['--rollback-image', 'sha256:' + 'a' * 64])
                docker.assert_not_called()
                self.assertEqual(out.getvalue(), '')

    def test_actual_previous_is_protected_and_plan_is_flushed_before_failure(self):
        previous, stale, old, cloud = ['sha256:' + c * 64 for c in 'abcd']
        images = [dict(Id=previous, RepoTags=['bellteam-server:previous'], Created='1'),
                  dict(Id=stale, RepoTags=['bellteam-rollback:nas'], Created='1'),
                  dict(Id=old, RepoTags=['bellteam-server:old'], Created='1'),
                  dict(Id=cloud, RepoTags=['bellteam/cloudflared:latest'], Created='2')]
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); (base / '.lock').touch()
            restore = SimpleNamespace(BASE=base, image_lock=contextlib.nullcontext, mount_guard=lambda _: None,
                validated_points=lambda _: (_ for _ in ()).throw(AssertionError('normal mode must not select NAS rollback')))
            fake_spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _: None))
            class Output(io.StringIO):
                flushed = False
                def flush(self): self.flushed = True
            out = Output()
            def remove(image):
                self.assertTrue(out.flushed)
                plan = json.loads(out.getvalue().splitlines()[0])
                self.assertEqual(plan['rollback'], previous)
                self.assertIn(previous, plan['protectedImages'])
                self.assertIn(cloud, plan['protectedImages'])
                self.assertNotIn(previous, plan['targetImages'])
                raise RuntimeError('synthetic removal failure')
            def inspected(command, **_):
                return json.dumps(images).encode() if command[:3] == ['docker', 'image', 'inspect'] else old.encode()
            with patch.object(cleanup.importlib.util, 'spec_from_file_location', return_value=fake_spec), \
                 patch.object(cleanup.importlib.util, 'module_from_spec', return_value=restore), \
                 patch.object(cleanup, 'inspected', return_value=images[0]), \
                 patch.object(cleanup, 'references', return_value={'sha256:' + 'e' * 64}), \
                 patch.object(cleanup.subprocess, 'check_output', side_effect=inspected), \
                 patch.object(cleanup, 'remove_image', side_effect=remove), contextlib.redirect_stdout(out):
                with self.assertRaisesRegex(RuntimeError, 'synthetic removal failure'):
                    cleanup.main(['--rollback-image', previous])
            lines = [json.loads(line) for line in out.getvalue().splitlines()]
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]['schema'], 'bellteam.deploy-image-cleanup.plan.v1')
            self.assertEqual(lines[0]['rollbackSource'], 'caller-previous-runtime')
            self.assertEqual(set(lines[0]['targetImages']), {stale, old})
            self.assertNotIn('removed', lines[0])


if __name__ == '__main__':
    unittest.main()
