#!/usr/bin/env python3
"""Authenticate the fixed execution component; never install or adopt it."""
import sys
from module_artifact_verifier import main

if __name__ == '__main__':
    try:
        main('execution')
    except Exception:
        print('EXECUTION_VERIFICATION_FAILED', file=sys.stderr)
        raise SystemExit(1)
