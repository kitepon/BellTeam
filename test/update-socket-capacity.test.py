"""One local socket contact; no real updater, installer, state, or native work."""
import importlib.util,json,os,socket,tempfile,threading,time
from pathlib import Path
source=Path(__file__).resolve().parents[1]/'scripts/container-update-host.py'
spec=importlib.util.spec_from_file_location('contact_host',source)
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
# Local peer fixture maps only our UID to the required product peer; no production identity claim.
original_unpack=host.struct.unpack
def peer_unpack(fmt, raw):
    value=original_unpack(fmt,raw)
    return (value[0],1001,value[2]) if fmt=='3i' and value[1]==os.getuid() else value
host.struct.unpack=peer_unpack
class Reader:
    def __init__(self):
        self.release=threading.Event();self.full=threading.Event();self.lock=threading.Lock();self.calls=[]
    def dispatch(self,frame):
        with self.lock:
            self.calls.append(frame['operation'])
            if len(self.calls)==16:self.full.set()
        assert self.release.wait(3)
        return {'completed':True}
start=time.monotonic(); reader=Reader()
with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp:
    path=str(Path(temp)/'socket')
    with host.Server(path,reader) as server:
        thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':0.01});thread.start()
        clients=[]
        try:
            for _ in range(16):
                client=socket.socket(socket.AF_UNIX);client.settimeout(2);client.connect(path)
                client.sendall(b'{"operation":"catalog","params":{}}\n');clients.append(client)
            assert reader.full.wait(2)
            with socket.socket(socket.AF_UNIX) as poll:
                poll.settimeout(2);poll.connect(path)
                poll.sendall(b'{"operation":"get","params":{}}\n')
                assert reader.calls==['catalog']*16
                reader.release.set()
                assert json.loads(poll.recv(1024))=={'ok':True,'value':{'completed':True}}
            for client in clients: assert json.loads(client.recv(1024))['ok'] is True
            assert reader.calls.count('get')==1 and len(reader.calls)==17
            print(json.dumps({'result':'pass','existingReaders':16,'nextReadDispatchedOnce':True,'elapsedMs':(time.monotonic()-start)*1000,'scope':'local actual Server; controlled read-only dispatch'}))
        finally:
            reader.release.set()
            for client in clients:client.close()
            server.shutdown();thread.join()
