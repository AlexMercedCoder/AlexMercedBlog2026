---
title: "An MCP Upgrade Calendar for Data Platforms: Planning Around the Six-Month Specification Cadence"
description: "MCP now ships on a six-month cadence. Here is the milestone calendar, the SEP review checklist and the CI plan data platform teams need to follow it."
date: 2026-11-16T09:00:00Z
tags: ["MCP", "Protocol Design", "AI Agents", "Data Platform", "Release Management"]
canonical: https://datalakehousehub.com/blog/mcp-upgrade-calendar-data-platforms/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/mcp-upgrade-calendar-data-platforms/).

MCP now ships specification releases on a six-month schedule, generally the last Tuesday of March and September, starting with 2027-03-30. Proposals freeze about 2.5 months before release, Tier 1 SDK betas follow about 1.5 months before, and a hard freeze lands a month out. Data platforms can pin versions and test against betas early.

The Model Context Protocol (MCP) project announced the new cycle on November 11, 2026 ([MCP blog](https://blog.modelcontextprotocol.io/posts/mcp-release-cycle/)). Luca Chang joins Den Delimarsky and David Soria Parra as a release manager for the next cycle. The post is explicit that nothing changes for existing clients and servers because of the announcement. What changes is that everyone now knows when the spec will move.

For teams running MCP servers in front of catalogs, query engines, and semantic layers, a predictable spec is a planning tool. This article turns the announcement into a calendar you can map to your own test and rollout windows. It is about tracking an upstream protocol. Shipping your own agent's prompts, tools, and models is a different discipline, covered in [Release Management for Data Agents](https://datalakehousehub.com/blog/release-management-data-agents/), which is the primary page on agent releases on this site.

## What changed, and what did not

MCP specification versions have always been named by date. The date marks the last backwards-incompatible change in that revision. The history shows irregular gaps between revisions:

| Version | Headline changes | Gap from previous |
| --- | --- | --- |
| 2024-11-05 | Initial spec: JSON-RPC messages, tools, resources, prompts, stdio and HTTP with SSE transports | n/a |
| 2025-03-26 | OAuth 2.1 authorization, Streamable HTTP, tool annotations | about 4.6 months |
| 2025-06-18 | Structured tool output, elicitation, removal of JSON-RPC batching | about 2.8 months |
| 2025-11-25 | OpenID Connect discovery, experimental tasks, JSON Schema 2020-12 default | about 5.3 months |
| 2026-07-28 | Stateless core, `server/discover`, Multi Round-Trip Requests, extensions framework, formal deprecation policy | about 8 months |

The gaps range from under three months to eight. Each release arrived when its proposals were ready, which made it hard for SDK maintainers and server operators to plan. The version timeline above is compiled in an [independent history of MCP versions](https://hidekazu-konishi.com/entry/mcp_specification_version_timeline.html).

The November 11 announcement fixes the schedule instead. Releases come every six months, generally on the last Tuesday of March and September. The next release is 2027-03-30. The one after is planned for September 28, 2027.

Here is what stays the same:

- **Version identifiers.** The post says specification versions continue to use dates. A pinned version string keeps its format.
- **Version negotiation.** The change is to release preparation, not to MCP messages or how clients and servers agree on a version.
- **Your current code.** There is nothing to change in an existing client or server because of the announcement.

What changes is predictability. Proposals that are not ready move to a later release instead of delaying the spec. If a Tier 1 SDK misses its beta date, the gap is documented and the spec ships anyway.

## The milestones, counted back from release day

The post gives each milestone as a time before release day. Applied to the 2027-03-30 release, the calendar looks like this. The calendar months are my approximations from the stated offsets.

| Milestone | Offset before release | Approximate date for 2027-03-30 |
| --- | --- | --- |
| Planning | 8 months | Concluded in August 2026 |
| Core Maintainer reviews begin | 6 months | Late September 2026 |
| Soft freeze | 2.5 months | Mid-January 2027 |
| Tier 1 SDK betas | 1.5 months | Mid-February 2027 |
| Hard freeze | 1 month | Late February 2027 |
| Release | 0 | March 30, 2027 |

Each milestone means something specific.

**Core Maintainer reviews** run from six months out until the soft freeze. Specification Enhancement Proposals (SEPs) under review during this period can still change shape.

**Soft freeze** is the scope deadline. Every proposal going into the release must be marked Final and merged. After that, only fixes, polish, and in-scope clarifications are accepted. New features and substantial redesigns are not.

**Tier 1 SDK betas** are where implementation testing starts. The SDKs at the highest support tier ship beta versions that implement the frozen spec. This is the first point at which you can run real code against the next revision.

**Hard freeze** locks the text. Only critical security fixes, or fixes for release-blocking correctness or interoperability problems, can go in, and only through a full Core Maintainer vote.

**Release** makes the new revision current.

The post links to the SDK tiers page for what Tier 1 means. As an example of the bar, the Ruby SDK reached Tier 1 on October 30, 2026, with full support for the 2026-07-28 spec and a 100 percent conformance pass rate, according to the MCP blog.

## Why data platforms care more than most

Many MCP servers are thin wrappers around one API. A protocol upgrade for them is a library bump. Data platform MCP servers are different in three ways.

**They hold state that matters.** A query tool runs SQL against governed tables, applies the caller's permissions, and sometimes writes data. A protocol change that alters how requests are routed or retried touches correctness, not just plumbing.

**They sit behind gateways.** Most data platforms put an MCP gateway in front of their servers for authentication, policy, and logging. A protocol revision has to be supported by the gateway, the server SDK, and every client that connects, before you can turn it on. The controls gateways enforce are compared in the [Agent Gateway Control Matrix](https://datalakehousehub.com/blog/agent-gateway-control-matrix/).

**They serve many clients at once.** Desktop assistants, IDE agents, internal agent runtimes, and partner agents all connect to the same server. They upgrade on their own schedules. Your server has to support more than one protocol revision at a time.

The 2026-07-28 revision showed how much a single release can change for this kind of server. It removed the `initialize` handshake and session IDs from the core, added `server/discover`, and introduced Multi Round-Trip Requests, header-based routing, cacheable list results, and authorization hardening. The data platform implications of that release are covered in [MCP 2026-07-28 Spec: Stateless MCP for Data Platforms](https://iceberglakehouse.com/posts/mcp-2026-07-28-stateless-spec-data-platforms/) on IcebergLakehouse.com. A predictable calendar means the next change of that size arrives on a date you know.

## Start with an inventory of everything that speaks MCP

A calendar is only useful if you know what it applies to. Before the next cycle, list every component in your data platform that sends or receives MCP traffic.

**Servers you build.** Query tools, catalog browsers, semantic layer tools, data quality checkers, and ingestion helpers. For each, record the SDK and its version, the protocol revisions it accepts, and which extensions it implements.

**Servers you run but did not build.** Vendor MCP servers for your warehouse, catalog, BI tool, or observability stack. You control when you deploy their updates, not when they ship. Record their published support for each revision.

**Gateways and proxies.** Anything between clients and servers that parses MCP, enforces policy, or logs requests. A gateway that inspects JSON-RPC bodies is sensitive to protocol changes in ways a plain TLS proxy is not.

**Clients you control.** Internal agent runtimes, scheduled agent jobs, and internal tools. You choose when these upgrade.

**Clients you do not control.** Desktop assistants, IDE agents, and partner agents. You only observe these, through gateway logs.

The inventory turns the calendar into a work plan. When a new revision freezes, you know exactly which components need an impact review and who owns each one.

## How to read a SEP for data platform impact

Specification Enhancement Proposals are written for the whole MCP community. Most of their text is not about data platforms. These questions pull out what matters during the review window.

1. **Does it change authorization?** Any change to token handling, scopes, client registration, or authorization discovery affects who can reach your tables. Read these first and in full.
2. **Does it change how requests are routed or retried?** Stateless designs, retries, and multi-round-trip patterns affect tools that write data. A retried write tool must not run twice.
3. **Does it change tool results?** Structured output, content types, and size handling affect how query results reach clients.
4. **Does it change long-running operations?** Queries take time. Changes to tasks, progress, and cancellation decide whether long queries work through MCP at all.
5. **Does it change discovery or listing?** Changes to `server/discover` or list caching affect how clients learn which tools and resources exist.
6. **Does it deprecate something you use?** Deprecations give you at least one release of notice. Use it.

Write one line per question per SEP in your impact list. Most answers will be "no." The few "yes" answers are your work for the cycle.

## Conformance tests for data tools

SDK conformance suites check that an SDK implements the protocol correctly. They do not check that your tools behave correctly under a new revision. Build a small suite of your own that runs in the CI matrix above.

Cover these cases at minimum:

- **Authentication and authorization.** A valid token reaches the tool. An expired token is rejected. A token for a user without table access gets an authorization error, not an empty result.
- **Discovery.** `server/discover` returns the expected tools and extensions for each enabled revision.
- **A read query.** A simple query returns the expected rows with correct types.
- **A large result.** A query whose result exceeds your inline limit returns a truncated result or a file, whichever your tool promises.
- **A long-running query.** A query that takes longer than your timeout reports progress or completes through whatever long-running mechanism your revision supports.
- **A retried write.** A write tool called twice with the same request does not write twice.
- **Cancellation.** A cancelled query stops consuming engine resources.
- **Version mismatch.** A client requesting an unsupported revision gets a clear error.

Run the suite against a staging catalog with real permissions. Mocked authorization hides exactly the failures that matter most.

## Talking to client owners

Many of the clients that hit your servers belong to other teams or other companies. A predictable spec calendar makes it possible to give them predictable notice.

Publish a short support policy for your MCP servers. State which protocol revisions you support today, how long you keep supporting a revision after a new one ships, and where you announce changes. A policy that says "we support the current and previous MCP revisions, and retire older ones at the next release" is easy to follow and matches the six-month cadence.

Announce at two points in each cycle. At the soft freeze, tell client owners what is coming and when your servers will support it. Before you retire a revision, tell them which clients your logs show still using it. The gateway log of `MCP-Protocol-Version` values is the evidence that makes that second message specific.

## Mapping the calendar to your environments

Here is how I map the MCP milestones to a data platform's own process. The goal is to test early, roll out after clients are ready, and never be the last system blocking an upgrade.

**From reviews to soft freeze: watch scope.** Read the SEPs heading for the release. Note anything that touches authorization, transport, tool results, or long-running operations, since those affect data tools most. If a proposal breaks an assumption your server makes, comment during review. This is the only window where feedback changes the spec.

**At soft freeze: write the impact list.** The scope is now fixed. List every change and mark whether it affects your server, your gateway, or your clients. This list drives everything after.

**At Tier 1 SDK betas: test in staging.** Build your server against the beta SDK in a branch. Run your conformance tests and your own integration tests against a staging catalog. Point at least one beta client at it.

**At hard freeze: finish the server branch.** The text will not change except for critical fixes, so the server work can complete. Hold the merge until release.

**At release: ship the server with both revisions enabled.** Your server should accept the new revision and the previous one. Clients that have not upgraded keep working.

**Release plus one to three months: watch client adoption.** Log which protocol revision each client connects with. When a client you depend on upgrades, test it against production.

**Before the next release: retire the oldest revision.** Once logs show no client using a revision older than the previous one, remove support for it. Do this deliberately, with notice to client owners.

## Version pinning and negotiation in practice

MCP clients and servers agree on a protocol version for each connection. Over HTTP, clients send the negotiated version in the `MCP-Protocol-Version` header on requests, a rule the spec has carried since the 2025-06-18 revision. That header is the easiest place to observe and control versions at a gateway.

You can check what a server accepts with a plain HTTP request:

```bash
curl -s https://mcp.data.example.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}'
```

The `MCP-Protocol-Version` header states which revision the client speaks. The body calls `server/discover`, the discovery method introduced in 2026-07-28, which returns the server's capabilities and supported extensions. A server that does not support the requested revision returns an error, which tells you exactly where a client and server disagree. Replace the URL and token with your own.

At the gateway, log the header on every request. That one field answers "which clients still use the old revision" without any client-side instrumentation. Some gateways can also route by header, sending older revisions to a server build that still supports them while new revisions go to the current build. Use that only as a transition aid. Running two server builds long term doubles your testing.

Pin versions in three places:

1. **Server SDK version** in your dependency lock file. Never float on a major version range for an MCP SDK.
2. **Supported protocol revisions** in server configuration, as an explicit list, so enabling or retiring a revision is a reviewed change.
3. **Gateway policy** listing which revisions are allowed to reach which servers.

## Testing against SDK betas in CI

The Tier 1 SDK betas are the most useful milestone for server teams. They give you code to test against six weeks before release. A CI matrix that builds your server against both the current SDK and the beta keeps the two paths visible.

```yaml
name: mcp-server-compat

on:
  push:
    branches: [main]
  schedule:
    - cron: "0 6 * * 1"

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        sdk: ["current", "beta"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Install current SDK
        if: matrix.sdk == 'current'
        run: pip install -r requirements.lock
      - name: Install beta SDK
        if: matrix.sdk == 'beta'
        run: |
          pip install -r requirements.lock
          pip install --pre --upgrade mcp
      - name: Run integration tests against staging catalog
        run: pytest tests/integration --catalog-url "$STAGING_CATALOG_URL"
        env:
          STAGING_CATALOG_URL: ${{ secrets.STAGING_CATALOG_URL }}
```

The workflow runs on every push to main and every Monday morning. The matrix builds the server twice. One job installs the locked dependencies as they are. The other installs them and then upgrades the MCP SDK to the latest pre-release with `--pre`, which picks up beta versions. `fail-fast: false` keeps the current-SDK job running even if the beta job fails, so a beta break never hides a real regression. The integration tests run against a staging catalog whose URL comes from a repository secret. The example uses the Python SDK package. Adjust the install steps for your language.

Treat beta failures as information, not blockers, until the hard freeze. After the hard freeze, a beta failure is a release blocker for your next server version.

## Vendor servers: questions to ask now

If your platform runs MCP servers that a vendor builds, such as the server for your warehouse, catalog, or BI tool, your upgrade calendar depends on theirs. The new cadence gives you a natural moment to ask each vendor four questions.

1. **When will your server support the 2027-03-30 revision?** A vendor that plans around the published calendar can give you a target relative to release day.
2. **How long will you support the previous revision after that?** You need overlap long enough for your clients to upgrade.
3. **Which SDK and tier do you build on?** That tells you whether their beta testing can start in mid-February.
4. **Where do you announce protocol support changes?** Subscribe, and add the source to your impact list routine.

Record the answers in your inventory. When a vendor's plan lags the spec by months, you know before your clients find out.

## Budgeting the work

A predictable cadence also makes the cost of protocol upgrades predictable. Teams that budget for it avoid the scramble that unannounced releases used to cause.

For each server you build, plan for a fixed amount of work per cycle across four activities: reading proposals during review, writing the impact list at soft freeze, building and testing against betas, and the release rollout. The size of each depends on how much of the protocol your server uses. A read-only query tool with no extensions has a small impact list. A server with write tools, long-running queries, and several extensions has a larger one.

Track the effort for the March 2027 cycle. After one or two cycles, you will know your real cost per release, and protocol upgrades become a line item in quarterly planning rather than a surprise. Two releases a year at known dates fit cleanly into a quarterly planning rhythm, with Tier 1 SDK betas arriving around mid-February and mid-August each year.

## When an SDK is late

The new policy says a late Tier 1 SDK gets its gap documented while the spec ships on schedule. That protects the protocol's calendar. It moves the risk to you if your server depends on that SDK.

Plan for it in three ways.

- **Know which SDK you depend on, and its tier.** A server built on a lower-tier SDK has no beta milestone to count on.
- **Decouple your rollout from release day.** Your server does not need the new revision on release day. It needs it when the clients you serve adopt it. Base your date on client adoption, not on the spec date.
- **Keep the previous revision enabled.** If your SDK is late, your server keeps serving every client on the previous revision without disruption.

## What to plan for in the 2027-03-30 release

The scope of the March release is not fixed until the soft freeze in mid-January. Several threads from the past few months are likely candidates for data platform teams to watch. Treat this as a watch list, not a forecast.

**Extensions maturing.** The 2026-07-28 revision introduced an extensions framework. Extensions such as the experimental file transfer extension, introduced on November 10, ship on their own track. A data platform that adopts extensions needs to track their versions as well as the core spec. The file extension deserves its own impact review, since it changes how query results leave your platform.

**Deprecations taking effect.** The 2026-07-28 revision formalized a deprecation policy and marked roots, sampling, and logging as deprecated rather than removed. If your server or clients use any of these, check whether the March release removes them, and plan replacements before the soft freeze.

**Authorization changes.** Authorization has changed in nearly every MCP revision. Data platforms carry the most risk here, because authorization decides who reads which tables. Read every authorization-related SEP in the March cycle closely.

## A one-page plan for the March 2027 cycle

Here is the whole plan, compressed for a team wiki.

- **Now through mid-January:** Read SEPs in review. Comment on anything affecting authorization, transport, tool results, or long-running operations. Confirm your SDK's tier.
- **Mid-January (soft freeze):** Write the impact list for your server, gateway, and clients.
- **Mid-February (Tier 1 betas):** Turn on the beta job in CI. Build a server branch against the beta. Test in staging with at least one beta client.
- **Late February (hard freeze):** Finish the server branch. Update gateway policy for the new revision.
- **March 30 (release):** Ship the server with both revisions enabled. Start logging protocol revisions per client.
- **April through June:** Upgrade clients you control. Track adoption of clients you do not.
- **Before the September 2027 cycle:** Retire revisions older than the previous one, with notice.

## Failure modes

**Upgrading the server before the gateway.** A server that speaks the new revision behind a gateway that rejects it looks like an outage to every upgraded client. Upgrade the gateway first, or at least confirm it passes unknown revisions through.

**Dropping the old revision too early.** Desktop and IDE clients upgrade on their users' schedules. Removing the previous revision on release day breaks them. Keep at least two revisions enabled through each transition.

**Floating SDK versions.** A server that installs the latest SDK at build time picks up betas and breaking changes without review. Lock dependencies, and use the CI matrix to test the next version deliberately.

**Ignoring extensions.** Extensions version separately from the core spec. A core upgrade that passes tests still breaks an extension a client depends on. Include extension behavior in integration tests.

**Skipping the review window.** The only time feedback shapes a revision is before the soft freeze. A data platform team that first reads a release at the beta stage can only adapt to it. Put a recurring reminder at the start of each review period, and assign one person to read the proposals.

**Caching list results across revisions.** The 2026-07-28 revision made list results cacheable. A client or gateway that caches tool lists keyed only by server URL serves stale lists after you enable a new revision with different tools. Include the protocol revision in cache keys, and clear caches when you change a server's supported revisions.

**Treating the calendar as a deadline.** The spec ships on a date. Your server ships when its clients are ready and your tests pass. Do not rush a data platform change to match a protocol release.

## Conclusion

MCP's move to a six-month cadence gives data platform teams something they have not had before: a known date for every protocol change. Releases land on the last Tuesday of March and September. Scope freezes about two and a half months out. Tier 1 SDK betas arrive about six weeks out. The text locks a month out.

Use those dates. Read proposals during review, write an impact list at the soft freeze, test against betas in CI, and ship your server with two revisions enabled. Base your rollout on client adoption, log protocol revisions at the gateway, and retire old revisions on your schedule, not the spec's.

## Keep Going

If this piece was useful, I have written a lot more on running agent infrastructure in front of lakehouse data. My books cover lakehouse architecture, governed agent access, and open standards such as MCP, Apache Iceberg, and Apache Polaris. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
