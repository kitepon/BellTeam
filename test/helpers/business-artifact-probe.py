#!/usr/bin/env python3
"""Closed usage/diagnostics unsigned probe; dedicated disposable native runner only."""
import importlib.util
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('members-artifact-probe.py'))
probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] not in ('usage', 'diagnostics'): raise SystemExit('MODULE_PROBE_ARGUMENTS')
    component = sys.argv.pop(1)
    probe.main(component)
