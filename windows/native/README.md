# Native part of BellTeam.PeerChannel

`datachannel.dll` is libdatachannel v0.24.6 (commit 6b1e2e620f1e37f0eafeee702eaea0043cb305fd, the same engine as the TypeScript connector of kitepon/peer-channel), called through P/Invoke by `BellTeam.PeerChannel/Native.cs`.

**Users never build it.** The built x64 DLL and its SHA-256 live in `prebuilt/win-x64/` (committed, 6.4 MB; Tronie's ruling 2026-11-22). `BellTeam.PeerChannel.csproj` copies it into the build and publish output (not for `win-arm64`, which has none yet), and `scripts/install-windows.ps1` refuses to install when the published file does not match `datachannel.dll.sha256`.

Why it is in the repo: no Windows CI exists yet. When one does, build it there from the pinned source and attach it to the release instead.

Rebuild (developer machine only; MSVC build tools, CMake, Ninja, git): `pwsh windows/native/build-libdatachannel.ps1`, then commit the DLL and `.sha256` together. The script pins libdatachannel, its five submodules, vcpkg (2026.10.16, 9eec002d) and OpenSSL 3.6.5 (static, `x64-windows-static-md`) and stops on any other commit or version; the DLL bytes are not reproducible, so the committed `.sha256` is the reference.
The DLL carries OpenSSL statically and needs only the Visual C++ runtime. Licenses: libdatachannel and libjuice MPL-2.0, libsrtp and usrsctp BSD, plog and nlohmann/json MIT, OpenSSL Apache-2.0; sources are the pinned commits in the build script.
