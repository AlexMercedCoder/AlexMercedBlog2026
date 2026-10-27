---
title: "MCP in Regulated Environments: What the Toronto MCP Dev Summit Agenda Says About Production Agents"
description: "Registries, gateways, delegated identity, and audit: MCP Dev Summit Toronto 2026 patterns for production agents over lakehouse data."
date: 2026-10-27T09:00:00Z
tags: ["MCP", "AI agents", "security", "identity", "governance"]
canonical: https://datalakehousehub.com/blog/mcp-regulated-environments-toronto-2026/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/mcp-regulated-environments-toronto-2026/).

# MCP in Regulated Environments: What the Toronto MCP Dev Summit Agenda Says About Production Agents

An AI agent at a bank answers an analyst's question about counterparty exposure. To do it, the agent calls four Model Context Protocol (MCP) tools across three servers. One reads positions, one reads market data, one reads a risk model's output, and one writes a summary to a case management system. Every call succeeds. Every call carried a valid token. Six weeks later, an auditor asks a simple question: which human authorized the write to the case system, and what data did the agent see before it wrote?

For most MCP deployments today, nobody can answer that cleanly.

That gap, between agents that work and agents a regulated organization can defend, ran through the program of MCP Dev Summit Toronto, held October 5 and 6, 2026, at the Conference Centre at the University of Toronto. The Agentic AI Foundation, the Linux Foundation body that now stewards MCP, presented the event and framed it around production and regulated environments: identity, authorization, auditability, gateways, registries, evaluation, and reliability. Toronto's concentration of financial services engineering shaped the agenda.

I did not attend in person. This article is built from the published session abstracts and the program itself, read the way an architect reads a conference agenda: as a map of the problems practitioners consider unsolved. Where a pattern comes from a specific session, I name it. Where I connect those patterns to agent access to lakehouse data, that is my analysis, not the speakers'.

## What "Regulated" Changes About MCP

MCP's core job is simple. It gives an AI application a standard way to discover and call tools, read resources, and use prompts exposed by a server. A developer can wire an agent to a database, a ticketing system, and a file store in an afternoon.

Regulated industries such as banking, insurance, healthcare, and telecommunications add requirements that the protocol alone does not satisfy.

They need to know which tools exist and who owns each one. An unknown server running against production data is a finding in an audit, not a convenience.

They need every action tied to a real, authenticated human or a sanctioned workload identity, not to a shared service credential.

They need least privilege that holds across a chain of calls, not just at the first hop.

They need evidence. Logs have to show who asked, what the agent did, what data it touched, what policy allowed it, and what came out the other side.

They need change control. A tool whose description, code, or dependencies change without review is a production change that skipped the process.

None of those requirements are new. Banks have enforced them on human users and service accounts for decades. What is new is that an agent sits between the human and the system, composes calls the human never explicitly requested, and does it at machine speed. The sessions in Toronto were, in large part, about extending familiar controls across that new middle layer.

## Lesson One: The Registry Comes Before the Servers

The most consistent pattern across the enterprise sessions was a registry: a single source of truth for which MCP servers exist, who owns them, what they expose, and which agents are allowed to discover them.

The TELUS keynote by Kevin Ng and Dana Harrison described a shared internal registry that catalogs the MCP servers most useful across the organization, so teams discover and reuse servers instead of rebuilding the same connector. Michael Rishi Forrester's keynote on governing MCP at very large internal scale put the registry first in its architecture, as the authority on which servers exist, who owns them, and what an agent is allowed to see. A session on MCP gateways for regulated finance, by Karen Bennet and Mark Paulsen, paired a central registry for discovery with a gateway for security controls and called the combination a gateway-registry pattern.

The reason is control. Without a registry, MCP adoption looks like early SaaS adoption. Teams install servers from community lists, run them on laptops, and give them credentials. Security finds out later. A registry turns that into an intake process. A server is proposed, reviewed, assigned an owner, and published. Only published servers are reachable.

Leslie Pascual's session went a level deeper and argued that a registry entry reviewed once at submission tells you little about whether the server is safe six months later. The abstract lists what a trustworthy registry needs beyond intake review: build provenance and publisher verification, versioning and pinning so consumers do not pick up unreviewed updates, and revocation that actually propagates when a server turns out to be compromised.

