---
title: "Agent Gateway Control Matrix: What A2A and MCP Gateways Enforce Before an Agent Touches Lakehouse Data"
description: "SAP Agent Gateway, agentgateway 1.7.0 and Databricks MCP servers compared on six controls, with checks you can run against any endpoint."
date: 2026-11-09T09:00:00Z
tags: ["ai-agents", "mcp", "a2a", "security", "data-governance"]
canonical: https://datalakehousehub.com/blog/agent-gateway-control-matrix/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/agent-gateway-control-matrix/).

An agent gateway decides which agents get to connect, as whom, and what comes back. On October 27, 2026, three things happened. SAP made inbound Agent2Agent (A2A) calls generally available through its Agent Gateway. The open source agentgateway project shipped version 1.7.0, which inspects tool outputs by default. And Databricks let external agents such as Claude, ChatGPT and Cursor connect to its Model Context Protocol (MCP) servers without an admin-created OAuth app. This matrix compares the controls each one enforces.

Here is why that matters for data teams. A year ago, the question was whether an AI agent was able to reach the lakehouse at all. Today the question is what stands between the agent and the data. An agent that calls a SQL tool through MCP, or asks another agent to do it over A2A, is a new kind of client. It acts on behalf of a person, it chains calls together, and it reads results that a human never reviews. The gateway in front of the data is where you decide what that client is allowed to do.

Gateways differ more than their marketing suggests. Some focus on discovery and identity. Some focus on inspecting traffic. Some are the platform's own front door and enforce the platform's permissions. The matrix below breaks each one into six controls so you can see what each covers and what you still have to build.

A disclosure: I work at Dremio, now part of SAP, and SAP's Agent Gateway is one of the three subjects. I describe it from SAP's public documentation, the same way I describe the others.

## Two Protocols, One Problem

Two protocols carry most agent traffic toward data today.

**MCP**, the Model Context Protocol, connects an agent to tools. An MCP server exposes a list of tools with input schemas. The agent calls a tool, the server runs it and returns a result. A lakehouse MCP server typically exposes tools such as "run this SQL," "list tables" or "describe this dataset." The caller is an agent host, such as Claude Desktop or a coding assistant, acting for a signed-in user.

**A2A**, the Agent2Agent protocol, connects an agent to another agent. Instead of calling a tool with fixed inputs, the caller sends a task in natural language to a remote agent, which reasons and acts on its own side. A remote agent advertises itself through an AgentCard, a JSON document that describes its skills, its endpoint and its authentication requirements.

The difference matters for control. With MCP, the gateway sees each tool call and each result. It can check the SQL, the table and the rows. With A2A, the gateway sees a task request and a task response. What the remote agent did in between happens behind its own boundary. A2A gateways enforce who is allowed to ask. MCP gateways can also enforce what was asked and what came back.

## The Six Controls That Matter for Data Access

Every gateway in front of lakehouse data should answer six questions. I use these as the columns of the matrix.

**1. Discovery.** How does a caller learn what agents or tools exist? Discovery should not grant access. It should tell a caller what exists, so the rest of the controls can decide whether the caller gets to use it.

**2. Client registration.** How does the gateway know which client application is calling? Every agent host has a client identity separate from the user's identity. Registration is where an administrator approves or blocks a client.

**3. Token checks.** Does the gateway validate the token's issuer, audience and expiry, and does it reject tokens minted for a different resource? An MCP server that accepts any valid token from a shared identity provider is a confused deputy waiting to happen.

**4. User-scoped authorization.** Does the request run with the end user's permissions, or with a shared service identity? This decides whether row filters and column masks in the data platform protect anything.

**5. Tool-output inspection.** Does the gateway inspect what comes back from a tool before the agent sees it? Results are where sensitive data leaves, and where prompt injection arrives, because a tool result is untrusted text the model will read.

**6. Audit.** Can you reconstruct, after the fact, which user, through which client, called which tool or agent, with which inputs, and what came back?

## The Matrix, as of November 3, 2026

