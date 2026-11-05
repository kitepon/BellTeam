import { createSeatProcessRunner } from '../seat-process.mjs'

// Fixed source, never a caller-supplied Python program or shell fragment.
const remoteProgram = String.raw`
import json,sys,urllib.request,urllib.error
receipt={'schema':'bellteam.submitted-secret-input.v1','outcome':'unknown','authStatus':None,'httpStatus':None}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
try:
    raw=sys.stdin.buffer.read(32769)
    if len(raw)>32768: raise ValueError()
    payload=json.loads(raw)
    if not isinstance(payload,dict) or set(payload)!={'binding','prompt_digest','response'}: raise ValueError()
    response=payload['response']
    if not isinstance(response,dict) or set(response)!={'kind','value'} or response['kind']!='authorization_code': raise ValueError()
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    request=urllib.request.Request('http://127.0.0.9:18891/api/setup/auth/input',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'},method='POST')
    try:
        with opener.open(request,timeout=60) as answer:
            receipt['httpStatus']=answer.status
            body=answer.read(32769)
            if len(body)>32768: raise ValueError()
            parsed=json.loads(body)
            status=parsed.get('auth',{}).get('status')
            if status not in ('authenticated','waiting','blocked','failed'): raise ValueError()
            if parsed.get('harness')!='claude': raise ValueError()
            receipt['authStatus']=status
            if 200<=answer.status<300: receipt['outcome']='issued'
    except urllib.error.HTTPError as error:
        receipt['httpStatus']=error.code
        error.close()
except BaseException:
    pass
sys.stdout.write(json.dumps(receipt,separators=(',',':'))+'\n')
`
const remoteCommand = "python3 -c '" + remoteProgram.replaceAll("'", "'\\''") + "'"
const sshArgs = Object.freeze(['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-l', 'kite', 'rabbit', remoteCommand])
const unknown = () => ({ schema: 'bellteam.submitted-secret-input.v1', outcome: 'unknown', authStatus: null, httpStatus: null })

export function createSubmittedSecretRabbitClient({ project, run = createSeatProcessRunner(project, { environment: 'base' }) }) {
  return async (payload, { signal, assertBeforeIssue }) => {
    const input = Buffer.from(JSON.stringify(payload))
    try {
      assertBeforeIssue()
      const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(75000)])
      const output = await run('/usr/bin/ssh', [...sshArgs], { input, signal: boundedSignal, maxBuffer: 4096 })
      if (output.stderr !== '') return unknown()
      return JSON.parse(output.stdout)
    } catch { return unknown() }
    finally { input.fill(0) }
  }
}
