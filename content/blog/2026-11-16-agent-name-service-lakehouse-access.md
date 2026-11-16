---
title: "Agent Name Service for Lakehouse Access: DNS-Anchored Agent Identity vs OAuth Client Registration"
description: "The Agent Name Service puts AI agent identity in DNS and certificates. It answers which agent is calling, not what it may read. Here is how the layers split."
date: 2026-11-16T09:00:00Z
tags: ["AI Agents", "MCP", "Security", "Identity", "Apache Iceberg"]
canonical: https://datalakehousehub.com/blog/agent-name-service-lakehouse-access/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/agent-name-service-lakehouse-access/).

The Agent Name Service, which joined the Linux Foundation on November 10, 2026, publishes AI agent identities in DNS and verifies them with the certificates websites already use. It answers which agent is calling. It does not replace OAuth token exchange or catalog grants, which still decide what that agent is allowed to read.

The Linux Foundation announced the Agent Name Service (ANS) at KubeCon and CloudNativeCon North America in Salt Lake City ([press release](https://www.linuxfoundation.org/press/linux-foundation-welcomes-agent-name-service-to-bring-verifiable-identity-and-discovery-to-ai-agents)). The foundation first signaled its intent to launch the project in June. The November announcement brought a technical steering committee, a specification of seven documents, and a list of eleven organizations that contributed to or adopted it, including Cisco, Cloudflare, DigiCert, GoDaddy, Infoblox, Salesforce, and OWASP.

For data platforms, the interesting question is narrow. When an agent calls your MCP server, your catalog, or your query engine, how do you know which agent it is? This article explains what ANS standardizes, where it sits next to the OAuth flows that data platforms already use, and which parts of the access problem it leaves untouched. For how agents should authenticate to an Iceberg catalog with OAuth today, read [Securing Agent Identities in the Lakehouse](https://datalakehousehub.com/blog/securing-agent-identities-lakehouse-token-exchange/) first. This piece builds on it.

## Three questions every agent request raises

Every request an agent makes to a data platform carries three separate questions. Most security designs blur them together, and most failures come from that blurring.

1. **Who is this agent?** Which software is making the call, who published it, and is it the version you think it is?
2. **Who does it act for?** Which human or service gave it the task, and under whose authority is it reading data?
3. **What can it touch?** Given the answers to the first two, which catalogs, tables, columns, and rows is it allowed to read or change?

Today's data platforms answer the second and third questions reasonably well. OAuth 2.0 token exchange lets an agent present a token that represents a user's delegated authority. Catalogs such as Apache Polaris map that token to principal roles and evaluate grants. Row filters and column masks narrow what comes back.

The first question gets a much weaker answer. Usually, the agent is identified by an OAuth client ID that an administrator registered once. That ID says "this is the client called finance-assistant." It does not say which organization built that client, which version is running, or whether the software calling with that client secret is the same software that was registered. ANS is aimed at that gap.

## What ANS standardizes

According to the Linux Foundation announcement, ANS is an open standard that uses DNS to publish and verify AI agent identities. The specification has seven documents. They cover domain-anchored naming, registration and versioning, DNS publication, public log auditing, integrity monitoring, and agent-to-agent authentication.

Translated into plain terms, those documents describe a lifecycle.

**Naming.** An agent gets a name anchored to a domain its publisher controls. That ties the agent's identity to an organization the same way a website's identity is tied to its domain. Early design material, analyzed by the Cloud Security Alliance (CSA) in June, showed names that combine a protocol, an agent ID, a capability, a provider, and a version, such as `a2a://textProcessor.DocumentTranslation.AcmeCorp.v2.1.hipaa`. The protocol prefix can be A2A, MCP, or ACP. Treat that format as illustrative of the design direction. The published documents are the source of truth.

**Registration and versioning.** Agents register under that name, and versions follow semantic versioning, so a client can ask for a compatible range rather than one exact build.

**Publication in DNS.** Identity information is published through DNS, the system that already maps names to addresses for the whole internet. DigiCert's statement in the announcement describes ANS as "bringing together DNS and certificate-based identity."

**Certificates.** Agents are verified with the same kind of X.509 certificates that websites use. The CSA analysis describes each agent receiving a key pair and a certificate issued through a registration authority, binding the agent's key to its verified identity and organization.

**Public logs and integrity monitoring.** Identity records are logged publicly and monitored for unauthorized changes. That mirrors Certificate Transparency on the web, where every issued certificate is logged so that domain owners can detect certificates they did not request.

**Agent-to-agent authentication.** Agents can verify each other's identities directly, which matters when one agent delegates work to another.

The announcement also names early adoption. AGNTCY's Agent Directory Service supports ANS, and ANS Finder implements a related discovery approach. Ken Huang of DistributedApps.ai led the initial development.

## How the design changed between June and November

It helps to know the project's short history, because commentary from the summer describes an earlier design.

The CSA published a security analysis of ANS on June 25, two days after the foundation announced its intent to launch. At that point, the CSA described ANS as "DNS-inspired." It borrowed DNS's hierarchical naming and delegation but resolved names through a dedicated agent registry rather than live DNS records. The concrete DNS record format and DNSSEC profile were not yet specified, and the reference implementation used mock cryptography.

The November announcement describes DNS publication, public log auditing, and integrity monitoring as parts of the specification. That suggests the design moved closer to DNS itself and added transparency mechanisms that the June analysis did not describe. Read June commentary with that in mind, and check the current documents before building on any specific mechanism.

## Where ANS sits next to OAuth

Data platform teams already run OAuth. The obvious question is whether ANS replaces it. It does not. The two answer different questions, and they fit together.

| Question | Today's typical answer | What ANS adds |
| --- | --- | --- |
| Who is this agent? | An OAuth client ID registered by an administrator | A domain-anchored name, a certificate, and a public record of the agent's identity and version |
| Who published it? | Whatever the administrator wrote in the registration notes | The organization that controls the domain and holds the certificate |
| Is it the version I approved? | Usually unknown | A versioned name that clients can check |
| Who does it act for? | OAuth token exchange, with the user as subject and the agent as actor | Nothing. This stays with OAuth |
| What can it touch? | Catalog grants, row filters, column masks | Nothing. This stays with the catalog and query engine |

The table shows the division of labor. ANS strengthens the first three rows. The last two belong to the systems that already handle them.

Here is how they combine in one request. An agent built by a vendor connects to your MCP server. The connection uses mutual TLS, and the agent presents a certificate tied to its ANS identity. The MCP gateway verifies the certificate and the agent's name, and checks that the name and version are on its allowlist. The agent then presents an OAuth token obtained through token exchange, with a user as the subject and the agent's client as the actor. The gateway forwards the request to the catalog with that token. The catalog maps the token to principal roles and evaluates grants. The query engine applies row filters and column masks.

At each step, one system answers one question. ANS identifies the software. OAuth carries the delegation. The catalog decides access.

## One request, end to end

The division of labor is easier to see in a single request with real token contents. Here is a vendor's reporting agent reading a sales table for an analyst named Priya, with ANS in the picture.

1. **Priya asks the agent for last month's regional sales.** She signed in to the agent's interface with her company identity provider, so the agent holds a token for her.
2. **The agent exchanges that token.** It calls the company's authorization server with OAuth 2.0 token exchange (RFC 8693), presenting Priya's token as the subject token and its own client credentials. The server returns a short-lived access token for the MCP gateway's audience.
3. **The agent connects to the gateway over mutual TLS** and presents a client certificate tied to its ANS identity.
4. **The gateway verifies the agent.** It checks the certificate chain, confirms the certificate is not revoked, and resolves the agent's ANS name. It confirms the name and major version are on the allowlist. If any check fails, it rejects the connection.
5. **The gateway validates the access token.** It checks the signature, the audience, the expiry, and the claims.
6. **The gateway calls the catalog with the token.** The catalog maps the token's subject to Priya's principal roles and checks her grants on the sales table.
7. **The engine runs the query** with Priya's row filters and column masks applied.
8. **The gateway logs both identities:** the verified agent name and version, and Priya as the user.

The access token from step 2 carries the delegation. Its payload looks like this:

```json
{
  "iss": "https://idp.example.com",
  "aud": "https://mcp-gateway.example.com",
  "sub": "priya@example.com",
  "act": { "sub": "client:report-writer" },
  "scope": "lakehouse.read",
  "exp": 1794001200
}
```

The `sub` claim names Priya, the user whose authority the agent uses. The `act` claim, defined by the token exchange specification, names the party acting on her behalf, here the agent's OAuth client. The `aud` claim restricts the token to the gateway, and `exp` keeps its life short.

Notice what the token cannot prove. The `act` claim says which OAuth client obtained the token. It does not prove which software holds that client's secret. If the secret leaked, any program can obtain tokens that look exactly like this. Step 4 closes that gap. The certificate check proves the connecting software holds the private key bound to a published, versioned agent identity. The gateway can then require that the verified agent and the token's `act` claim refer to the same approved agent.

## Using a verified agent identity in policy

Once the agent's identity is verified, it becomes an input to authorization decisions. You do not grant data access to an agent's ANS name directly. You use the name to decide whether the agent is allowed to act on a user's behalf at all, and sometimes to narrow what it can do.

A policy engine such as Open Policy Agent (OPA) can express that. The input document below is hypothetical. It assumes a gateway that has already verified the agent's certificate and placed the result in the request context.

```rego
package lakehouse.agents

import rego.v1

# Agents allowed to act for users at all, by verified name prefix and major version.
approved_agents := {
	"mcp://reportWriter.Analytics.ExampleVendor.v3",
	"a2a://dataSteward.Governance.InternalPlatform.v1",
}

default allow := false

allow if {
	input.agent.verified
	some prefix in approved_agents
	startswith(input.agent.name, prefix)
	user_allowed
}

# The user's own permission still decides data access.
user_allowed if {
	some role in input.user.roles
	role in data.table_grants[input.resource.table]
}
```

The policy first requires that the gateway verified the agent's identity. It then checks that the agent's name starts with one of the approved prefixes, which pins the publisher, the agent, and the major version. Finally, it requires that the user the agent acts for holds a role with a grant on the requested table. An unapproved agent fails even when the user has access. An approved agent fails when the user lacks access. Both checks have to pass.

The names in `approved_agents` follow the illustrative format from the early design material. Replace them with whatever the published naming document specifies.

## The MCP gateway is where this lands first

For most data platforms, the first place ANS shows up will be the gateway in front of MCP servers. A gateway already terminates TLS, authenticates callers, and logs requests. Verifying an agent's certificate and checking its name against an allowlist is a natural addition.

Three gateway controls benefit directly.

**Agent allowlisting.** Today, a gateway can allow or deny an OAuth client ID. With ANS, it can allow a named agent from a specific publisher at a specific major version, and reject a renamed or updated build until someone reviews it.

**Audit trails.** Gateway logs that record the verified agent name and version alongside the user make incident response faster. "Which agent read this table on Tuesday?" gets a precise answer instead of a client ID that ten different tools share.

**Agent-to-agent calls.** When an orchestrating agent delegates to a specialist agent over A2A, the specialist's identity matters as much as the orchestrator's. ANS's agent-to-agent authentication document targets that case.

The controls that gateways enforce today, and how they differ across products, are compared in the [Agent Gateway Control Matrix](https://datalakehousehub.com/blog/agent-gateway-control-matrix/). Agent identity verification is a natural new row in that matrix as gateways adopt ANS.

## What ANS does not cover

The announcement is careful in what it claims, and data teams should be equally careful.

**No stated binding to MCP or A2A.** The press release does not describe how ANS integrates with MCP or A2A. MCP appears only in the foundation's list of projects, and an Infoblox quote mentions MCP servers as things domains can help name. A2A is not mentioned, though one of the seven documents covers agent-to-agent authentication. Until a binding is published, each gateway and client will integrate ANS its own way.

**No authorization model.** ANS identifies agents. It says nothing about what they can access. That stays with your catalog and engines.

**No delegation model.** ANS does not say which user an agent acts for. OAuth token exchange and similar flows still carry that.

**No answer for internal agents.** Agents your own teams build and run inside your network often never need public DNS identity. Workload identity systems, such as SPIFFE, already give internal services verifiable identities. ANS matters most for agents that cross organizational boundaries, such as vendor agents calling your platform or your agents calling a partner's.

## How ANS compares to other agent identity approaches

ANS is not the only way to give software a verifiable identity. Three other approaches already appear in data platform deployments, and they overlap with ANS in different ways.

**OAuth client registration and attestation.** This is the baseline. An agent is an OAuth client with a client ID and a secret or a signed assertion. It works everywhere OAuth works. Its weakness is that the client ID is a local name an administrator assigns, with no public record of who built the software. Client attestation extensions strengthen the "is this the registered software" question but stay inside one organization's authorization server.

**Workload identity with SPIFFE.** SPIFFE gives every workload in an environment a cryptographic identity, issued automatically based on where and how the workload runs. It is strong for internal services and widely used in Kubernetes. Its identities are scoped to a trust domain you operate, so they do not by themselves tell a partner organization who your agent is.

**Decentralized identifiers.** W3C DIDs let an entity control an identifier without a central registry. The InfoWorld coverage notes that ANS supports DIDs and Legal Entity Identifiers alongside DNS. DIDs offer independence from DNS and certificate authorities, at the cost of less mature tooling in mainstream gateways.

ANS's distinct contribution is public, cross-organization identity anchored in infrastructure every organization already has: domains and web certificates. For agents that stay inside your walls, SPIFFE and OAuth already cover the need. For agents that cross organizational boundaries, ANS fills a gap the others leave open. The CSA recommended exactly this framing: treat ANS as one candidate alongside DIDs, SPIFFE, and OAuth, with guidance on hybrid architectures.

## Questions to ask vendors whose agents call your platform

If outside agents will read your lakehouse data, ask their publishers these questions now. The answers tell you how ready they are for verified identity, with or without ANS.

1. **How does your agent authenticate to our gateway?** Look for mutual TLS or signed client assertions, not a static shared secret.
2. **Does the agent use delegated user tokens, or a service account?** Delegated tokens keep access tied to the user. Service accounts widen it.
3. **How are agent versions identified and announced?** You need to know when the software calling you changes.
4. **What happens to tokens and certificates when you ship a fix for a security issue?** Look for a revocation process measured in hours, not weeks.
5. **Do you plan to publish an ANS identity for the agent?** A publisher that plans to do so is committing to a public, auditable identity record.

## The security debate

ANS rests on DNS and the certificate authority system. Both are mature and widely deployed. Both also carry known weaknesses, and analysts raised them when the project was announced.

The CSA's June analysis listed several. DNS cache poisoning can lead an agent to authenticate an impostor, with no human watching to notice. Registrar or registry compromise can re-point an agent's records legitimately. Route hijacking can redirect resolution regardless of cryptography. Revocation through certificate revocation lists and OCSP is slow, and DNS caching keeps revoked identities resolvable for a time. Squatting and look-alike names are open problems. DNSSEC, which signs DNS records, covers only a small share of zones.

In InfoWorld's June coverage, Forrester's Charlie Dai noted that DNS was not designed for high-assurance identity. Gartner's Jaishiv Prakash recommended pairing ANS with identity and access management, workload identity, AI gateways, and API security controls, and advised waiting for clearer interoperability guidance before treating any single initiative as strategic infrastructure. Analysts also flagged overlap with DNS-AID, another DNS-based effort for advertising agent capabilities, and with AGNTCY.

The CSA's most urgent recommendation is the one data platforms should adopt: a fail-closed trust profile. Treat unsigned zones, unreachable revocation checks, and invalid certificate chains as untrusted. A gateway that falls back to allowing an agent when verification fails gives an attacker a way in by breaking verification.

## A minimum identity stack for agent access to Iceberg tables

Here is the stack I recommend for agents that read governed lakehouse data, with ANS as an optional layer that strengthens the first question.

1. **Gateway in front of every MCP server.** No agent talks to a catalog or engine directly. The gateway terminates TLS, authenticates, logs, and enforces policy.
2. **Agent identity at the gateway.** For internal agents, use workload identity. For external agents, add ANS verification as gateways support it, with a fail-closed profile and an allowlist of names and major versions.
3. **Delegated user authority through OAuth token exchange.** The agent never uses a shared service account to read data. It carries a token that names the user as subject and the agent as actor, with a short lifetime and a narrow audience.
4. **Catalog authorization on the user's roles.** The catalog evaluates grants for the user. An agent can do at most what the user can do.
5. **Engine-level row filters and column masks.** These apply no matter which agent asks.
6. **Audit with both identities.** Every log line records the verified agent and the user it acted for.

Steps 3 to 6 work today on an open lakehouse with Apache Iceberg and a REST catalog such as Apache Polaris. Step 2 is where ANS fits, and it can be added without changing the others. Lessons from running this kind of stack under regulatory constraints are collected in [MCP in Regulated Environments](https://datalakehousehub.com/blog/mcp-regulated-environments-toronto-2026/).

## Failure modes to plan for

**Fail-open verification.** A gateway configured to allow agents when ANS lookup fails turns every DNS outage into an access bypass. Configure fail-closed from the start.

**Name confusion.** An agent named to look like an approved one, with a swapped character or a similar publisher name, passes a loose prefix match. Match exact publishers and agent IDs, and review allowlist changes like code.

**Stale revocation.** A compromised agent whose certificate is revoked remains trusted until caches expire. Keep TTLs short for agent records you depend on, and pair ANS with token lifetimes measured in minutes so a revoked agent loses data access quickly.

**Identity without delegation.** A verified agent with a shared service account still reads everything that account can read. ANS makes this mistake look safer than it is. Keep delegation in OAuth and access in the catalog.

**Version drift.** Allowing any version of an agent defeats the purpose of versioned names. Pin major versions, and review upgrades before allowing them.

## What to do this quarter

ANS integrations are months away for most gateways. The work that prepares for them is useful on its own, so start it now.

- **Inventory every agent that touches data.** List each agent, its publisher, how it authenticates, and which OAuth client it uses. Many teams find several agents sharing one client ID, which makes audit logs useless.
- **Give each agent its own OAuth client.** One client per agent, per environment. This is the precondition for tying a verified identity to a token's `act` claim later.
- **Move agents off service accounts.** Switch each agent to delegated user tokens through token exchange. This is the single largest reduction in risk, and it does not depend on ANS.
- **Log agent and user separately.** Update gateway and catalog logs to record both identities on every request.
- **Write the allowlist policy.** Decide who approves new agents and new major versions, and how fast a compromised agent can be removed. The same process applies whether the identifier is a client ID today or an ANS name later.
- **Pick a fail-closed default.** Decide now that a failed identity check blocks the request. Changing that default after an incident is harder.

## Where this is heading

ANS is early. The Linux Foundation now governs it, the specification exists, and a few directories have adopted it. What it lacks is the integration work that makes it usable for data platforms: bindings for MCP and A2A, gateway support, and client libraries.

Watch for three things. First, a published binding between ANS identities and MCP or A2A connections, which tells gateway vendors exactly what to verify. Second, gateway products adding ANS verification as a configurable control. Third, convergence or a clear division of labor between ANS, DNS-AID, and AGNTCY's directory, so organizations do not have to support three overlapping systems.

Until then, the practical step is to separate the three questions in your own architecture. Make sure your gateway records which agent is calling, even if today that is only a client ID. When ANS integrations arrive, they slot into that place.

## Conclusion

ANS gives AI agents a public, verifiable identity anchored in DNS and certificates. For data platforms, it strengthens the weakest part of agent access today: knowing which software is actually calling, who published it, and which version it is. It does not say who the agent acts for or what it can read. OAuth token exchange and catalog grants still answer those questions.

Treat ANS as a new input at the gateway, not a new access model. Verify agent identity with a fail-closed profile, allowlist exact names and major versions, keep delegation in OAuth, and keep authorization in the catalog. That stack works with or without ANS today, and ANS makes the first layer stronger when it arrives.

## Keep Going

If this piece was useful, I have written a lot more on governing AI agent access to lakehouse data. My books cover lakehouse architecture, catalog security with Apache Polaris, and how agents should reach governed data through open standards. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
