#!/usr/bin/env python3
"""Socket relay of the authentication module. Runs as the seat uid (1000), because only that uid can read a seat's cwd
and can own the main-server user's host.sock. It frames one request line per connection, adds the peer's identity,
asks the body over one unix socket and returns the body's one reply line unchanged. It holds no policy and no secret."""
import json, os, signal, socket, struct, sys, threading

DIR = os.environ.get("AUTH_RELAY_DIR", "/srv/bellteam/shared/tools/auth-mediation")
BODY = os.environ.get("AUTH_RELAY_BODY", "/srv/bellteam/state/auth-mediation-relay.sock")
SEAT_UID = int(os.environ.get("AUTH_RELAY_SEAT_UID", "1000"))
MAX_REQUEST, MAX_REPLY, READ_SECONDS, BODY_SECONDS = 65536, 1 << 20, 10, 45
SOCKETS = (("container-socket", "container.sock", 0o666), ("host-socket", "host.sock", 0o600))


def read_line(conn, limit, seconds):
    conn.settimeout(seconds)
    data = b""
    while b"\n" not in data:
        chunk = conn.recv(65536)
        if not chunk:
            raise ValueError("closed")
        data += chunk
        if len(data) > limit:
            raise ValueError("too long")
    return data.split(b"\n", 1)[0]


def reply(conn, obj):
    conn.sendall(json.dumps(obj).encode() + b"\n")


def peer_of(conn):
    pid, uid, _ = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    return uid, os.readlink(f"/proc/{pid}/cwd")  # shortcut: pid can be reused between accept and readlink (same as the old broker); upgrade with pidfd


def handle(conn, via):
    with conn:
        try:
            request = json.loads(read_line(conn, MAX_REQUEST, READ_SECONDS))
            if not isinstance(request, dict):
                raise ValueError("not an object")
        except (ValueError, OSError):
            return reply(conn, {"outcome": "error", "error": "Bad request."})
        peer = None
        if via == "container-socket":
            try:
                uid, cwd = peer_of(conn)
            except OSError:
                uid, cwd = -1, ""
            if uid != SEAT_UID or not cwd.startswith("/"):
                return reply(conn, {"outcome": "unknown-caller", "error": "The caller is not registered."})
            peer = {"uid": uid, "cwd": cwd}
        try:
            body = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            body.settimeout(BODY_SECONDS)
            body.connect(BODY)
            with body:
                body.sendall(json.dumps({"via": via, "peer": peer, "request": request}).encode() + b"\n")
                line = read_line(body, MAX_REPLY, BODY_SECONDS)
            conn.sendall(line + b"\n")
        except (OSError, ValueError):
            reply(conn, {"outcome": "error", "error": "The authentication module is not running."})


def serve(via, path, mode):
    if os.path.exists(path):
        os.unlink(path)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(path)
    os.chmod(path, mode)
    s.listen(32)
    while True:
        conn, _ = s.accept()
        threading.Thread(target=handle, args=(conn, via), daemon=True).start()


def main():
    os.umask(0o077)
    os.makedirs(DIR, mode=0o711, exist_ok=True)
    os.chmod(DIR, 0o711)
    paths = [os.path.join(DIR, name) for _, name, _ in SOCKETS]

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
    print("auth-mediation relay ready", flush=True)
    signal.pause()


if __name__ == "__main__":
    main()