| Control | SAP Agent Gateway (inbound A2A) | agentgateway 1.7.0 | Databricks MCP servers |
|---|---|---|---|
| Discovery | Agentic Resource Discovery (ARD) catalog plus AgentCards. Discovery does not grant invocation rights | Tool federation aggregates many MCP servers behind one endpoint | MCPs page in Unity Gateway lists provided and registered servers |
| Client registration | External agent registered as an Agent Gateway consumer with trust configured at design time | Configured per route, supports MCP auth spec with OAuth providers | Default OAuth client IDs for Claude, Claude Code, ChatGPT, Codex and Cursor, no client secret. No dynamic client registration |
| Token checks | OAuth token exchange into the A2A call | JWT validation, API keys, MCP auth spec | OAuth with server-specific scopes |
| User-scoped authorization | User-scoped authorization and access control lists per SAP's GA scope | Enforced by policy you write, CEL-based MCP filtering | Runs as the signed-in user or service principal, Unity Catalog permissions apply |
| Tool-output inspection | Not described for inbound A2A (task-level protocol) | Prompt guards inspect tool outputs by default | Not described for these MCP connections |
| Audit | Runtime enforced at gateway, details per SAP docs | Agent session detection and per-user analytics | Unity Gateway audit logs and usage dashboard |
| Status and date | GA, Oct 27, 2026 | Released Oct 27, 2026 | GA, Oct 27, 2026 |

Read "not described" literally. It means the public release notes and docs I read do not describe the control for that path. It does not mean the vendor lacks it elsewhere. Before you rely on any cell, find the control in the product documentation for your version and test it.

The three products are not substitutes for each other. SAP's gateway is a front door for SAP's own agents. agentgateway is a general-purpose data plane you deploy in front of any MCP or A2A backend. Databricks' MCP servers are the platform's own tool surface, governed by its catalog. A real deployment often uses two of these patterns at once: a general gateway in front, and a platform-native endpoint behind it.

## SAP Agent Gateway: Discovery Separated from Permission

SAP announced general availability of inbound A2A interoperability on October 27 at TechEd. The design choice that stands out is a strict split between finding an agent and being allowed to call it.

Discovery uses the Agentic Resource Discovery (ARD) specification. An AI client asks what is available for a task and receives a catalog of matching agents. Each entry carries the agent's identifier, type, version and AgentCard URL. The AgentCard describes the agent's capabilities and how to reach it. A2A then carries the actual interaction. SAP's announcement states directly that discovery does not itself grant permission to invoke an agent, and that authorization and execution are enforced separately at runtime.

That separation is the right default. Many early agent integrations treated "the client can see the tool list" as "the client can call the tools." Splitting the two means a discovery catalog can be broad while invocation stays narrow.

The architecture also separates design time from runtime. Onboarding a third-party agent, registering it as a consumer and configuring trust happen ahead of time. Runtime enforces those decisions on each call. SAP's TechEd hands-on session shows the full flow: an external agent registered as an Agent Gateway consumer, discovery through ARD, an OAuth token exchange into an A2A invocation, and a Gemini Enterprise agent calling a Joule agent through a three-legged OAuth flow.

Two limits to note. This release is inbound only, meaning third-party agents call SAP agents. SAP describes outbound A2A and MCP interoperability as future work. And because A2A is a task-level protocol, the gateway governs who is allowed to hand a task to an SAP agent. What that agent reads inside SAP is governed by SAP's own authorization on the agent's side.

## agentgateway 1.7.0: Inspecting What Comes Back

agentgateway is an open source data plane written in Rust that routes HTTP, gRPC, MCP and A2A traffic and fronts large language model (LLM) providers. Version 1.7.0, released October 27, includes three security-relevant behavior changes. The release notes call them out together: standalone deployments now always encrypt MCP sessions, prompt guards inspect tool outputs by default, and dynamic backends can no longer reach loopback or link-local addresses.

### Tool outputs inspected by default