For a data platform team, the registry has a concrete meaning. Every MCP server that touches lakehouse data, whether it runs SQL, reads a semantic layer, or browses a catalog, gets an entry with an owner, a data classification, the identities it acts for, and the tables or views it reaches. That entry is the thing an auditor reads first.

## Lesson Two: The Gateway Is the Single Path

The second recurring pattern was a gateway: one governed path between agents and every tool, where identity, authorization, rate limiting, and policy are enforced once instead of rebuilt in every server.

Forrester's keynote described this as the gateway sitting between agents and tools, with a separate AI gateway as the governed route to model inference, rolled out with the control plane in GitOps and admission control so an unsanctioned server cannot land. The regulated finance session framed its gateway around three concerns it called the lethal trifecta of financial enterprise risk: identity management, data exfiltration prevention, and privilege escalation. A Linux Foundation Research and Agentic AI Foundation study, presented by Hillary Curran, reported that interviews with 22 leaders running agentic systems surfaced the same pattern repeatedly: a gateway for governance and cost control, and guardrails enforced below the model rather than through prompts.

That last point deserves emphasis. A guardrail written into a system prompt asks the model to police itself, using the same channel an attacker uses to hijack it. A guardrail enforced in a gateway does not depend on the model's cooperation. If the policy says this agent can read the positions table but cannot write to the case system without approval, the gateway enforces that regardless of what the model was talked into.

A gateway also solves a practical problem that several sessions mentioned: tool sprawl. An agent connected to ten servers sees every tool from all ten, which bloats its context and degrades tool selection. The regulated finance session reported reducing context consumed by tool definitions from over 20 percent to near zero by loading tools on demand. An Agentic AI Foundation workshop on Agent Router covered aggregating tools from many servers behind one router and authorizing access per tool. Fewer visible tools means less context spent and fewer chances for the model to pick the wrong one.

For lakehouse data, the gateway is where you attach data policy. The gateway knows the caller, the tool, and the arguments. It can block a query tool from running against a table the caller's role does not cover, cap the rows returned, and log the request with the identity attached. The underlying catalog still enforces its own permissions. The gateway adds a second check that understands agent context.

## Lesson Three: Identity Has to Survive the Whole Chain

MCP's authorization model is specified for a pair: one client, one server, one token. Real deployments are chains. Several sessions focused on what happens to identity as a request crosses hops.

Pubudu Gunatilaka's session on delegation chains followed one user request through a host, a gateway, and several MCP servers, and examined each hop as a place where identity context is propagated, narrowed, dropped, or silently replaced. The abstract names the mechanics: token exchange, audience restriction, and credential brokering across identity providers. Its conclusion matches the gateway pattern: those controls do not scale when every server implements them, so the gateway becomes the natural place to exchange and downscope tokens and to record audit trails that separate user intent from agent action. The session also offered a framework for choosing delegation versus impersonation at each hop.

That distinction matters a lot in regulated settings. Impersonation means the downstream system sees the user, as if the user called it directly. Delegation means the downstream system sees both the user and the agent acting on the user's behalf. Delegation produces better audit records, because the log shows that an agent took the action, and it lets policy treat agent actions differently from direct human actions.

Token exchange, defined in RFC 8693, is the standard mechanism for that delegation. A gateway receives the user's token, exchanges it with the identity provider for a new token scoped to one downstream audience, carrying both the user and the agent as claims, and forwards only the new token. Jerric Lyns John's session showed a single generated MCP server using RFC 8693 token exchange, per-operation scopes taken from an OpenAPI specification, and Cedar policies, with no upstream secrets held on the server.

Audience binding came up repeatedly. A token issued for one server must not be accepted by another. Without audience restriction, a compromised or malicious server that receives a token replays it against other servers the user can reach. Shakthi Bachala's session on compositional zero trust listed audience-bound tokens as one of its global invariants.

Client registration is the other identity problem enterprises hit. The TELUS keynote described running into what it called the OAuth wall when hosting remote MCP servers, and explained why the team chose Client ID Metadata Documents over Dynamic Client Registration, along with the tradeoffs. Aasawari Sahasrabuddhe's session presented Cross App Access, an OAuth-based standard that carries a signed, delegated credential with both agent and user identity across application boundaries.

