# Builds datachannel.dll (libdatachannel v0.24.6, the C API that BellTeam.PeerChannel calls through P/Invoke) into windows/native/prebuilt/win-x64 with datachannel.dll.sha256: the committed pair that install-windows.ps1 ships and checks. Run it only on a developer machine; users never build.
# MSVC (VS 2022 Build Tools, C++ x64 tools), CMake, Ninja and git must exist. OpenSSL comes from vcpkg, linked statically; no media, no websocket.
# Everything is pinned below; a different commit or package version stops the build.
param([string]$Root = (Join-Path $env:LOCALAPPDATA 'BellTeamBuild'))
$ErrorActionPreference = 'Stop'
$ldcTag = 'v0.24.6'; $ldcCommit = '6b1e2e620f1e37f0eafeee702eaea0043cb305fd'
$ldcSubmodules = @{ 'deps/json' = '55f93686c01528224f448c19128836e7df245f72'; 'deps/libjuice' = 'b89c792e3612faf2f12cf35bcc56857313a06be3'; 'deps/libsrtp' = '24b3bf8f19b6f5ab4cd2bcceb4f4064efca86fd5'; 'deps/plog' = '94899e0b926ac1b0f4750bfbd495167b4a6ae9ef'; 'deps/usrsctp' = 'fec583d54493f879d2ae44a743423bf8a04371ab' }
$vcpkgTag = '2026.10.16'; $vcpkgCommit = '9eec002df1cd109f8f104cd966a763daf9751489'
$triplet = 'x64-windows-static-md'; $opensslVersion = '3.6.5'
$out = Join-Path $PSScriptRoot 'prebuilt\win-x64'
function Run { $exe, $rest = $args; & $exe @rest; if ($LASTEXITCODE -ne 0) { throw "failed: $exe (exit $LASTEXITCODE)" } }
function Head($dir) { (& git -C $dir rev-parse HEAD).Trim() }

New-Item -ItemType Directory -Force $Root, $out | Out-Null
$vcpkg = Join-Path $Root 'vcpkg'; $ldc = Join-Path $Root "libdatachannel-$ldcTag"; $build = Join-Path $Root 'ldc-build'; $installed = Join-Path $Root 'vcpkg_installed'

if (-not (Test-Path $vcpkg)) { Run git clone --quiet --depth 1 --branch $vcpkgTag https://github.com/microsoft/vcpkg.git $vcpkg }
if ((Head $vcpkg) -ne $vcpkgCommit) { throw "vcpkg $vcpkgTag is not $vcpkgCommit" }
if (-not (Test-Path "$vcpkg\vcpkg.exe")) { & "$vcpkg\bootstrap-vcpkg.bat" -disableMetrics; if ($LASTEXITCODE -ne 0) { throw "bootstrap failed" } }
$env:VCPKG_DISABLE_METRICS = '1'
& "$vcpkg\vcpkg.exe" install "openssl:$triplet" "--x-install-root=$installed"; if ($LASTEXITCODE -ne 0) { throw "vcpkg install failed" }
$openssl = (& "$vcpkg\vcpkg.exe" list "openssl:$triplet" "--x-install-root=$installed") -join ' '
if ($openssl -notmatch [regex]::Escape($opensslVersion)) { throw "openssl is not ${opensslVersion}: $openssl" }

if (-not (Test-Path $ldc)) { Run git clone --quiet --depth 1 --branch $ldcTag --recurse-submodules --shallow-submodules https://github.com/paullouisageneau/libdatachannel.git $ldc }
if ((Head $ldc) -ne $ldcCommit) { throw "libdatachannel $ldcTag is not $ldcCommit" }
foreach ($path in $ldcSubmodules.Keys) { if ((Head (Join-Path $ldc $path)) -ne $ldcSubmodules[$path]) { throw "submodule $path is not $($ldcSubmodules[$path])" } }

$vs = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools'
cmd /c "`"$vs\VC\Auxiliary\Build\vcvars64.bat`" && set" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { Set-Item "env:$($matches[1])" $matches[2] } }
Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue
Run cmake -S $ldc -B $build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DNO_MEDIA=ON -DNO_WEBSOCKET=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON "-DCMAKE_TOOLCHAIN_FILE=$vcpkg\scripts\buildsystems\vcpkg.cmake" "-DVCPKG_TARGET_TRIPLET=$triplet" -DVCPKG_MANIFEST_MODE=OFF "-DVCPKG_INSTALLED_DIR=$installed" -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL -DCMAKE_POLICY_DEFAULT_CMP0091=NEW
Run cmake --build $build
Copy-Item (Join-Path $build 'datachannel.dll') $out -Force
$hash = (Get-FileHash (Join-Path $out 'datachannel.dll') -Algorithm SHA256).Hash.ToLower()
Set-Content -LiteralPath (Join-Path $out 'datachannel.dll.sha256') -Value $hash -NoNewline
"datachannel.dll sha256 $hash"
