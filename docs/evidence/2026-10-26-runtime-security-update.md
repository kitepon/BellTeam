# Runtime security update candidate

This candidate updates the app SDK from 1.30.0 to 1.32.2 and resolves the related
runtime lock entries to body-parser 2.4.0, fast-uri 3.1.9, proxy-addr 2.0.8,
Zod 4.6.7, Express 5.3.0, Hono 4.13.14 and ip-address 10.7.5. The direct jose
dependency is 6.2.13. Native CLI/global tools, API endpoints, authentication
settings and production deployment are unchanged by this source delta.

The app's internal HTTP MCP endpoint uses the low-level SDK `Server`, rather
than `McpServer`. Its separately parsed request body bypasses the transport's
body reader, and `maxToolInputElements` is a high-level `McpServer` option.
Updating the SDK alone therefore does not impose the required input budget here.
The existing JSON reader now accepts at most 4 MiB and 10,000 JSON members or
array entries, including the envelope, before SDK validation. Oversized input
returns HTTP 413 without calling a tool. REST JSON limits and the streaming
call-bridge relay retain their existing behavior. Legitimate MCP requests above
either ceiling now fail explicitly; callers must submit smaller inputs.

Primary references:

- [SDK validation memory exhaustion, CVE-2026-111768](https://github.com/advisories/GHSA-46jr-4wx8-v453): upgrade plus input/body limits; not an upgrade-only mitigation.
- [SDK tasks, CVE-2026-111767](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-22jm-h49p-29qw): the app does not configure `taskStore`.
- [SDK OAuth issuer, CVE-2026-104850](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h): the app's Aiterm client is stdio, without an OAuth provider.
- [body-parser, CVE-2026-111181](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828): transitive installed dependency; the app HTTP routes do not use Express/body-parser middleware.
- [fast-uri authority, CVE-2026-84292](https://github.com/advisories/GHSA-qw65-cvwx-89v3) and [host confusion, CVE-2026-84394](https://github.com/advisories/GHSA-58mr-gqgx-xq4g).
- [proxy-addr, CVE-2026-90711](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) and [Zod, CVE-2023-54404](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

These observations describe the app source only, not dependency trees inside
global CLI tools or external products. No production exploit, auth, request
replay or host probe was performed. Updating constrained-collection validation
does not bound arbitrary unbounded schemas; the MCP reader budget remains needed.

Validation so far: three new synthetic loopback HTTP input-boundary tests pass;
the original two oversize cases failed before the reader change even with the
updated SDK. Thirteen existing seat-MCP/execution-source tests passed with the
updated dependencies. A new fixture initially omitted `registry.refresh`; its
normal-request assertion was corrected without a product-code change. Each local
test process used a 256 MiB heap with one test worker. Production-only `npm audit`
reports zero findings for this candidate lock; that is not a reachability proof
or an installed-production result. The full suite is pending one bounded
nonproduction CI run, rather than a main-server full run.

The accepted c5 image still contains the old app dependency bytes. Its unchanged
Native/CLI and feature evidence is retained, while its acceptance cannot prove
this changed source/image. A new exact candidate requires source review,
appropriate CI and a new image binding before any release or production action.