The takeaway for a data platform is direct. An agent that queries lakehouse data should reach the query engine with a token that identifies the human, identifies the agent, is scoped to that engine as its audience, and expires quickly. The engine, and the catalog behind it, then apply the human's permissions. The DataLakehouseHub article "[Securing Agent Identities in the Lakehouse](https://datalakehousehub.com/blog/securing-agent-identities-lakehouse-token-exchange/)" covers the token exchange and credential vending mechanics for that last hop in detail. The point here is that the chain only holds if every hop preserves identity rather than swapping it for a shared credential.

## Lesson Four: The Stateless Spec Moved Trust to Every Request

The MCP specification revision dated July 28, 2026, changed the transport in a way that rippled through the security sessions.

Akash Sathish's talk on what breaks after the change summarized it for server maintainers: server-side sessions are gone, SSE (server-sent events) streaming is replaced by Streamable HTTP, and servers no longer hold conversation context between requests. The abstract flags OAuth token binding without session affinity as harder than the changelog suggests. A panel session by Zachary Gruenberg, Joe Garcia, and Lorie Papple put the security consequence plainly: the initialize handshake and the `Mcp-Session-Id` header are gone, any server instance handles any request, and that removed the architectural crutch many identity and audit assumptions leaned on.

Statelessness is good for operations. Servers scale horizontally behind ordinary load balancers and scale to zero when idle. Daniel Oh's session covered exactly that benefit for cloud-native Java servers.

For trust, it changes the unit of verification. In a session-based design, a server authenticates a client once and trusts the session afterward. In a stateless design, every request has to prove itself. There is no session to hang a trust decision on, and no session ID to correlate in logs. The panel abstract describes state moving into explicit handles, and raises the question of who can create, hold, and drive a long-running task when no persistent connection anchors it.

Three practical consequences follow for regulated teams.

Authentication and authorization run on every request. That is cheap with short-lived signed tokens validated against cached keys, and expensive if every request triggers a round trip to an identity provider. Design for the cheap version.

Audit correlation needs an explicit identifier. Without a session ID, logs need a request or trace ID that the gateway assigns and propagates, so a multi-call agent run can be reconstructed afterward.

Long-running work needs ownership. If a task handle is a bearer credential, anyone holding it controls the task. Bind handles to the identity that created them and check that binding on every call.

## Lesson Five: Composition Is the New Attack Surface

Several sessions made the same uncomfortable point: individually permitted calls can add up to a forbidden outcome.

Shakthi Bachala's abstract states it directly. MCP is designed for composition, and composition creates a gap where permitted calls together violate user intent, amplify authority, or move sensitive data to an untrusted server. The session proposed checking the end-to-end plan, not just each call, against a set of invariants. Those invariants make a useful checklist on their own:

- Authority never grows across hops.
- Capability is not permission.
- Tokens are audience-bound.
- Restricted data cannot reach an unapproved sink.
- Every side effect has a prior authorization decision.
- Retries and partial failures remain safe.
- Every run is replayable.

The data exfiltration case is the one regulated data teams worry about most. An agent reads a restricted table through one server, then calls a second server that posts to an external system. Each call is allowed. The combination leaks data. Catching that requires tracking data provenance through the run: knowing that the content passed to the second call came from a restricted source.

Policy engines that can be analyzed statically help here. Lucas Käldström and Chris Burns presented Cedar, a CNCF project with a declarative policy language, and described how ToolHive uses it to enforce consistent access control across MCP servers. Because Cedar policies are grounded in formal logic, they can be queried and compared, not just evaluated. You can ask whether any policy lets a given agent move private data to an external sink, and get a definitive answer across the whole policy set.

For lakehouse access, the concrete version of this lesson is data classification on sinks as well as sources. Tag tables and views by sensitivity in the catalog. Tag MCP tools by whether they write outside the organization's boundary. Enforce in the gateway that content derived from a restricted source cannot flow into an external sink within the same run, regardless of each call's individual permission.

## Lesson Six: A Valid Token Is Not a Human Approval

OAuth answers whether a caller is authenticated and authorized. It does not answer whether a human approved this specific consequential action.

