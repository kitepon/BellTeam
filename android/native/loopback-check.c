// Loopback check of libdatachannel.so for one ABI (a490h2n): two peer connections in one process connect over host candidates (ICE, DTLS, SCTP), a data channel opens and a message crosses.
// arm64 through the Android 16 x86_64 image's ARM bridge (libndk_translation), after `adb root`:
//   aarch64-linux-android26-clang -I<libdatachannel>/include/rtc/.. -o abxt loopback-check.c -L prebuilt/arm64-v8a -ldatachannel -llog -Wl,-rpath,/data/local/tmp
//   adb push abxt prebuilt/arm64-v8a/libdatachannel.so /data/local/tmp; adb shell 'cd /data/local/tmp && chmod +x abxt && ./abxt'   (exit 0 = message received)
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <rtc/rtc.h>

static int pc1, pc2, dc1, dc2;
static volatile int open1, open2, got;
static char gotmsg[128];

static void l1(int pc, const char *sdp, const char *type, void *p) { rtcSetRemoteDescription(pc2, sdp, type); }
static void l2(int pc, const char *sdp, const char *type, void *p) { rtcSetRemoteDescription(pc1, sdp, type); }
static void c1(int pc, const char *c, const char *mid, void *p) { rtcAddRemoteCandidate(pc2, c, mid); }
static void c2(int pc, const char *c, const char *mid, void *p) { rtcAddRemoteCandidate(pc1, c, mid); }
static void o1(int id, void *p) { open1 = 1; }
static void o2(int id, void *p) { open2 = 1; }
static void m2(int id, const char *m, int size, void *p) { if (size < 0) { snprintf(gotmsg, sizeof gotmsg, "%s", m); got = 1; } }
static void ondc(int pc, int dc, void *p) { dc2 = dc; rtcSetOpenCallback(dc, o2); rtcSetMessageCallback(dc, m2); }
static void st(int pc, rtcState s, void *p) { printf("pc%d state %d\n", pc == pc1 ? 1 : 2, (int)s); }

int main(void) {
  rtcPreload();
  rtcConfiguration cfg; memset(&cfg, 0, sizeof cfg);
  pc1 = rtcCreatePeerConnection(&cfg); pc2 = rtcCreatePeerConnection(&cfg);
  printf("created pc1=%d pc2=%d\n", pc1, pc2);
  if (pc1 < 0 || pc2 < 0) return 2;
  rtcSetLocalDescriptionCallback(pc1, l1); rtcSetLocalDescriptionCallback(pc2, l2);
  rtcSetLocalCandidateCallback(pc1, c1); rtcSetLocalCandidateCallback(pc2, c2);
  rtcSetStateChangeCallback(pc1, st); rtcSetStateChangeCallback(pc2, st);
  rtcSetDataChannelCallback(pc2, ondc);
  dc1 = rtcCreateDataChannel(pc1, "abx"); rtcSetOpenCallback(dc1, o1);
  for (int i = 0; i < 300 && !(open1 && open2); i++) usleep(100000);
  printf("open1=%d open2=%d\n", open1, open2);
  if (!(open1 && open2)) return 3;
  rtcSendMessage(dc1, "hello from arm64", -1);
  for (int i = 0; i < 50 && !got; i++) usleep(100000);
  printf("message received: %s\n", got ? gotmsg : "(none)");
  rtcDeletePeerConnection(pc1); rtcDeletePeerConnection(pc2); rtcCleanup();
  return got ? 0 : 4;
}
