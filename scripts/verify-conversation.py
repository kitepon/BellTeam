#!/usr/bin/env python3
"""Authenticate the fixed conversation component; never install or adopt it."""
import sys
from module_artifact_verifier import main

if __name__ == '__main__':
    try:
        main('conversation')
    except Exception:
        print('MEMBERS_VERIFICATION_FAILED', file=sys.stderr)
        raise SystemExit(1)
