#!/usr/bin/env python3
"""Socket relay of the authentication module. Runs as the seat uid (1000), because only that uid can read a seat's cwd
and can own the main-server user's host.sock. It frames one request line per connection, adds the peer's identity,
asks the body over one unix socket and returns the body's one reply line unchanged. It holds no policy and no secret."""
import hashlib, json, os, signal, socket, struct, sys, threading, time, uuid

DIR = os.environ.get("AUTH_RELAY_DIR", "/srv/bellteam/shared/tools/auth-mediation")
BODY = os.environ.get("AUTH_RELAY_BODY", "/srv/bellteam/state/auth-mediation-relay.sock")
SEAT_UID = int(os.environ.get("AUTH_RELAY_SEAT_UID", "1000"))
MAX_REQUEST, MAX_REPLY, READ_SECONDS, BODY_SECONDS = 13 << 20, 17 << 20, 10, 45  # a request may carry a 9 MiB http body as base64, a reply an 11 MiB response (mail read: 1 MiB)
SOCKETS = (("container-socket", "container.sock", 0o666), ("host-socket", "host.sock", 0o600))
# One socket per container caller of key use (wrap / unwrap): callers/<name>/<name>.sock. Whoever can open it is that caller. A new caller is a body train, on purpose.
CALLERS = ("mmobank", "auctionbot", "reminderbot", "reminderbot-public", "yuihome", "forklore-web", "forklore-mcp", "poly-daily", "ip-mcp", "call-bridge", "x-article-mcp", "bingo", "bellteam-push", "bughub", "approval-box", "approval-box-test", "books", "bellteam-body")
# A caller whose socket only its own service account may open: socket 0660 and the folder is NOT re-chmodded (the host prepares it once: group = the service group, setgid, 0750;
# a socket made there inherits that group). Unprepared, the folder is 0750 owned by the relay's uid: only that uid can open it.
RESTRICTED = {"bellteam-push": 0o660, "bellteam-body": 0o660}


# A client line can be 13 MiB and every connection has its own thread: what clients hold in memory at one moment is capped (64 MiB of unfinished request lines) and so are the open run streams (8).
# Beyond it the caller gets "busy" and may retry; nothing is lost or half done. Stops many slow big lines from filling the relay's memory.
TOTAL_SECONDS = int(os.environ.get("AUTH_RELAY_TOTAL_SECONDS", 30))
MAX_PENDING_BYTES, MAX_STREAMS = int(os.environ.get("AUTH_RELAY_MAX_PENDING", 64 << 20)), 8
pending, pending_lock, streams = 0, threading.Lock(), threading.BoundedSemaphore(MAX_STREAMS)


class Busy(Exception):
    pass


def read_line(conn, limit, seconds, charge=False):
    global pending
    data, held, deadline = b"", 0, time.monotonic() + (TOTAL_SECONDS if charge else seconds * 10)  # a total deadline: a client that trickles bytes cannot keep its share of the cap for ever
    try:
        while b"\n" not in data:
            left = deadline - time.monotonic()
            if left <= 0:
                raise ValueError("too slow")
            conn.settimeout(min(seconds, left))
            chunk = conn.recv(65536)
            if not chunk:
                raise ValueError("closed")
            data += chunk
            if len(data) > limit:
                raise ValueError("too long")
            if charge:
                with pending_lock:
                    if pending + len(chunk) > MAX_PENDING_BYTES:
                        raise Busy()
                    pending += len(chunk)
                held += len(chunk)
        return data.split(b"\n", 1)[0]
    finally:
        if held:
            with pending_lock:
                pending -= held


def drain(conn):
    try:
        conn.shutdown(socket.SHUT_WR)
        conn.settimeout(1)
        for _ in range(64):
            if not conn.recv(65536):
                break
    except OSError:
        pass


def reply(conn, obj):
    conn.sendall(json.dumps(obj).encode() + b"\n")


def peer_of(conn):
    pid, uid, _ = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    return uid, os.readlink(f"/proc/{pid}/cwd"), pid  # shortcut: pid can be reused between accept and readlink (same as the old broker); upgrade with pidfd


def program_of(pid):
    """The peer's program: argv[1] of 'interpreter /abs/script', its sha256, and whether no seat can edit it (the file and every folder above it are
    owned by someone else than the seat uid and are not group/other-writable). None when the peer is not that shape.
    shortcut: argv is the peer's own to rewrite and seats share uid 1000; upgrade with the module's own uid."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            argv = f.read().split(b"\0")
        path = os.path.realpath(argv[1].decode()) if len(argv) > 2 and argv[1].startswith(b"/") else None
        if not path:
            return None
        sealed, here = True, path
        while True:
            st = os.stat(here)
            sealed = sealed and st.st_uid != SEAT_UID and not st.st_mode & 0o022
            if here == "/":
                break
            here = os.path.dirname(here)
        with open(path, "rb") as f:
            return {"path": path, "sha256": hashlib.sha256(f.read()).hexdigest(), "sealed": sealed}
    except (OSError, UnicodeDecodeError):
        return None


def pump(src, dst):
    """Copies bytes until src ends, then tells dst there is no more (write side shut). Used both ways of a run's stream."""
    try:
        while True:
            chunk = src.recv(65536)
            if not chunk:
                break
            dst.sendall(chunk)
    except OSError:
        pass
    try:
        dst.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def open_run_listener():
    """A one-shot socket the module child joins (it runs as another uid): mode 0666 in a 0711 folder, a random name nobody can list."""
    folder = os.path.join(DIR, "runs")
    os.makedirs(folder, mode=0o711, exist_ok=True)
    os.chmod(folder, 0o711)
    path = os.path.join(folder, str(uuid.uuid4()) + ".sock")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(path)
    os.chmod(path, 0o666)
    s.listen(1)
    return s, path


