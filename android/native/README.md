# Native part of BellTeam.PeerChannel on Android

`libdatachannel.so` is libdatachannel v0.24.6 (commit 6b1e2e620f1e37f0eafeee702eaea0043cb305fd, the same engine and submodule commits as `linux/native/README.md`), built for `arm64-v8a` and `x86_64` and packed into the APK by `BellTeam.Android.csproj` (`AndroidNativeLibrary`). `windows/BellTeam.PeerChannel/Native.cs` calls it through P/Invoke (library name `datachannel`, which Android resolves to `libdatachannel.so` in the app's native library directory). The SHA-256 of each stripped file is beside it in `prebuilt/<abi>/`.

## Recipe (the Linux seat, Neon)
- NDK 28.2.13676358 (`android.toolchain.cmake`, `-DANDROID_ABI=<abi> -DANDROID_PLATFORM=android-26`), cmake 3.31.6 + ninja. Android 26 is the app's minimum API.
- OpenSSL 3.6.5, static, per ABI: `./Configure android-arm64` / `android-x86_64` with `ANDROID_NDK_ROOT`, no-shared, into a prefix, then `-DOPENSSL_ROOT_DIR=<prefix>`.
- libdatachannel: `git clone --recursive`, checkout 6b1e2e62 (submodules as in `linux/native/README.md`); `cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DBUILD_SHARED_DEPS_LIBS=OFF -DNO_MEDIA=ON -DNO_WEBSOCKET=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON`.
- Strip: NDK `llvm-strip --strip-unneeded`. The bytes are not reproducible; the committed `libdatachannel.so.sha256` is the reference. LOAD segments are 16 KB aligned (Android 15+ page size).

The library needs only liblog, libm, libdl and libc; OpenSSL and the C++ runtime are inside it. Licenses: as in the Linux README.

Checked: the x86_64 file loads on the Android 16 emulator (API 36) and exports `rtcCreatePeerConnection`. The arm64-v8a file passed `loopback-check.c` (2026-11-23) on that image through its ARM bridge (libndk_translation): two peer connections connect on loopback, a data channel opens and a message crosses. That is the .so on a translated arm64 CPU, not a real phone. The whole app does not run there: the arm64-only .NET app freezes (ANR, main thread in a futex wait) under the bridge on the first screen change even with the Approval Box part off, so the part has not run inside the app on arm64.
