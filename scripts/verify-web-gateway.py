#!/usr/bin/env python3
"""Authenticate the fixed Web gateway component; never install or adopt it."""
import sys
from module_artifact_verifier import authenticate, main, root_file

if __name__ == '__main__':
    try:
        main('web-gateway')
    except Exception:
        print('GATEWAY_VERIFICATION_FAILED', file=sys.stderr)
        raise SystemExit(1)
