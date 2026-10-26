class Held(RuntimeError):pass
def configured_ok(info,plan,expected_name):
 h=info['HostConfig'];lim=plan['limits'];labels=info['Config'].get('Labels',{})
 if info.get('Name','').lstrip('/')!=expected_name or labels.get('centi.run')!=plan['run'] or labels.get('centi.owner')!='bot-8bc1fb5d':raise Held('fixture ownership')
 if info['Config']['Image'] not in plan['allowedRefs']:raise Held('fixture image')
 if (h.get('Memory'),h.get('MemorySwap'),h.get('NanoCpus'),h.get('PidsLimit'))!=(lim['memory'],lim['memorySwap'],lim['nanoCpus'],lim['pids']):raise Held('configured resource mismatch')
 if not h.get('ReadonlyRootfs') or h.get('NetworkMode')!='none':raise Held('fixture isolation mismatch')
 return True
