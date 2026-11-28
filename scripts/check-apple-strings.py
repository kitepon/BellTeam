#!/usr/bin/env python3
"""Fail when a user-facing Japanese string literal is not extracted into Localizable.xcstrings.
usage: check-apple-strings.py <build dir holding *.stringsdata (recursive; all targets built)> [--list]
A literal counts as extracted when the compiler emitted it (Text/Button/Label..., String(localized:)) at that file:line.
Literals that are not user text go in ios/BellBot/string-literals-allowed.txt as 'path' (whole file) or 'path::text that appears on the line'."""
import json, re, sys, glob, os
root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
app = os.path.join(root, 'ios/BellBot')
data_dir = sys.argv[1]
extracted = set()
for f in glob.glob(os.path.join(data_dir, '**', '*.stringsdata'), recursive=True):
    d = json.load(open(f))
    for table in d.get('tables', {}).values():
        for e in table:
            extracted.add((d['source'], e['location']['startingLine']))
allowed = set()
ap = os.path.join(app, 'string-literals-allowed.txt')
if os.path.exists(ap):
    allowed = {l.split('#')[0].strip() for l in open(ap) if l.split('#')[0].strip()}
lit = re.compile(r'"(?:[^"\\\n]|\\.)*[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef](?:[^"\\\n]|\\.)*"')
bad = []
# calls whose strings are logs, ids or wire values, never shown to the user
quiet = re.compile(r'(logger\.|Logger\(|print\(|NSLog|fatalError|assert|precondition|accessibilityIdentifier|identifier:|os_log|BellDiagnostics\.|\blog\()')
for sub in ('BellBot', 'Shared', 'ShareExtension', 'NotificationService'):
    for dp, _, fs in os.walk(os.path.join(app, sub)):
        for fn in fs:
            if not fn.endswith('.swift'): continue
            p = os.path.join(dp, fn); rel = os.path.relpath(p, root)
            if rel in allowed: continue
            for i, line in enumerate(open(p, encoding='utf-8'), 1):
                s = line.strip()
                if s.startswith('//') or s.startswith('///'): continue
                code = re.sub(r'//.*$', '', line) if '"' not in line.split('//')[0][-1:] else line
                if lit.search(code) and not quiet.search(code) and 'String(localized:' not in code and (p, i) not in extracted and not any(a.startswith(rel + '::') and a.split('::', 1)[1] in line for a in allowed):
                    bad.append(f'{rel}:{i}: {s[:110]}')
if '--list' in sys.argv or bad:
    print('\n'.join(bad))
print(f'{len(bad)} hard-coded Japanese literal line(s) not in the string catalog')
sys.exit(1 if bad else 0)
