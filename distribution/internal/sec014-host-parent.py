"""SEC014 host-owned lifecycle core. No live factory, collector, CLI or host IO."""
import hashlib
import json
import re


ISSUER = 'bot-29f8f415'
DEPLOYMENT_CANDIDATE = '/home/kite/BellTeam/runtime/server-only/maintenance-control/sec014-host-parent.py'
STEPS = ('entry', 'run', 'inspect', 'remove', 'absence', 'metadata', 'phase')
SCOPE = 'artificial-only'


class HostParentError(RuntimeError):
    pass


class Unavailable(HostParentError):
    pass


def _open_host_parent():
    # Management startup, full-field collector and external revocation are unplaced.
    raise Unavailable('SEC014_HOST_MANAGEMENT_UNDEPLOYED')


def _raw(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _keys(value, names):
    if type(value) is not dict or set(value) != set(names.split()):
        raise HostParentError('SEC014_HOST_RAW_TYPE')


def _text(value):
    if type(value) is not str or not value or len(value) > 256:
        raise HostParentError('SEC014_HOST_RAW_TYPE')


def _dec(value):
    if type(value) is not str or not re.fullmatch(r'0|[1-9][0-9]{0,39}', value):
        raise HostParentError('SEC014_HOST_RAW_TYPE')
    return int(value)


def _digest(value):
    if type(value) is not str or not re.fullmatch('[a-f0-9]{64}', value):
        raise HostParentError('SEC014_HOST_RAW_TYPE')


def _ref(value):
    _keys(value, 'artifactId sha256')
    _text(value['artifactId'])
    _digest(value['sha256'])


def _identity(value):
    _keys(value, 'dev ino')
    _dec(value['dev'])
    if _dec(value['ino']) == 0:
        raise HostParentError('SEC014_HOST_RAW_TYPE')


def _load(raw):
    def invalid_constant(_):
        raise ValueError()

    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise HostParentError('SEC014_HOST_DUPLICATE_KEY')
            value[key] = item
        return value
    if type(raw) is not bytes or not 0 < len(raw) <= 65536:
        raise HostParentError('SEC014_HOST_RAW_TYPE')
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                          parse_constant=invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise HostParentError('SEC014_HOST_RAW_TYPE') from None


def _binding(value):
    _keys(value, 'transactionId direction actorPid actorStartTicks lockEpoch lockIdentity '
          'sourcePins image imageRef hostContext bootId timeNamespace window')
    for key in ('transactionId', 'lockEpoch', 'bootId'):
        _text(value[key])
    if value['direction'] not in ('to-server', 'to-legacy'):
        raise HostParentError('SEC014_HOST_RAW_TYPE')
    if any(_dec(value[k]) == 0 for k in ('actorPid', 'actorStartTicks')):
        raise HostParentError('SEC014_HOST_RAW_TYPE')
    _identity(value['lockIdentity'])
    _identity(value['timeNamespace'])
    _ref(value['hostContext'])
    _keys(value['sourcePins'], 'actor producer executor compose')
    for digest in value['sourcePins'].values():
        _digest(digest)
    if (type(value['image']) is not str or not re.fullmatch('sha256:[a-f0-9]{64}', value['image'])
            or type(value['imageRef']) is not str or not re.fullmatch(
                r'ghcr\.io/kitepon/bellteam-server@sha256:[a-f0-9]{64}', value['imageRef'])):
        raise HostParentError('SEC014_HOST_RAW_TYPE')
    window = value['window']
    _keys(window, 'id startNs endNs utcStartNs utcEndNs')
    _text(window['id'])
    if not (_dec(window['startNs']) < _dec(window['endNs'])
            and _dec(window['utcStartNs']) < _dec(window['utcEndNs'])):
        raise HostParentError('SEC014_HOST_RAW_TYPE')


class _Producer:
    """Private raw lifecycle; artificial inputs never confer live host authority."""
    def __init__(self, binding_raw, policy_raw):
        self._binding = _load(binding_raw)
        self._policy = _load(policy_raw)
        _binding(self._binding)
        _keys(self._policy, 'plan maxAgeNs maxSpanNs clockMap externalControl')
        for key in ('plan', 'externalControl'):
            _ref(self._policy[key])
        if any(_dec(self._policy[k]) == 0 for k in ('maxAgeNs', 'maxSpanNs')):
            raise Unavailable('SEC014_HOST_NUMERIC_POLICY_REQUIRED')
        clock = self._policy['clockMap']
        _keys(clock, 'source bootId timeNamespace boottimeNs utcNs maxErrorNs')
        _ref(clock['source'])
        _identity(clock['timeNamespace'])
        for key in ('boottimeNs', 'utcNs', 'maxErrorNs'):
            _dec(clock[key])
        if any(clock[k] != self._binding[k] for k in ('bootId', 'timeNamespace')):
            raise Unavailable('SEC014_HOST_CLOCK_DOMAIN')
        self._issued = None
        self._status = None
        self._observation = None
        self._step = None
        self._generation = 0
        self._external_generation = 0
        self._state = 'unissued'
        self._expires = None

    def _observation_value(self, raw):
        value = _load(raw)
        _keys(value, 'schema evidenceScope binding frame invariants stamps original')
        if (value['schema'] != 'bellteam.sec014.host-parent-observation.v1'
                or value['evidenceScope'] != SCOPE or value['binding'] != self._binding):
            raise HostParentError('SEC014_HOST_BINDING_OR_SCOPE')
        _ref(value['invariants'])
        _ref(value['original'])
        _keys(value['stamps'], 'stateData backup control')
        for stamp in value['stamps'].values():
            _keys(stamp, 'ctimeNs mtimeNs')
            _dec(stamp['ctimeNs'])
            _dec(stamp['mtimeNs'])
        frame = value['frame']
        _keys(frame, 'startNs endNs nowNs utcNowNs')
        start, end, now, utc = (_dec(frame[k]) for k in ('startNs', 'endNs', 'nowNs', 'utcNowNs'))
        clock, window = self._policy['clockMap'], self._binding['window']
        if (not 0 <= end-start <= _dec(self._policy['maxSpanNs'])
                or not 0 <= now-end <= _dec(self._policy['maxAgeNs'])
                or not _dec(window['startNs']) <= now < _dec(window['endNs'])
                or not _dec(window['utcStartNs']) <= utc < _dec(window['utcEndNs'])
                or abs((utc-_dec(clock['utcNs']))-(now-_dec(clock['boottimeNs']))) > _dec(clock['maxErrorNs'])
                or self._expires is not None and now >= self._expires):
            raise HostParentError('SEC014_HOST_FRESHNESS')
        if self._observation is not None:
            before = _load(self._observation)['frame']
            if any(_dec(frame[k]) < _dec(before[k]) for k in ('startNs', 'endNs', 'nowNs', 'utcNowNs')):
                raise HostParentError('SEC014_HOST_FRAME_REGRESSION')
        return value

    def _external(self, raw, observation):
        if raw is None:
            raise Unavailable('SEC014_HOST_EXTERNAL_CONTROL_UNAVAILABLE')
        value = _load(raw)
        _keys(value, 'schema evidenceScope binding procedure generation observedNs observationSha256 state')
        if (value['schema'] != 'bellteam.sec014.host-parent-external-control.v1'
                or value['evidenceScope'] != SCOPE or value['binding'] != self._binding
                or value['procedure'] != self._policy['externalControl']
                or value['observationSha256'] != _sha(observation)):
            raise HostParentError('SEC014_HOST_EXTERNAL_BINDING')
        generation = _dec(value['generation'])
        frame = _load(observation)['frame']
        if (generation < self._external_generation
                or not _dec(frame['startNs']) <= _dec(value['observedNs']) <= _dec(frame['nowNs'])):
            raise HostParentError('SEC014_HOST_EXTERNAL_REGRESSION')
        if self._issued is not None and generation != self._external_generation:
            raise HostParentError('SEC014_HOST_EXTERNAL_GENERATION_CHANGED')
        if value['state'] == 'unknown':
            raise Unavailable('SEC014_HOST_EXTERNAL_CONTROL_UNKNOWN')
        if value['state'] != 'active':
            raise HostParentError('SEC014_HOST_EXTERNAL_REVOKED')
        return generation

    def _effects(self, step, observation_raw, value, effects):
        before = _load(self._observation)
        if value['invariants'] != before['invariants']:
            raise HostParentError('SEC014_HOST_INVARIANT_CHANGED')
        changed = {k for k in value['stamps'] if value['stamps'][k] != before['stamps'][k]}
        if type(effects) is not tuple or len(effects) > 2:
            raise HostParentError('SEC014_HOST_EFFECT_TYPE')
        explained = set()
        for raw in effects:
            effect = _load(raw)
            _keys(effect, 'schema evidenceScope binding step operation producerSha256 '
                  'beforeObservationSha256 afterObservationSha256 parent operationOriginal')
            _ref(effect['operationOriginal'])
            if (effect['schema'] != 'bellteam.sec014.host-parent-known-effect.v1'
                    or effect['evidenceScope'] != SCOPE or effect['binding'] != self._binding
                    or effect['step'] != step
                    or effect['beforeObservationSha256'] != _sha(self._observation)
                    or effect['afterObservationSha256'] != _sha(observation_raw)):
                raise HostParentError('SEC014_HOST_EFFECT_BINDING')
            parent, operation = effect['parent'], effect['operation']
            _text(parent)
            _text(operation)
            _digest(effect['producerSha256'])
            if parent in explained or parent not in changed:
                raise HostParentError('SEC014_HOST_EFFECT_UNUSED_OR_DUPLICATE')
            if operation == 'prepare' and parent == 'stateData' and self._step == 'run' and step == 'inspect':
                source = 'executor'
            elif operation == 'control-record' and parent == 'control':
                source = 'actor'
            else:
                raise HostParentError('SEC014_HOST_EFFECT_NOT_ALLOWED')
            if effect['producerSha256'] != self._binding['sourcePins'][source]:
                raise HostParentError('SEC014_HOST_EFFECT_SOURCE')
            explained.add(parent)
        if changed != explained:
            raise HostParentError('SEC014_HOST_UNEXPLAINED_CHANGE')

    def _emit(self, state, reason, step, observation_raw, external_raw, effects):
        previous = None if self._status is None else _sha(self._status)
        self._generation += 1
        value = dict(schema='bellteam.sec014.host-parent-status.v1', evidenceScope=SCOPE,
                     issuer=ISSUER, issuedSha256=None if self._issued is None else _sha(self._issued),
                     binding=self._binding, generation=str(self._generation), previousStatusSha256=previous,
                     externalGeneration=str(self._external_generation), step=step, state=state, reason=reason,
                     observationSha256=None if observation_raw is None else _sha(observation_raw),
                     externalControlSha256=None if external_raw is None else _sha(external_raw),
                     effectSha256=[_sha(raw) for raw in effects])
        self._state, self._status = state, _raw(value)
        return self._status

    def issue(self, observation_raw, external_raw):
        if self._state != 'unissued':
            raise HostParentError('SEC014_HOST_ALREADY_ISSUED_OR_TERMINAL')
        try:
            observation = self._observation_value(observation_raw)
            self._external_generation = self._external(external_raw, observation_raw)
            self._expires = min(_dec(observation['frame']['endNs'])+_dec(self._policy['maxAgeNs']),
                                _dec(self._binding['window']['endNs']))
            if _dec(observation['frame']['nowNs']) >= self._expires:
                raise HostParentError('SEC014_HOST_FRESHNESS')
            self._issued = _raw(dict(schema='bellteam.sec014.host-parent-issued.v1', evidenceScope=SCOPE,
                issuer=ISSUER, binding=self._binding, policy=self._policy, expiresNs=str(self._expires),
                firstObservationSha256=_sha(observation_raw), externalControlSha256=_sha(external_raw)))
            self._observation, self._step = observation_raw, 'entry'
            return self._issued, self._emit('valid', 'CHECKED', 'entry', observation_raw, external_raw, ())
        except HostParentError as error:
            self._state = 'unknown' if isinstance(error, Unavailable) else 'revoked'
            raise

    def advance(self, step, observation_raw, external_raw, effects=()):
        if self._state != 'valid':
            raise HostParentError('SEC014_HOST_TERMINAL')
        try:
            if type(step) is not str or step not in STEPS:
                raise HostParentError('SEC014_HOST_STEP')
            current, wanted = STEPS.index(self._step), STEPS.index(step)
            if wanted not in (current, current+1):
                raise HostParentError('SEC014_HOST_STEP_ORDER')
            observation = self._observation_value(observation_raw)
            external = self._external(external_raw, observation_raw)
            self._effects(step, observation_raw, observation, effects)
            self._external_generation = external
            self._observation, self._step = observation_raw, step
            return self._emit('valid', 'CHECKED', step, observation_raw, external_raw, effects)
        except HostParentError as error:
            state = 'unknown' if isinstance(error, Unavailable) else 'revoked'
            # Keep the last checked originals; a rejected raw input is not a fresh proof.
            self._emit(state, str(error), self._step, self._observation, None, ())
            raise

    def invalidate(self, state, reason):
        if self._state != 'valid' or state not in ('revoked', 'unknown'):
            raise HostParentError('SEC014_HOST_TERMINAL')
        if reason not in ('ACTOR_OR_LOCK_LOST', 'UNCONFIRMED_CHILD', 'PERSISTENCE_FAILED', 'OWNER_REVOKED'):
            raise HostParentError('SEC014_HOST_REASON')
        return self._emit(state, reason, self._step, self._observation, None, ())

    def current(self):
        if self._state != 'valid':
            raise HostParentError('SEC014_HOST_TERMINAL')
        return self._issued, self._status

    def records(self):
        """Raw snapshots for persistence, including terminal status; never admission."""
        result = {}
        for name, raw in (('issued', self._issued), ('status', self._status)):
            if raw is not None:
                artifact = f"transaction-{self._binding['direction']}.host-parent-{name}"
                if name == 'status':
                    artifact += '-' + str(self._generation)
                result[name] = {'ref': {'artifactId': artifact, 'sha256': _sha(raw)}, 'raw': raw}
        return result