This is the change that matters most for data access. A prompt guard is a policy that inspects text passing through the gateway, using regular expressions or an external moderation service, and blocks or masks matches. Before 1.7, guards using the default scope inspected prompts and messages. In 1.7, the default request scope also includes tool outputs, so every guard using the default scope now inspects tool results too. All prompt guards except webhooks honor scope, including OpenAI Moderation, Google Model Armor and Azure Content Safety.

For a lakehouse MCP server, the tool output is the query result. That is where a column of email addresses or account numbers leaves the data platform, and where a malicious string stored in a table can reach the model as a hidden instruction. Inspecting tool outputs by default puts a check exactly where the risk sits.

The release notes say how to keep 1.6 behavior: set the scope of each request guard explicitly. Do that only if you have a reason. The new default is the safer one.

### Session encryption

MCP's Streamable HTTP transport uses a session ID that the server issues and the client sends back on later requests. If session IDs are predictable or reusable across backends, an attacker who learns one can ride an existing session. In 1.7, when no session key is configured, a standalone agentgateway generates one and stores it in its config file or database. Sessions issued by a different backend now return 404, and the client starts a new session.

One operational warning. If you had session encryption enabled before the upgrade, sessions established before the upgrade are rejected and clients must reconnect. Plan the upgrade for a quiet window.

### No loopback for dynamic backends

Dynamic backends let a request choose its upstream target at runtime. Blocking loopback and link-local addresses closes a server-side request forgery path, where a crafted request tricks the gateway into calling `127.0.0.1` or a cloud metadata endpoint at `169.254.169.254`. Those addresses are where cloud credentials live.

## Databricks: Zero-Setup OAuth for External Agents

On October 27, Databricks made default OAuth apps for external AI agents generally available. Claude, Claude Code, ChatGPT, Codex and Cursor can now connect to Databricks MCP servers, including the Genie One MCP server, using default OAuth client IDs. An account admin no longer has to create an OAuth app first.

The client IDs themselves are URLs that point to client metadata documents published by each agent vendor, for example a metadata document hosted at claude.ai for Claude. These apps do not require a client secret. Databricks MCP endpoints do not support dynamic client registration, so clients that are not on the default list still need a preconfigured client ID.

### Convenience versus who approved the client

This is a real convenience, and it shifts a decision. Before this change, an account admin created an OAuth app for each agent, which was a natural approval point. Someone in the organization chose to allow Cursor or ChatGPT to connect. With default client IDs, the approval point moves. The user signs in through OAuth and grants consent, and Unity Catalog permissions still decide what that user can reach.

That is a reasonable model. The data is protected by the user's own permissions, not by the client's identity. A user who can query a table in the Databricks UI can query it through Cursor. The question your security team should answer is whether the client application itself matters to your policy. Some organizations want to allow a specific set of agent hosts and block others, for example to keep data out of tools that send prompts to a model provider without a data agreement. If that is your policy, check which controls your platform offers to restrict which client IDs can connect, and test them, rather than assuming the absence of an admin-created app means the absence of a control.

### Where authorization happens

Databricks MCP connections run as the signed-in user, or as a service principal using OAuth machine-to-machine for unattended agents. Unity Catalog permissions apply to every tool call. Databricks also documents filtering data per end user with OAuth custom identity claims and made cross-engine attribute-based access control (ABAC) generally available in October. ABAC lets policies key off attributes such as a user's department or a table's sensitivity tag. For data access, that is the strongest user-scoped model in the matrix, because the platform that owns the data enforces the policy on the actual query.

## A2A Versus MCP: What Changes When the Caller Is Another Agent

The matrix shows a pattern. MCP gateways can inspect tool calls and tool outputs. A2A gateways mostly govern who is allowed to send a task. That gap is structural, and it changes your design.

With MCP, the user's agent decides which tool to call, and the gateway sees the call. If the agent asks for `SELECT * FROM customers`, the gateway sees that request. If the result contains 50,000 email addresses, the gateway sees that too.

With A2A, the calling agent sends a task such as "find the top suppliers for this sourcing event." The remote agent decides what to query, runs it inside its own boundary and returns a summary. The gateway between them sees the task and the summary. It does not see the queries the remote agent ran. Those are governed by the remote side's own authorization.

