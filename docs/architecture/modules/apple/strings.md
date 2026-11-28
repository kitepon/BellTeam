# UI text resources (string catalogs)

[README](README.md) / [機能索引](function-index.md)。Owner 2026-11-28: all user-facing text is multilingual, same spec on every platform. Step 1 (this page): text lives in string catalogs, Japanese is the source language, the app looks the same. Step 2 (CI AI translation from the shared glossary) is not here.

**Contract:** this change stays within UI text resources only. No function, I/O, state or connection changes; no diagram other than this page changes.

## Where text lives
| Target | Catalog | Filled by |
|---|---|---|
| App (iPhone/iPad/Mac Catalyst) | `ios/BellBot/BellBot/Resources/Localizable.xcstrings` | build extraction (`SWIFT_EMIT_LOC_STRINGS`, `LOCALIZATION_PREFERS_STRING_CATALOGS` in project.yml) |
| App Info.plist usage texts | `BellBot/Resources/InfoPlist.xcstrings` | by hand (4 keys) |
| Share extension | `ShareExtension/Localizable.xcstrings` | build extraction |
| Notification service | `NotificationService/Localizable.xcstrings` | build extraction |

Language follows the OS setting; there is no in-app picker.

## Rules in code
- SwiftUI literals (`Text("…")`, `Button`, `Label`, `navigationTitle`…) are extracted by the compiler. A custom component that only shows a literal takes `LocalizedStringKey`.
- Text held in a `String` (models, errors, enum titles) uses `String(localized: "…")`. Interpolation stays inside one literal (it becomes a format placeholder); text is never built by concatenation.
- Stored enum raw values stay as keys; their labels come from a computed `title`.
- User-facing dates use `setLocalizedDateFormatFromTemplate` (time zone Asia/Tokyo kept); wire formats (ISO 8601, yyyy-MM-dd) are not user text.
- Known limit: punctuation joiners are still Japanese; see "Joiners (step 2)".

## Check
`scripts/check-apple-strings.py <build dir>` reads the compiler's `*.stringsdata` and fails when a Japanese string literal in app code is not extracted (not a SwiftUI literal or `String(localized:)`). Not-UI-text lines go in `ios/BellBot/string-literals-allowed.txt` (fixtures, logs, stored keys). Build both iOS and Mac Catalyst before running it: some text sits under `#if targetEnvironment(macCatalyst)`. It runs in the ship preflight (`ship.sh`) after the build.

## Layout fit data (Owner 11/28: layout never changes)
`scripts/apple-string-sites.py <build dir> <out.json>` records, for each catalog key, every call site (file, line) and the layout limits written on that view chain (`lineLimit`, `minimumScaleFactor`, fixed frame width, `fixedSize`, `truncationMode`). The translation step reads it to fit each string. Limits that come from a parent container are not seen (limits is empty then); the per-language screenshot check catches overflow.

## Joiners (step 2 plan)
Twelve sites still join pieces with 「、」 or 「・」 in code (RunningExclusions:68, ApprovalsView:197/744, SettingsStatus:281, GoalsView:381, MachineEventView:263, UpdateView:154/157/164/230, LatticeListView:498, ConversationView:343/1343). Plan, one change per kind, ja output kept identical where the ja source says so:
- **Lists of names** (members, fields, components, labels): `ListFormatter.localizedString(byJoining:)` (OS locale; ja gives 「A、B、C」, en gives "A, B, and C"). Sites that today join with 「・」 (ApprovalsView:744, GoalsView:381, UpdateView:157, SettingsStatus:281) keep 「・」 in ja through a catalog format string per list kind (`"\(a)・\(b)"` placeholders) and take the list formatter in other languages.
- **Meta separators** (ConversationView:1343 name · time): one catalog format string `"\(name)・\(time)"`.
- **Fragments with a leading 「、」** (LatticeListView:498 accessibility label): one catalog format string for the whole label instead of appended pieces.
After the change the entries leave string-literals-allowed.txt (SettingsStatus:281 and ConversationView:1343).
