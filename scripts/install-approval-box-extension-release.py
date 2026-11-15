#!/usr/bin/env python3
"""Fixed approval-box-extension installer; caller cannot select a component or executable."""
import importlib.util
from pathlib import Path
import signal
import sys

spec = importlib.util.spec_from_file_location('gateway_installer', Path(__file__).with_name('install-web-gateway-release.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        installer.main('approval-box-extension')
    except (Exception, KeyboardInterrupt):
        print('APPROVAL_BOX_EXTENSION_INSTALL_FAILED', file=sys.stderr)
        sys.exit(1)
