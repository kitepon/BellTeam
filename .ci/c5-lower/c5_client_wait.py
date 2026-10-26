"""Linux childのpipeをreapせずdrainし、WNOWAITの実exitをproducerへ返す。"""

import os
import selectors
import subprocess
import threading
import time

from c5_contract import ContractError
from c5_state import command_terminal, phase_event


OUTPUT_LIMIT = 8 * 1024 * 1024


def terminated_unreaped(child: subprocess.Popen, deadline: float):
    """(stdout, stderr, terminal)を返す。ここではwait/poll/communicateを呼ばない。"""
    if not all(hasattr(os, name) for name in
               ("waitid", "P_PID", "WEXITED", "WNOWAIT", "WNOHANG")):
        raise ContractError("C5_WNOWAIT_UNSUPPORTED")
    outputs = {"stdout": bytearray(), "stderr": bytearray()}
    streams = {"stdout": child.stdout, "stderr": child.stderr}
    with selectors.DefaultSelector() as selector:
        for name, stream in streams.items():
            if stream is None:
                raise ContractError("C5_CLIENT_PIPE_MISSING")
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        terminal = None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ContractError("C5_CLIENT_TIMEOUT")
            for key, _ in selector.select(min(remaining, 0.05)):
                try:
                    chunk = os.read(key.fd, 65536)
                except BlockingIOError:
                    continue
                except OSError:
                    raise ContractError("C5_CLIENT_PIPE_UNAVAILABLE") from None
                if chunk:
                    outputs[key.data].extend(chunk)
                    if sum(len(value) for value in outputs.values()) > OUTPUT_LIMIT:
                        raise ContractError("C5_CLIENT_OUTPUT_LIMIT")
                else:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
            try:
                seen = os.waitid(os.P_PID, child.pid,
                                 os.WEXITED | os.WNOWAIT | os.WNOHANG)
            except (ChildProcessError, OSError):
                raise ContractError("C5_CLIENT_WAIT_UNAVAILABLE") from None
            if seen is not None:
                if seen.si_code == os.CLD_EXITED:
                    terminal = {"kind": "exit", "status": seen.si_status}
                elif seen.si_code in (os.CLD_KILLED, os.CLD_DUMPED):
                    terminal = {"kind": "signal", "status": seen.si_status}
                else:
                    raise ContractError("C5_CLIENT_WAIT_UNAVAILABLE")
            if terminal is not None and not selector.get_map():
                return bytes(outputs["stdout"]), bytes(outputs["stderr"]), terminal


def reap_after_receipt(child: subprocess.Popen, terminal: dict) -> None:
    """producerがterminal receiptをatomic保存した後だけ呼ぶ。"""
    result = child.wait(timeout=1)
    expected = (terminal["status"] if terminal["kind"] == "exit"
                else -terminal["status"])
    if result != expected:
        raise ContractError("C5_CLIENT_REAP_MISMATCH")


def publish_terminal_then_reap(child: subprocess.Popen, state: dict,
                               state_path, terminal: dict, write_state) -> None:
    """既知exitを永続stateに保存した後にだけreapする。保存不能はunknown。"""
    try:
        command_terminal(state, child.pid, terminal)
        write_state(state_path, state)
    except (ContractError, OSError):
        state.update({"phaseStatus": "unknown", "latch": True,
                      "phase_outcome": "terminal_receipt_unsaved"})
        phase_event(state, "unknown")
        try:
            write_state(state_path, state)
        except (ContractError, OSError):
            pass
        raise ContractError("C5_TERMINAL_RECEIPT_UNKNOWN") from None
    try:
        reap_after_receipt(child, terminal)
    except (ContractError, subprocess.TimeoutExpired, OSError):
        state.update({"phaseStatus": "unknown", "latch": True,
                      "phase_outcome": "client_reap_uncertain"})
        phase_event(state, "unknown")
        write_state(state_path, state)
        raise ContractError("C5_CLIENT_REAP_UNKNOWN") from None


def drain_and_reap_unknown(child: subprocess.Popen) -> None:
    """unknown receipt後だけに使う。結果を通常工程へ戻さない。"""
    def finish():
        try:
            with selectors.DefaultSelector() as selector:
                for stream in (child.stdout, child.stderr):
                    if stream is not None and not stream.closed:
                        os.set_blocking(stream.fileno(), False)
                        selector.register(stream, selectors.EVENT_READ)
                while selector.get_map():
                    for key, _ in selector.select(0.5):
                        try:
                            chunk = os.read(key.fd, 65536)
                        except BlockingIOError:
                            continue
                        if not chunk:
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
            child.wait()
        except (OSError, ValueError):
            pass
    threading.Thread(target=finish, daemon=True).start()
