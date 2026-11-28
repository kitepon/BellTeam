#!/usr/bin/env python3
"""Where each Apple UI string sits, for the translation step to fit text to the existing layout.
usage: apple-string-sites.py <build dir with *.stringsdata> <out.json>
Per catalog key: every call site (file, line) with the layout limits written on that view chain
(lineLimit, minimumScaleFactor, fixed frame width, fixedSize, truncation) read from the next lines of source.
Heuristic: limits not written in the chain (parent frames, container widths) are not seen; those strings carry limits=[]."""
import glob, json, os, re, sys
root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
data_dir, out = sys.argv[1], sys.argv[2]
pats = {
    'lineLimit': re.compile(r'\.lineLimit\(([^)]*)\)'),
    'minimumScaleFactor': re.compile(r'\.minimumScaleFactor\(([^)]*)\)'),
    'frameWidth': re.compile(r'\.frame\([^)]*?(?:width|maxWidth|minWidth):\s*([^,)]*)'),
    'fixedSize': re.compile(r'\.fixedSize\(([^)]*)\)'),
    'truncationMode': re.compile(r'\.truncationMode\(([^)]*)\)'),
}
src_cache = {}
def lines(p):
    if p not in src_cache:
        src_cache[p] = open(p, encoding='utf-8').read().split('\n') if os.path.exists(p) else []
    return src_cache[p]
sites = {}
for f in glob.glob(os.path.join(data_dir, '**', '*.stringsdata'), recursive=True):
    d = json.load(open(f))
    for table, entries in d.get('tables', {}).items():
        for e in entries:
            ls = lines(d['source']); i = e['location']['startingLine'] - 1
            chain = '\n'.join(ls[i:i + 8])
            limits = {k: m.group(1).strip() for k, p in pats.items() if (m := p.search(chain))}
            site = {'file': os.path.relpath(d['source'], root), 'line': i + 1, 'limits': limits}
            sites.setdefault(e['key'], [])
            if site not in sites[e['key']]: sites[e['key']].append(site)
json.dump(sites, open(out, 'w'), ensure_ascii=False, indent=1, sort_keys=True)
print(f'{len(sites)} strings, {sum(len(v) for v in sites.values())} sites, {sum(1 for v in sites.values() if any(s["limits"] for s in v))} with written limits -> {out}')
