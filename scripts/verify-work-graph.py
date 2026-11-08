#!/usr/bin/env python3
"""Authenticate the fixed work-graph component; never install or adopt it."""
import sys
from module_artifact_verifier import main

if __name__ == '__main__':
    try:
        main('work-graph')
    except Exception:
        print('WORK_GRAPH_VERIFICATION_FAILED', file=sys.stderr)
        raise SystemExit(1)