Teng Wu's session made that distinction its thesis. It described an architecture where an MCP server pauses a high-risk action, such as a payment, a refund, a campaign send, or a bulk data change, until it receives an approval result tied to that exact action, confirmed with a passkey, while warning against treating a passkey alone as proof that a human was present.

Regulated workflows already have this concept. It is called maker-checker, four-eyes, or dual control. A trader enters a trade and a second person approves it. The MCP version of the same idea is a gateway or server policy that marks certain tools as consequential and requires an approval bound to the action's parameters before execution.

Two design details matter. The approval must bind to the specific action, including its arguments, so an approval for a $500 refund cannot be replayed for a $50,000 one. The approval must be recorded with the action, so the audit trail shows who approved what, when, through which mechanism.

For data platforms, the consequential actions are writes: an agent that updates a table, triggers a pipeline, changes a governed metric definition, or exports a dataset. Reads that return aggregated, non-sensitive results rarely need human approval. Writes and bulk exports usually do.

## Lesson Seven: The Supply Chain Includes Tool Descriptions

An MCP server runs code you did not write, with credentials it needs to act for you. Several sessions treated that as the threat model it is.

Daniel Davidson's session framed an installed MCP server as an insider threat and walked through four ways a trusted tool turns hostile: stealing credentials, doing more than authorized, pivoting from one tool to every tool, and arriving through a poisoned dependency. The abstract argues that common fixes such as environment variables, secrets managers, and handing the tool a token all leave the same exposure.

Kapil Duraphe's session on auditing tool descriptions at catalog scale pointed at a less obvious surface. The MCP specification treats a tool's description as free text, and the model reads all of it. That makes the description field the target of tool poisoning, where an attacker hides instructions in the text for an agent to follow. The session described running classifiers across an entire tool catalog in batches to flag likely poisoning, and the new attack surface batching itself creates.

The regulated finance session added the compliance side. It described producing SPDX software bills of materials (SBOMs) for MCP servers to track components and licenses for financial audit requirements.

Taken together, the supply chain controls for a regulated MCP estate look like this:

- Every server in the registry has an SBOM and a verified publisher.
- Every server version is pinned, and updates go through review.
- Tool descriptions are part of the reviewed artifact. A description change is a code change.
- Servers receive scoped, short-lived credentials from a broker at call time, not long-lived secrets at install time.
- Revocation removes a server from the registry and the gateway in one action.

## Lesson Eight: Audit Has to Prove Who Did What

Every lesson above eventually lands in the audit trail. If the logs cannot reconstruct a run, the controls are hard to prove.

Lorie Papple's part of the stateless panel focused on what proving who did what means once session-level tracing is gone. Chris Urwin's workshop on governing agent actions covered capturing complete logs of agent and tool activity, exporting them to enterprise storage, and generating reports, along with discovering shadow AI such as unmanaged agents and MCP servers already running in an organization. Jeffrey Ellin's session described tying every tool call back to a real user through short-lived identity tokens, with a clear chain across session logs, policy decisions, and the resulting cloud activity. Houssam Kherraz's talk on MCP across Kensho, the AI arm of S&P Global, listed granular observability as something that deserved higher priority than it got.

A defensible audit record for one agent run has a small set of fields:

- The human identity and the agent identity, as separate fields.
- A run or trace ID assigned at the gateway and carried on every call.
- For each tool call: the server, tool, arguments, policy decision, and the policy version that made it.
- For data access: the tables or views read, the snapshot or version read, and the row counts returned.
- For consequential actions: the approval record bound to that action.
- The outputs returned to the user.

The data access line is where the lakehouse helps. Apache Iceberg tables are versioned by snapshot. If the audit record stores the snapshot ID each query read, the exact data the agent saw is reproducible later, as long as the snapshot has not expired. That turns "what did the agent see?" from an argument into a query.

Store these records in an append-only table in the lakehouse itself. An Iceberg table partitioned by date, with retention policies matching your regulatory requirements, makes the agent audit trail queryable with the same tools the compliance team already uses for other data.

## Lesson Nine: Tool Design Is a Control

Security sessions got the headlines, but several building-with-MCP talks made a point regulated teams should take just as seriously: the shape of a tool decides how much damage an agent can do with it.

