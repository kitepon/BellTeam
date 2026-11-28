# Native part of the Approval Box client (Kitepon.ApprovalBox.Client) on Linux

`libdatachannel.so` is libdatachannel v0.24.6 (commit 6b1e2e620f1e37f0eafeee702eaea0043cb305fd, submodules at the commits below), the same engine as the Windows `datachannel.dll` and the TypeScript connector of kitepon/peer-channel. `Kitepon.ApprovalBox.Client` (`PeerChannel/Native.cs`, library name `datachannel`) calls it through P/Invoke (library name `datachannel`, which Linux resolves to `libdatachannel.so` beside the app).

The built x64 file and its SHA-256 are in `prebuilt/linux-x64/` (committed, 8.2 MB stripped; Nayuta 2026-11-22: mirroring is fine with the hash, the commits and the recipe next to it). Users never build it.

## Recipe (the Linux seat, Neon; no gcc is needed)
- Toolchain: zig 0.17.1 as the C/C++ compiler, target `x86_64-linux-gnu.2.31` (the file needs glibc 2.30 or older symbols only; checked with `readelf -V`); cmake 3.31.6 + ninja.
- OpenSSL 3.6.5, static, built with the same zig target: `./Configure linux-x86_64 no-shared` into a prefix, then `-DOPENSSL_ROOT_DIR=<prefix>`.
- libdatachannel: `git clone --recursive`, checkout 6b1e2e62; submodules: deps/json 55f9368, deps/libjuice b89c792, deps/libsrtp 24b3bf8, deps/plog 94899e0, deps/usrsctp fec583d (master).
- `cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DBUILD_SHARED_DEPS_LIBS=OFF -DNO_MEDIA=ON -DNO_WEBSOCKET=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON -DCMAKE_SHARED_LINKER_FLAGS=-static-libstdc++ -DOPENSSL_ROOT_DIR=<prefix> -DCMAKE_C_COMPILER=<zig cc wrapper> -DCMAKE_CXX_COMPILER=<zig c++ wrapper>`; the wrappers are `exec zig cc -target x86_64-linux-gnu.2.31 "$@"` (and `c++`, `ar`, `ranlib`).
- Strip: `llvm-strip --strip-unneeded` (Android NDK 28.2). The bytes are not reproducible; the committed `libdatachannel.so.sha256` is the reference.

The library needs only libc, libm, libpthread and libdl; OpenSSL and libstdc++ are inside it. Licenses: libdatachannel and libjuice MPL-2.0, libsrtp and usrsctp BSD, plog and nlohmann/json MIT, OpenSSL Apache-2.0. Only x86_64: arm64 Linux has none yet.
