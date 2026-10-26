import hashlib
import importlib.util
import json
from pathlib import Path
import time
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


c = module('parent_consumer', ROOT/'distribution/internal/sec014-host-parent-consumer.py')
fixture = module('parent_executor_fixture', ROOT/'test/sec014-prepare-executor.py')


def ref(name):
    return dict(artifactId=name, sha256=hashlib.sha256(name.encode()).hexdigest())


class ConsumerTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.PrepareTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.ordinal, self.seen, self.last = 110, [], None
        self.external_state, self.changed_parent = 'active', None

    def consumer(self, tx):
        paths = dict(actor='distribution/internal/sec014-host-actor.py',
                     producer='distribution/internal/sec014-host-parent.py',
                     executor='distribution/internal/sec014-prepare-executor.py',
                     compose='compose.state-prepare.yaml')
        self.binding = dict(transactionId=tx.name, direction=tx.value['direction'],
            actorPid=str(tx.value['actorPid']), actorStartTicks=str(tx.value['actorStartTicks']),
            lockEpoch='synthetic-epoch', lockIdentity=dict(zip(('dev','ino'), map(str,tx.lock_identity))),
            sourcePins={k:hashlib.sha256((ROOT/v).read_bytes()).hexdigest() for k,v in paths.items()},
            image=fixture.IMAGE_ID, imageRef=fixture.IMAGE,
            hostContext=ref('synthetic-context'), bootId='synthetic-boot',
            timeNamespace=dict(dev='1',ino='30'),
            window=dict(id='synthetic-window',startNs='100',endNs='1000',utcStartNs='1100',utcEndNs='2000'))
        self.policy = dict(plan=ref('synthetic-plan'),maxAgeNs='800',maxSpanNs='10',
            clockMap=dict(source=ref('synthetic-clock'),bootId='synthetic-boot',
                timeNamespace=self.binding['timeNamespace'],boottimeNs='100',utcNs='1100',maxErrorNs='0'),
            externalControl=ref('synthetic-management'))
        result=c._Consumer(tx,c.host._raw(self.binding),c.host._raw(self.policy),self.observe,
                           lambda observation,external:None)
        self.addCleanup(result.close)
        result.bind_image(fixture.IMAGE,fixture.IMAGE_ID)
        return result

    def observe(self, step):
        self.ordinal += 1
        self.seen.append(step)
        n = self.ordinal
        # Only control uses this ordinary fixture FS; other host fields remain synthetic.
        stamps = {k:dict(ctimeNs='10',mtimeNs='10') for k in ('stateData','backup','control')}
        metadata=self.f.f.root.stat()
        stamps['control']=dict(ctimeNs=str(metadata.st_ctime_ns),mtimeNs=str(metadata.st_mtime_ns))
        if self.changed_parent and step=='inspect':
            stamps[self.changed_parent]['mtimeNs']='20'
        raw = c.host._raw(dict(schema='bellteam.sec014.host-parent-observation.v1',
            evidenceScope='artificial-only',binding=self.binding,
            frame=dict(startNs=str(n-2),endNs=str(n-1),nowNs=str(n),utcNowNs=str(n+1000)),
            invariants=ref('synthetic-invariants'),stamps=stamps,original=ref('synthetic-'+str(n))))
        external = c.host._raw(dict(schema='bellteam.sec014.host-parent-external-control.v1',
            evidenceScope='artificial-only',binding=self.binding,procedure=self.policy['externalControl'],
            generation='0',observedNs=str(n),observationSha256=hashlib.sha256(raw).hexdigest(),
            state=self.external_state))
        effects=()
        if self.last is not None and c.host._load(self.last)['stamps']['control']!=stamps['control']:
            effects=(c.host._raw(dict(schema='bellteam.sec014.host-parent-known-effect.v1',
                evidenceScope='artificial-only',binding=self.binding,step=step,
                operation='control-record',producerSha256=self.binding['sourcePins']['actor'],
                beforeObservationSha256=hashlib.sha256(self.last).hexdigest(),
                afterObservationSha256=hashlib.sha256(raw).hexdigest(),parent='control',
                operationOriginal=ref('synthetic-fixed-actor-operation'))),)
        self.last = raw
        return raw, external, effects

    def prepare(self, tx, consumer):
        self.f.tx = tx
        return fixture.p._Prepare(tx, fixture.IMAGE, fixture.IMAGE_ID, time.monotonic()+110,
            datetime.now(timezone.utc)+timedelta(seconds=120), consumer).prepare()

    def test_same_actor_steps_raw_hashes_and_fixed_issue_reach_evidence_only(self):
        with self.f.f.hold() as tx:
            consumer = self.consumer(tx)
            receipt = self.prepare(tx,consumer)
            self.assertEqual(self.seen,['entry','run','run','inspect','inspect',
                                       'remove','remove','absence','absence','metadata','phase'])
            self.assertEqual(len(self.f.commands),4)
            self.assertEqual(receipt['proofs']['host_parents'],consumer.issued)
            self.assertEqual(consumer.generation,len(self.seen))
            for saved in consumer.saved:
                raw = (self.f.f.root/saved['artifactName']).read_bytes()
                self.assertEqual(hashlib.sha256(raw).hexdigest(),saved['wrapperSha256'])
                value=json.loads(raw)
                self.assertEqual(hashlib.sha256(value['rawUtf8'].encode()).hexdigest(),saved['rawSha256'])
                self.assertNotEqual(saved['wrapperSha256'],saved['rawSha256'])
            self.assertEqual(self.f.journal()['phases'],[])

    def test_raw_persistence_failure_holds_and_refuses_same_object_retry(self):
        with self.f.f.hold() as tx:
            consumer = self.consumer(tx)
            with patch.object(c.os,'fsync',side_effect=OSError('synthetic save')):
                with self.assertRaises(fixture.p.actor.control.ControlError):self.prepare(tx,consumer)
            self.assertTrue(consumer.held)
            with self.assertRaises(c.actor.control.ControlError):consumer('run')
        self.assertEqual(self.f.commands,[])
        self.assertEqual(self.f.journal()['phases'],[])

    def test_external_revocation_saved_and_no_first_child(self):
        with self.f.f.hold() as tx:
            consumer = self.consumer(tx)
            consumer('entry')
            self.external_state='revoked'
            with self.assertRaises(c.actor.control.ControlError):consumer('run')
            terminal=c.host._load(consumer.producer.records()['status']['raw'])
            self.assertEqual(terminal['state'],'revoked')
            self.assertIn('terminal',consumer.used)
            self.assertGreater((self.f.f.root/consumer.slots['terminal'][1]).stat().st_size,0)
        self.assertEqual(self.f.commands,[])

    def test_unexplained_parent_change_after_run_prevents_inspect_and_phase(self):
        with self.f.f.hold() as tx:
            consumer=self.consumer(tx)
            self.changed_parent='stateData'
            with self.assertRaises(fixture.p.actor.control.ControlError):self.prepare(tx,consumer)
            self.assertTrue(consumer.held)
        self.assertEqual(len(self.f.commands),1)
        self.assertFalse((self.f.f.root/'to-server-prepare-evidence.json').exists())
        self.assertEqual(self.f.journal()['phases'],[])

    def test_replacement_of_same_raw_wrapper_inode_refuses_before_child(self):
        original=c.os.fsync
        def replace(fd):
            result=original(fd)
            path=Path(f'/proc/self/fd/{fd}').resolve()
            if path.name.endswith('host-parent-slot-1-status.json'):
                raw=path.read_bytes()
                path.rename(path.with_suffix('.retained'))
                path.write_bytes(raw);path.chmod(0o600)
            return result
        with self.f.f.hold() as tx:
            consumer=self.consumer(tx)
            with patch.object(c.os,'fsync',side_effect=replace):
                with self.assertRaises(fixture.p.actor.control.ControlError):self.prepare(tx,consumer)
        self.assertEqual(self.f.commands,[])
        self.assertEqual(self.f.journal()['phases'],[])

    def test_actor_birth_change_refuses_before_observation_or_write(self):
        with self.f.f.hold() as tx:
            consumer=self.consumer(tx)
            tx.value['actorStartTicks']+=1
            with self.assertRaises(c.actor.control.ControlError):consumer('entry')
        self.assertEqual(self.seen,[])
        self.assertEqual(consumer.saved,[])

    def test_post_observation_directory_entry_change_refuses_first_child(self):
        with self.f.f.hold() as tx:
            consumer=self.consumer(tx)
            write=consumer._save_raw
            def create(name,*args):
                result=write(name,*args)
                if name=='1-status':(self.f.f.root/'unexplained-entry').write_bytes(b'')
                return result
            with patch.object(consumer,'_save_raw',side_effect=create):
                with self.assertRaises(fixture.p.actor.control.ControlError):self.prepare(tx,consumer)
        self.assertEqual(self.f.commands,[])
        self.assertEqual(self.f.journal()['phases'],[])

    def test_no_create_after_observation_and_each_slot_written_only_once(self):
        original=c.os.open
        first_observed=[False]
        def open_checked(path,flags,*args,**kwargs):
            if first_observed[0]:self.assertFalse(flags & os.O_CREAT)
            return original(path,flags,*args,**kwargs)
        import os
        observe=self.observe
        def first(step):
            result=observe(step);first_observed[0]=True;return result
        with self.f.f.hold() as tx:
            consumer=self.consumer(tx);consumer.observe=first
            with patch.object(c.os,'open',side_effect=open_checked):consumer('entry')
            with self.assertRaises(c.actor.control.ControlError):consumer._save_raw('1-status',b'{}')
        self.assertEqual(self.f.commands,[])

    def test_final_guard_revocation_latches_and_fixed_order_cannot_be_skipped(self):
        with self.f.f.hold() as tx:
            consumer=self.consumer(tx)
            consumer.final_guard=lambda observation,external:True
            with self.assertRaises(fixture.p.actor.control.ControlError):self.prepare(tx,consumer)
            with self.assertRaises(c.actor.control.ControlError):consumer('phase')
        self.assertEqual(self.f.commands,[])

    def test_final_guard_entry_change_is_rechecked_before_child(self):
        with self.f.f.hold() as tx:
            consumer=self.consumer(tx)
            def changed(observation,external):
                (self.f.f.root/'guard-side-entry').write_bytes(b'')
            consumer.final_guard=changed
            with self.assertRaises(fixture.p.actor.control.ControlError):self.prepare(tx,consumer)
        self.assertEqual(self.f.commands,[])

    def test_unconfirmed_client_invalidates_parent_and_cannot_admit_another_step(self):
        self.f.output=b'synthetic'*600
        with self.f.f.hold() as tx:
            consumer=self.consumer(tx)
            with self.assertRaises(fixture.p.actor.control.ControlError):self.prepare(tx,consumer)
            value=c.host._load(consumer.producer.records()['status']['raw'])
            self.assertEqual((value['state'],value['reason']),('unknown','UNCONFIRMED_CHILD'))
            with self.assertRaises(c.actor.control.ControlError):consumer('inspect')
        self.assertEqual(len(self.f.commands),1)
        self.assertEqual(self.f.journal()['phases'],[])

    def test_partial_slot_write_is_not_reused_and_child_zero(self):
        with self.f.f.hold() as tx:
            consumer=self.consumer(tx)
            with patch.object(c.os,'write',return_value=0):
                with self.assertRaises(fixture.p.actor.control.ControlError):self.prepare(tx,consumer)
            self.assertIn('1-observation',consumer.used)
            with self.assertRaises(c.actor.control.ControlError):consumer('entry')
        self.assertEqual(self.f.commands,[])

    def test_initial_slot_fstat_failure_closes_successful_open(self):
        original=c.os.fstat
        def fail(fd):
            if 'host-parent-slot-' in str(Path(f'/proc/self/fd/{fd}').resolve()):
                raise OSError('synthetic first fstat')
            return original(fd)
        with self.f.f.hold() as tx:
            before=set(Path('/proc/self/fd').iterdir())
            with patch.object(c.os,'fstat',side_effect=fail):
                with self.assertRaises(OSError):self.consumer(tx)
            self.assertEqual(set(Path('/proc/self/fd').iterdir()),before)


if __name__=='__main__':unittest.main(verbosity=2)