def handle(conn, via, unit=None):
    with conn:
        try:
            request = json.loads(read_line(conn, MAX_REQUEST, READ_SECONDS, charge=True))
            if not isinstance(request, dict):
                raise ValueError("not an object")
        except Busy:
            reply(conn, {"outcome": "error", "error": "The module is busy; try again."})
            drain(conn)  # read and drop what the client still sends, so closing does not reset the connection before it reads the answer
            return
        except (ValueError, OSError):
            return reply(conn, {"outcome": "error", "error": "Bad request."})
        peer = None
        if via == "container-socket":
            try:
                uid, cwd, pid = peer_of(conn)
            except OSError:
                uid, cwd, pid = -1, "", 0
            if uid != SEAT_UID or not cwd.startswith("/"):
                return reply(conn, {"outcome": "unknown-caller", "error": "The caller is not registered."})
            peer = {"uid": uid, "cwd": cwd}
            if request.get("op") == "admin":
                peer["program"] = program_of(pid)
        listener = path = None
        held_stream = False
        try:
            body = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            body.settimeout(BODY_SECONDS)
            body.connect(BODY)
            with body:
                frame = {"via": via, "peer": peer, "request": request}
                if unit:
                    frame["unit"] = unit  # the caller socket's own path: its identity
                if request.get("op") in ("run", "http-stream"):
                    if not streams.acquire(blocking=False):
                        return reply(conn, {"outcome": "error", "error": "The module is busy; try again."})
                    held_stream = True
                    listener, path = open_run_listener()  # the module child joins this socket; the client's line cannot name it
                    frame["stream"] = path
                body.sendall(json.dumps(frame).encode() + b"\n")
                line = read_line(body, MAX_REPLY, BODY_SECONDS)
            conn.sendall(line + b"\n")
            if listener and json.loads(line).get("outcome") == "granted":
                listener.settimeout(10)
                other, _ = listener.accept()
                other.settimeout(None)
                conn.settimeout(None)
                up = threading.Thread(target=pump, args=(conn, other), daemon=True)
                up.start()
                pump(other, conn)  # until the module ends the run
                other.close()
        except (OSError, ValueError):
            reply(conn, {"outcome": "error", "error": "The authentication module is not running."})
        finally:
            if held_stream:
                streams.release()
            if listener:
                listener.close()
                try:
                    os.unlink(path)
                except OSError:
                    pass


def serve(via, path, mode, unit=None):
    if os.path.exists(path):
        os.unlink(path)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(path)
    os.chmod(path, mode)
    s.listen(32)
    while True:
        conn, _ = s.accept()
        threading.Thread(target=handle, args=(conn, via, unit), daemon=True).start()


def main():
    os.umask(0o077)
    os.makedirs(DIR, mode=0o711, exist_ok=True)
    os.chmod(DIR, 0o711)
    # run-sockets: where a run item that asks for it (run_socket_dir) puts its service socket so the host can reach it; the child makes its own sub-folder here (sticky, like /tmp)
    os.makedirs(os.path.join(DIR, "run-sockets"), mode=0o1777, exist_ok=True)
    os.chmod(os.path.join(DIR, "run-sockets"), 0o1777)
    paths = [os.path.join(DIR, name) for _, name, _ in SOCKETS]
    callers = [os.path.join(DIR, "callers", name, name + ".sock") for name in CALLERS]
    for name, path in zip(CALLERS, callers):  # folders 0755 (a container mounts the caller's folder, so the socket survives a relay restart)
        folder = os.path.dirname(path)
        os.makedirs(folder, mode=0o750 if name in RESTRICTED else 0o755, exist_ok=True)
        os.chmod(os.path.dirname(folder), 0o755)
        if name not in RESTRICTED:
            os.chmod(folder, 0o755)
    paths += callers

    def stop(*_):
        for p in paths:
            try:
                os.unlink(p)
            except OSError:
                pass
        os._exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    for (via, _, mode), path in zip(SOCKETS, paths):
        threading.Thread(target=serve, args=(via, path, mode), daemon=True).start()
    for name, path in zip(CALLERS, callers):
        threading.Thread(target=serve, args=("caller-socket", path, RESTRICTED.get(name, 0o666), path), daemon=True).start()
    print("auth-mediation relay ready", flush=True)
    signal.pause()


if __name__ == "__main__":
    main()