Edmund Lam's session on designing tools agents can actually use described building an MCP server for a connected-worker manufacturing platform. The first attempt ported the REST API one-to-one and failed. The fixes listed in the abstract read like a control catalog: progressive discovery so agents find the right tool among dozens, pruning tool parameters to the few an agent should reason about, stripping response bloat, guardrails on destructive and unbounded operations so an agent cannot delete everything or pull a million rows, and errors an agent can recover from.

Houssam Kherraz's talk on MCP across Kensho made a similar point from the critical side. Its list of cautionary tales includes teams wrapping REST APIs with no thought to context engineering and servers that are nothing more than parameterized table queries. Kashish Verma and Sreeram Venkitesh argued for wrapping intent rather than endpoints, so the agent does less planning and makes fewer calls.

For regulated data access, this lesson has a sharp edge. A tool that accepts arbitrary SQL against a warehouse is the widest possible tool. It hands the model every table the credential can reach, every join, and every export path the engine supports. A tool that answers "exposure by counterparty for a date" against a governed view is narrow. Its blast radius is the view.

Narrow tools are easier to authorize, because the policy can reason about a small parameter set. They are easier to audit, because the log records intent rather than a generated query. They are easier to test, because the space of valid calls is small.

The practical pattern for data teams is two tiers. Expose intent-level tools backed by a semantic layer to most agents. Reserve general query tools for a small set of analyst-facing agents with stricter policy, row caps, and mandatory approval for anything that writes or exports. Put hard limits on every data tool: maximum rows returned, maximum bytes scanned, and timeouts. An agent that loops on a bad query hits the limit instead of the budget.

## Lesson Ten: Evaluation Belongs in the Release Gate

Regulated organizations already run change control on software and model risk processes on statistical models. MCP servers sit between those two worlds, and the evaluation sessions in Toronto suggested how to fold them into both.

Nader Ziada's session on eval-driven development described a server with passing unit and integration tests that an agent still used badly, picking the wrong tool, garbling parameters, and spending tens of thousands of tokens on a task that should cost a few thousand. The fix in the abstract is to write the evaluation before the tool: the user request, the expected call, the expected result, and a token budget. The abstract also argues that tokens per task should fail a merge the same way a broken test does, and that a real evaluation suite turns a model swap from a guess into a measured change. A companion workshop by Calum Murray and Nader Ziada taught writing these evaluations with mcpchecker, an open source framework the abstract describes as used in production by servers such as the Kubernetes MCP Server.

For a regulated team, this maps cleanly onto existing process. An evaluation suite is the test evidence a change advisory board asks for. Results per model version are the validation record a model risk function asks for. Token-per-task budgets are cost controls a finance partner asks for.

Three practices make it stick. Version the evaluation suite alongside the server, so every release carries its own evidence. Run the suite against every model the server is approved for, since the same server behaves differently with different models. Store results in the lakehouse with the server version and model version, so trend lines show drift before users notice it.

## What the Enterprise Case Studies Had in Common

The case study sessions came from very different organizations, but they converged on a few shared decisions.

The TELUS keynote described an end-to-end enterprise practice: an operations agent exposed as an MCP server behind a chat front end, workflow automation that calls MCP tools, a shared registry, and remote MCP hosting on an internal platform built on Cloudflare Workers. Jeremy Drouillard and Andrew Hannigan from TRM Labs described moving away from local MCP servers, which the abstract calls fragile and hard to maintain and which often required secrets on developer laptops, toward centrally hosted servers with a consistent layer that supports new agents without rebuilding integrations. Kumar Chinnakali's session described bringing MCP into the corporate actions lifecycle at a major custodian, where workflows touch dozens of systems and deadlines that do not forgive mistakes.

Three common threads stand out.

**Central hosting beats local servers.** Every enterprise story moved servers off laptops and into hosted, managed infrastructure. Local servers spread credentials, resist patching, and escape the registry. Hosted servers sit behind the gateway by default.

**Agent-agnostic integration.** TRM Labs framed its approach as agent-agnostic, and TELUS built reusable patterns rather than integrations tied to one assistant. In regulated environments this matters for vendor risk. If the integration layer is MCP behind a gateway you control, switching or adding an agent client does not reopen every security review.