Three consequences follow.

**Trust moves to the remote agent's operator.** When you accept an A2A call into your agent, your agent's own data access controls are the real protection. When you send an A2A call out, you are trusting the other side's controls. Choose A2A partners the way you choose any data processor.

**Identity has to survive the hop.** If the calling agent's user identity does not reach the remote agent, the remote agent acts as a service identity, and per-user policy disappears. SAP's GA scope lists user-scoped authorization for exactly this reason. Ask every A2A provider how the end user's identity reaches the data layer on its side.

**Inspect the response anyway.** A task response is still text the calling model will read. It can carry injected instructions or data your policy forbids. A general gateway that inspects A2A responses, the way agentgateway inspects tool outputs, closes part of the gap.

## Verifying a Gateway's Controls Yourself

Product pages describe controls. Requests prove them. These checks run against any MCP endpoint or A2A agent and take a few minutes.

```bash
# --- MCP: does the server demand auth and advertise its authorization server? ---
# An unauthenticated MCP request should fail with 401 and point to
# protected resource metadata (OAuth 2.0 Protected Resource Metadata, RFC 9728).
curl -s -i -X POST "$MCP_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -20

# Fetch the protected resource metadata the 401 points to
curl -s "$MCP_ORIGIN/.well-known/oauth-protected-resource" | jq .

# --- MCP: does the server reject a token minted for a different resource? ---
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$MCP_URL" \
  -H "Authorization: Bearer $TOKEN_FOR_OTHER_AUDIENCE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# --- A2A: what does the agent's public card advertise? ---
# A2A agents publish an AgentCard at a well-known path. Check both
# common locations, since implementations differ by protocol version.
curl -s "$AGENT_ORIGIN/.well-known/agent-card.json" | jq '{name, version, securitySchemes, skills: [.skills[]?.id]}'
curl -s "$AGENT_ORIGIN/.well-known/agent.json" | jq '{name, version, securitySchemes}'
```

Here is what each check tells you.

The first request sends a `tools/list` call with no token. A server following the MCP authorization specification responds with HTTP 401 and a `WWW-Authenticate` header that points to its protected resource metadata. If it returns a tool list instead, the server is open, and every other control in the matrix is moot.

The second request reads that metadata. It names the authorization servers the resource trusts and the scopes it supports. Compare it against what you expect. An MCP server that trusts your company-wide identity provider without a resource-specific audience will accept tokens issued for other applications.

The third request is the confused-deputy test. Obtain a valid token for some other resource from the same identity provider and send it. A correct server returns 401 or 403. A server that returns 200 is validating the signature but not the audience.

The A2A checks read the AgentCard. Look at `securitySchemes`, which declares how callers authenticate, and at the skills list. Then confirm with the operator that discovery and invocation are separate, the way SAP's ARD design describes. A card that lists skills is fine. A card whose endpoint accepts calls without the declared scheme is not.

Finally, test tool-output inspection with a canary. Put a row containing a fake credit card number or a recognizable test string in a sandbox table, query it through the agent and confirm the gateway's guard masks or blocks it. If you run agentgateway 1.7, that guard now applies to tool output without extra scope settings.

## A Minimum Control Set for a Lakehouse MCP Endpoint

If you expose lakehouse data to agents over MCP, here is the floor I recommend. Each item maps to one of the six controls.

**Discovery:** expose only the tools the use case needs. A read-only analytics agent does not need a tool that writes tables. Fewer tools also means fewer chances for a model to pick the wrong one.

**Client registration:** decide whether your policy cares which agent host connects. If it does, maintain an allowlist of client IDs and verify the platform enforces it.

**Token checks:** require tokens with an audience specific to the MCP server. Reject everything else. Use short token lifetimes so a leaked token expires quickly.

**User-scoped authorization:** run every tool call as the end user, not as a shared service account. Let the data platform's own row filters, column masks and attribute-based policies do the real enforcement. If the MCP server must use a service identity, rebuild per-user policy in the server and test it.

