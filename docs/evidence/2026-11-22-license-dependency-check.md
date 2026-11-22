# License choice and dependency license check (2026-11-22, Molly)

Owner chose MIT on Poli's card (2026-11-21 23:3x JST): `LICENSE` at the repo root, "Copyright (c) 2026 kitepon", the same line Throughline, yui and unai use; `"license": "MIT"` in `package.json`. Existing third-party notices stay as they are (`config/ponytail-LICENSE`, MIT, DietrichGebert/ponytail).

Dependency check (declared direct dependencies; transitive native packages were not restored):

| Area | Dependency | License | Note |
| --- | --- | --- | --- |
| server (npm, 143 packages in the lock) | 125 MIT, 9 ISC, 4 BSD-3-Clause, 2 BSD-2-Clause, 1 Apache-2.0, 1 0BSD, 1 MPL-2.0 | permissive, one weak copyleft | `web-push` is MPL-2.0 (production dependency): file-level copyleft, no effect on MIT code that only uses it unmodified; changes to web-push's own files would have to be shared. Nothing GPL/AGPL/LGPL, no non-commercial or source-available (SSPL/BUSL) license. |
| Windows / Linux / Android (NuGet) | Avalonia, Avalonia.Android/Desktop/Headless/Themes.Fluent 12.1.6 | MIT | |
| | Markdig 1.4.0 | BSD-2-Clause | |
| | Tmds.DBus.Protocol 0.94.1 | MIT | |
| | Xamarin.Firebase.Messaging 125.1.3 | MIT AND Apache-2.0 | binding MIT, Firebase SDK Apache-2.0 |
| | Microsoft.Web.WebView2 1.0.4258.31 | Microsoft BSD-style (LICENSE.txt in the package) | redistribution allowed with the notice kept |
| tests only | xunit 2.9.3, xunit.runner.visualstudio 4.0.1 (Apache-2.0), Microsoft.NET.Test.Sdk 18.10.1 (MIT) | permissive | not shipped |
| iOS / Mac (SwiftPM) | ChatLayout (ekazaev), EnrichedMarkdown (quolu/enriched-markdown-ios) | MIT, MIT | per the GitHub license of each repository |

Not checked: the transitive closure of the NuGet and SwiftPM packages (no restore here), Apple/Google platform SDK terms, the AI CLIs a user installs (Claude Code, Codex and the like; they are not part of this repository).