**The hard part is the boundary with legacy systems.** The custodian session focused on integration patterns that worked across legacy platforms and the design decisions that mattered in a regulated environment. MCP did not remove the complexity of decades-old systems. It gave that complexity a consistent interface, which made governance tractable.

For lakehouse teams, the parallel is the semantic layer. Agents do not need direct access to every source system. They need a governed interface over data that has already been modeled, secured, and documented. An open lakehouse with a semantic layer on top plays the same role for analytical data that a hosted MCP integration layer plays for operational systems.

## A Reference Architecture for Agent Access to Regulated Data

Here is how the lessons fit together for one common case: agents answering questions over governed lakehouse data at a regulated organization.

**Registry.** Every MCP server that touches data is registered with an owner, a data classification, the audience it accepts tokens for, and a pinned version with an SBOM. The registry feeds the gateway's allow list.

**Gateway.** All agent traffic passes through one gateway. It validates the caller's token, performs token exchange to produce a short-lived, audience-bound token for the target server carrying both user and agent identity, enforces per-tool policy, tracks data provenance within a run, requires approvals for consequential tools, assigns the run ID, and writes the audit record.

**Data tools.** The MCP servers that agents call for data do not hold standing credentials to storage. A semantic layer server exposes governed metrics and views rather than raw tables, which keeps agents on vetted definitions. A query server forwards the delegated token to the query engine.

**Engine and catalog.** The query engine authenticates the delegated token and authorizes against the catalog's permissions for the human. An Iceberg REST catalog that supports credential vending issues short-lived, table-scoped storage credentials to the engine per query, so no component downstream of the gateway holds long-lived storage keys.

**Audit store.** Gateway records, engine query logs, and catalog access logs all land in append-only Iceberg tables, keyed by run ID. Snapshot IDs recorded per query make agent reads reproducible.

**Approval service.** Consequential tools call out to an approval service that binds a human confirmation to the exact action and returns a signed result the server verifies before executing.

Nothing in that design is exotic. Each piece maps to a control regulated organizations already run for human users and batch jobs. The work is extending those controls to the agent layer and making sure identity is never swapped for a shared credential along the way.

## Mapping the Lessons to Controls You Already Run

Security and compliance teams approve faster when a new system maps onto controls they already understand. Every lesson above has a counterpart in a standard control framework, and naming that counterpart in your design documents saves weeks of review.

**Registry maps to asset inventory and change management.** An MCP server is an application asset. The registry is its inventory record, and the review step before publication is its change ticket.

**Gateway maps to network segmentation and policy enforcement points.** The gateway is a chokepoint, like an API gateway or a proxy, with logging and policy at the boundary.

**Delegated tokens map to identity and access management.** Token exchange and audience binding are least privilege and separation of duties, applied to a new kind of caller. The agent identity becomes a workload identity with its own lifecycle, owner, and access review.

**Source and sink classification maps to data loss prevention.** Blocking restricted data from reaching external tools within a run is a DLP rule expressed in agent terms.

**Bound approvals map to dual control.** The approval record is the second signature.

**SBOMs, pinning, and description review map to third-party and software supply chain risk.** A community MCP server is third-party software, and it gets the same intake as any other dependency.

**Run IDs and append-only audit tables map to logging and monitoring requirements.** They also give the incident response team a single key to pull every event for a suspect run.

**Evaluation suites map to testing evidence and model validation.** They are the artifacts reviewers already ask for, produced in a form that runs automatically.

Writing this mapping into the architecture document is a small effort. It changes the review conversation from "what is MCP and why should we trust it?" to "here is how existing controls extend to the agent layer."

## Failure Modes

**The shared service account.** An MCP server connects to the query engine with one powerful credential and serves every user through it. Every user then has that credential's access through the agent. This is the most common failure and the most damaging one. Fix it with delegated tokens before anything else.

**Guardrails in the prompt.** Instructions such as "never export customer data" live in a system prompt. A prompt injection in a retrieved document overrides them. Move enforcement to the gateway.

**Unreviewed server updates.** A community server auto-updates, and its new version changes a tool description or adds a dependency. Nobody reviewed it. Pin versions and route updates through the registry.