**Tool-output inspection:** inspect results before the model sees them. Mask sensitive patterns. Cap the number of rows a tool returns, because a 50,000-row result is rarely what an agent needs and is always what an attacker wants.

**Audit:** log user, client ID, tool name, input arguments, row count and guard decisions for every call. Keep the SQL text. When something goes wrong, the first question will be "what exactly did the agent run," and the answer has to come from your logs, not the model's summary.

## Failure Modes to Watch For

Gateways fail in recognizable ways. These are the five I check first when reviewing an agent deployment against lakehouse data.

**The shared service account.** An MCP server connects to the warehouse with one service identity and serves every user through it. Every user then sees everything that account can see. The warning sign is an audit log where every query shows the same principal. The fix is user-scoped execution, or per-user policy rebuilt in the server and tested with at least two users who hold different permissions. Run the same query as both users and compare row counts. If they match on a table with row-level policy, the policy is not reaching the query.

**The audience-blind token check.** The server verifies the token's signature and expiry but not its audience. Any application in your identity provider that can obtain a token for its own purpose can now call your data tools. The confused-deputy test in the previous section catches this in one request.

**Discovery that leaks.** A discovery endpoint returns the full tool or agent catalog to anyone, including descriptions that name internal tables, schemas or business processes. Discovery should not grant invocation, but it still reveals structure. Scope discovery responses to what the caller is allowed to see, or keep descriptions free of internal detail.

**Unbounded results.** A tool that returns every row a query produces turns one bad prompt into a bulk export. Row caps, column allowlists and output inspection limit the damage. A result of a few hundred rows is enough for almost every analytical question an agent answers.

**Silent upgrade changes.** Gateway upgrades change defaults. agentgateway 1.7 changed both session handling and guard scope. That is good for security, and it still breaks sessions and changes what guards block. Read the breaking-changes section of every gateway release and test it in staging with real agent traffic before production.

The common thread is that each failure looks fine in a demo. A single user, a single client and a small table produce correct answers. The failures show up with many users, many clients and real data, which is exactly when an agent rollout becomes visible to auditors.

## Where Agent Gateways Are Heading

Three directions are visible from this week's releases.

Gateways are becoming bidirectional. SAP describes inbound A2A as the first milestone toward outbound A2A and MCP. agentgateway already handles both protocols and LLM traffic in one data plane. Expect a single gateway to carry agent traffic in both directions, with one policy model for both.

Output inspection is becoming a default rather than an option. agentgateway's change to inspect tool outputs by default reflects where the risk has moved. Input filtering catches a bad prompt. Output inspection catches leaked data and injected instructions, which matter more when agents read query results directly.

Identity propagation remains the hardest problem. MCP connections increasingly run as the end user, which is good. A2A chains, where one agent hands a task to another that calls a tool, still lose the user's identity at some hops. The MCP project has open work on token lifetime and identity across long-lived connections. Until that settles, design every chain so the data platform at the end enforces the user's permissions, and treat any hop that drops identity as a privileged service account that needs its own review.

## Conclusion

Three releases on one day showed three different ideas of what an agent gateway is. SAP's gateway separates discovery from permission and governs which external agents are allowed to hand tasks to SAP agents. agentgateway inspects the traffic itself and now checks tool outputs by default. Databricks removes setup friction for external agents and relies on its catalog's user-level permissions to protect the data.

None of them covers all six controls on its own. For a lakehouse, the reliable pattern is layered: a platform that enforces user-scoped permissions on the actual query, an endpoint that validates audience-specific tokens, and a gateway that inspects what comes back before the model reads it. Run the verification checks above against every endpoint you expose. A control you have tested is worth more than a row in any matrix, including this one.

## Keep Going

If this piece was useful, I have written a lot more on connecting AI agents to governed lakehouse data. *Apache Polaris: The Definitive Guide* (O'Reilly) covers catalog-level access control and credential vending, which is the layer that decides what an agent's query can actually read. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
