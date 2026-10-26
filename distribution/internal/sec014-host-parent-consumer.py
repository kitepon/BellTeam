"""Artificial same-actor raw persistence; no live authority factory or collector."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRODUCER_SHA = '885fa01e10660aedd51add1d88b844473c9a2c79b34d1b18edd004fc0c4ab8cf'
GATES = ('entry', 'run', 'run', 'inspect', 'inspect', 'remove', 'remove',
         'absence', 'absence', 'metadata', 'phase')
STAT_KEYS = ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink',
             'st_size','st_mtime_ns','st_ctime_ns')


def _module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE/filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


actor = _module('sec014_parent_actor', 'sec014-host-actor.py')
if hashlib.sha256((HERE/'sec014-host-parent.py').read_bytes()).hexdigest() != PRODUCER_SHA:
    raise actor.control.ControlError('SEC014_HOST_PRODUCER_SOURCE')
host = _module('sec014_parent_raw', 'sec014-host-parent.py')


class _Consumer:
    """Private artificial connector; observe never substitutes for a live collector."""
    def __init__(self, tx, binding_raw, policy_raw, observe, final_guard):
        self.tx, self.observe, self.final_guard = tx, observe, final_guard
        self.binding = host._load(binding_raw)
        self.producer = host._Producer(binding_raw, policy_raw)
        self.held, self.issued, self.generation, self.saved = False, None, 0, []
        self.previous = None
        self.slots, self.used = {}, set()
        if not callable(observe) or not callable(final_guard):
            raise actor.control.ControlError('SEC014_HOST_COLLECTOR_UNAVAILABLE')
        try:
            self.check()
            names = ['issued', 'terminal']
            names += [str(i)+'-'+kind for i in range(1,len(GATES)+1)
                      for kind in ('observation','external','effect-0','effect-1','status')]
            for name in names:
                filename = 'transaction-'+tx.value['direction']+'.host-parent-slot-'+name+'.json'
                fd = os.open(filename, os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,
                             0o600, dir_fd=tx.parent)
                self.slots[name] = (fd, filename, None)
                os.fsync(fd)
                metadata = os.fstat(fd)
                actor.control._private(metadata, tx.owner)
                if metadata.st_size != 0:
                    raise actor.control.ControlError('SEC014_HOST_SLOT_NOT_EMPTY')
                self.slots[name] = (fd, filename, tuple(getattr(metadata,k) for k in STAT_KEYS))
            os.fsync(tx.parent)
            actor._save_json(tx, 'transaction-'+tx.value['direction']+'.host-parent-slot-setup.json',
                {'schema':'bellteam.sec014.host-parent-slot-setup.v1','evidenceScope':'artificial-only',
                 'binding':self.binding,'gates':list(GATES),
                 'consumerSourceSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                 'slots':[{'name':name,'file':filename,'dev':str(metadata[0]),'ino':str(metadata[1])}
                          for name,(_,filename,metadata) in self.slots.items()]})
        except Exception:
            self.close()
            raise

    def close(self):
        for fd,_,_ in self.slots.values():
            os.close(fd)
        self.slots.clear()
        self.held = True

    def invalidate(self, reason):
        self.held = True
        try:
            self.producer.invalidate('unknown', reason)
        except host.HostParentError:
            pass
        item = self.producer.records().get('status')
        if item is not None and 'terminal' not in self.used:
            self._save_raw('terminal',item['raw'],item['ref'])

    def check(self):
        tx, binding = self.tx, self.binding
        tx.check()
        born = int(Path('/proc/self/stat').read_text().rsplit(') ', 1)[1].split()[19])
        if (self.held or tx.value['actorPid'] != os.getpid()
                or tx.value['actorStartTicks'] != born
                or binding['transactionId'] != tx.name
                or binding['direction'] != tx.value['direction']
                or binding['actorPid'] != str(os.getpid())
                or binding['actorStartTicks'] != str(born)
                or binding['lockIdentity'] != dict(zip(('dev', 'ino'), map(str, tx.lock_identity)))):
            raise actor.control.ControlError('SEC014_HOST_ACTOR_OR_LOCK')
        sources = {'actor': 'sec014-host-actor.py', 'producer': 'sec014-host-parent.py',
                   'executor': 'sec014-prepare-executor.py'}
        for key, name in sources.items():
            if hashlib.sha256((HERE/name).read_bytes()).hexdigest() != binding['sourcePins'][key]:
                raise actor.control.ControlError('SEC014_HOST_BOUND_SOURCE')
        compose = HERE.parents[1]/'compose.state-prepare.yaml'
        if hashlib.sha256(compose.read_bytes()).hexdigest() != binding['sourcePins']['compose']:
            raise actor.control.ControlError('SEC014_HOST_BOUND_SOURCE')

    def _save_raw(self, name, raw, ref=None):
        if type(raw) is not bytes or not 0 < len(raw) <= 65536:
            raise actor.control.ControlError('SEC014_HOST_RAW_ORIGINAL')
        sha = hashlib.sha256(raw).hexdigest()
        if ref is not None and ref['sha256'] != sha:
            raise actor.control.ControlError('SEC014_HOST_RAW_ORIGINAL')
        value = {'schema': 'bellteam.sec014.host-parent-raw-artifact.v1',
                 'evidenceScope': 'artificial-only', 'rawUtf8': raw.decode('utf-8'),
                 'rawSha256': sha, 'sourceRef': ref}
        wrapper = json.dumps(value,sort_keys=True,allow_nan=False).encode()
        fd,filename,empty = self.slots[name]
        if (name in self.used or len(wrapper)>65536
                or tuple(getattr(os.fstat(fd),k) for k in STAT_KEYS)!=empty
                or tuple(getattr(os.stat(filename,dir_fd=self.tx.parent,follow_symlinks=False),k)
                         for k in STAT_KEYS)!=empty):
            raise actor.control.ControlError('SEC014_HOST_SLOT_CHANGED_OR_USED')
        self.used.add(name)
        offset = 0
        while offset < len(wrapper):
            written = os.write(fd,wrapper[offset:])
            if written<=0:
                raise actor.control.ControlError('SEC014_HOST_SLOT_PARTIAL_WRITE')
            offset += written
        os.fsync(fd)
        metadata = os.fstat(fd)
        actor.control._private(metadata,self.tx.owner)
        expected = tuple(getattr(metadata,k) for k in STAT_KEYS)
        reopened = os.open(filename,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=self.tx.parent)
        try:
            observed = os.read(reopened,65537)
            if (observed!=wrapper or metadata.st_size!=len(wrapper)
                    or any(tuple(getattr(item,k) for k in STAT_KEYS)!=expected
                           for item in (os.fstat(fd),os.fstat(reopened),
                               os.stat(filename,dir_fd=self.tx.parent,follow_symlinks=False)))):
                raise actor.control.ControlError('SEC014_HOST_SLOT_READBACK')
        finally:
            os.close(reopened)
        wrapper_sha = hashlib.sha256(wrapper).hexdigest()
        self.saved.append({'artifactName': filename, 'rawSha256': sha,
                           'wrapperSha256': wrapper_sha})

    def __call__(self, step):
        try:
            self.check()
            if self.generation>=len(GATES) or step!=GATES[self.generation]:
                raise actor.control.ControlError('SEC014_HOST_FIXED_GATE_ORDER')
            observation, external, effects = self.observe(step)
            if self.issued is None:
                if step != 'entry' or effects != ():
                    raise actor.control.ControlError('SEC014_HOST_INITIAL_STEP')
                self.producer.issue(observation, external)
            else:
                self.producer.advance(step, observation, external, effects)
            records = self.producer.records()
            issued, status = records['issued'], records['status']
            value = host._load(status['raw'])
            sha = hashlib.sha256(issued['raw']).hexdigest()
            if (value['state'] != 'valid' or value['step'] != step
                    or value['generation'] != str(self.generation+1)
                    or value['previousStatusSha256'] != self.previous
                    or value['issuedSha256'] != sha
                    or self.issued is not None and sha != self.issued):
                raise actor.control.ControlError('SEC014_HOST_STATUS_CHAIN')
            generation = value['generation']
            self._save_raw(generation+'-observation', observation)
            self._save_raw(generation+'-external', external)
            for index, raw in enumerate(effects):
                self._save_raw(generation+'-effect-'+str(index), raw)
            if self.issued is None:
                self._save_raw('issued', issued['raw'], issued['ref'])
            self._save_raw(generation+'-status', status['raw'], status['ref'])
            self.check()
            stamp = host._load(observation)['stamps']['control']
            if self.final_guard(observation,external) is not None:
                raise actor.control.ControlError('SEC014_HOST_FINAL_GUARD')
            self.check()
            metadata = os.fstat(self.tx.parent)
            if stamp != dict(ctimeNs=str(metadata.st_ctime_ns),mtimeNs=str(metadata.st_mtime_ns)):
                raise actor.control.ControlError('SEC014_HOST_FINAL_GUARD')
            self.issued, self.generation = sha, self.generation+1
            self.previous = hashlib.sha256(status['raw']).hexdigest()
            return sha
        except Exception:
            try:
                self.invalidate('PERSISTENCE_FAILED')
            except Exception:
                pass
            raise actor.control.ControlError('SEC014_HOST_CONSUMER_UNCONFIRMED') from None