**Logs that cannot be joined.** The gateway logs requests, the engine logs queries, and the catalog logs access, each with its own identifiers. Reconstructing a run takes days. Propagate one run ID end to end.

**Approvals without binding.** A human clicks approve on a generic prompt, and the approval token works for any parameters. Bind approvals to the action and its arguments.

**Audit records that outlive their data.** The audit log records a snapshot ID, but snapshot expiration removed that snapshot. The data the agent saw is gone. Align snapshot retention on sensitive tables with your audit retention window, or tag snapshots referenced by agent runs.

**Shadow servers.** Developers run MCP servers locally against production data with personal credentials. The registry never sees them. Discover them through network and endpoint monitoring, then bring them under management or block them.

## A Checklist to Start With

1. Inventory every MCP server touching regulated data and assign an owner.
2. Stand up a registry and make it the allow list for agent access.
3. Route all agent traffic through one gateway.
4. Replace shared service credentials with delegated, audience-bound, short-lived tokens.
5. Expose governed views and metrics to agents instead of raw tables.
6. Classify sources and sinks, and block restricted-to-external flows within a run.
7. Require bound human approval for consequential tools.
8. Pin server versions and review description changes as code changes.
9. Assign a run ID at the gateway and carry it everywhere.
10. Write audit records to append-only Iceberg tables and align snapshot retention.

## Questions the Program Left Open

A conference agenda shows what practitioners have solved, and it also shows what they are still arguing about. A few open questions stood out.

**Where MCP stops.** Two sessions focused on the boundary between MCP and the Agent2Agent (A2A) protocol, one as a workshop and one as a talk on choosing the right protocol for the task. The Linux Foundation Research study found that leaders agreed more on what MCP does not cover, such as agent-to-agent communication, identity, and discovery, than on its long-term future. Regulated teams should design so that controls live in the gateway and the identity layer, not inside one protocol, so they survive whatever the protocol mix looks like in two years.

**How servers get discovered.** Markus van Kempen's talk on building a portfolio of open source servers named discoverability as the problem that kept coming back, with no great answer yet. Inside an enterprise the registry answers it. Across organizations it is still open.

**When to use MCP at all.** Shalev Shalit's session proposed a decision framework across MCP, direct APIs, CLIs, and browser automation, preferring the most structured, narrowest interface that completes the task. A N M Bazlur Rahman's session on the wrong reasons to build an MCP server made a complementary case: sometimes a direct API call is enough. For regulated teams, the narrowest interface is usually also the easiest one to govern.

## Where This Is Heading

Three threads from the program look likely to dominate the next year.

The first is standardized registries. Several sessions asked what a trustworthy registry requires, and how servers get discovered at all. Expect convergence on registry formats that carry provenance, version pins, and revocation, so a registry is portable across gateways.

The second is identity across chains. Token exchange, audience binding, client metadata documents, and cross-app access standards all address pieces of the delegation problem. The gap is end-to-end, multi-hop delegation with clear rules for when to delegate and when to impersonate.

The third is policy that can be analyzed. Cedar's appearance on the program reflects a broader shift toward access policies that machines can reason about statically. For regulated teams, the ability to prove a property of the whole policy set, such as "no agent can move restricted data to an external sink," is worth more than any single runtime check.

## Conclusion

The Toronto program read like a list of controls regulated organizations already know, applied to a new layer. Registries are change management. Gateways are network and policy chokepoints. Delegated tokens are least privilege. Bound approvals are maker-checker. Audit records are, well, audit records.

What is different is the agent in the middle, composing calls nobody explicitly requested, at machine speed, through servers written by third parties. The teams presenting in Toronto were not inventing new security theory. They were doing the unglamorous work of making sure every one of those calls carries a real identity, passes through a policy check that does not depend on the model's cooperation, and leaves a record an auditor can read.

For data teams, the lakehouse already supplies several of the hard parts: versioned tables that make reads reproducible, catalogs that vend scoped credentials, and an open place to store audit history. The job now is to wire agents into those controls instead of around them.

## Keep Going

If this piece was useful, I have written a lot more on governing data access for both humans and agents. *Apache Polaris: The Definitive Guide* (O'Reilly) covers catalog-level access control and credential vending, which is the last hop in the identity chain described above. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
