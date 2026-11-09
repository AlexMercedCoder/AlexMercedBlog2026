---
title: "The Iceberg Catalog Federation Map, November 2026: Which Platforms Read and Write Whose Catalog"
description: "Which platforms read and write whose Iceberg catalog in November 2026, with auth method, write support, release stage and a dated source per edge."
date: 2026-11-09T09:00:00Z
tags: ["Apache Iceberg", "catalogs", "federation", "snowflake", "databricks"]
canonical: https://datalakehousehub.com/blog/iceberg-catalog-federation-map-november-2026/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/iceberg-catalog-federation-map-november-2026/).

Catalog federation lets one platform query Iceberg tables registered in another vendor's catalog. Between October 26 and November 2, 2026, Google made federation with Databricks Unity Catalog, AWS Glue, Snowflake Horizon Catalog and Workday Data Lake generally available. Snowflake opened Horizon to external engines for externally managed tables, and AWS Glue began accepting OAuth bearer tokens on its Iceberg REST endpoint. This map lists each edge, its direction, its auth method and whether writes work.

That is the short answer. The long answer matters more, because "supports federation" on a product page tells you almost nothing. A data platform team needs to know four things about every connection between two catalogs. Which side asks and which side answers. Whether the asking side can only read or can also commit. How the asking side proves who it is. And whether the vendor calls it generally available or still labels it preview.

This article records those four facts for the federation edges that changed this week, plus the older edges they depend on. Every row carries a date and a source. Where I found no confirmation from a vendor's own documentation, the cell says so instead of guessing.

A disclosure before we start. I work at Dremio, which SAP acquired this year, and one of the announcements in this window is SAP's own Polaris-based catalog. I treat it like every other row: what was announced, what is documented, and what you still need to verify in your tenant.

## Federation, Replication and Sync Are Three Different Things

Vendors use "federation" loosely, so it helps to pin the word down before reading any matrix.

**Catalog federation** means platform A asks catalog B for table metadata at query time or on a short refresh cycle. Platform A then reads the data files directly from object storage. The metadata stays owned by catalog B. The data files never move. If catalog B commits a new snapshot, platform A sees it on its next refresh.

**Replication** means a copy of the metadata, and often the data, lands in a second catalog that owns it from then on. The two copies drift unless a pipeline keeps them aligned. Replication solves availability and locality problems. It creates a consistency problem in exchange.

**Sync** sits in between. A background job mirrors metadata from catalog B into catalog A on a schedule. Catalog A presents the tables as its own objects, but catalog B remains the writer of record. Many products described as federation work this way under the hood, including Google's, which refreshes remote metadata on an interval.

**Query federation** is a fourth thing that gets mixed in. Here platform A sends SQL to platform B's engine and receives result rows. No Iceberg metadata changes hands. Databricks makes this distinction explicit in its Snowflake connector documentation: Iceberg tables in Snowflake use catalog federation, while non-Iceberg Snowflake tables always fall back to query federation.

| Pattern | Who owns metadata | Who reads data files | Freshness | Typical failure |
|---|---|---|---|---|
| Catalog federation | Remote catalog | Local engine, from object storage | Next metadata refresh | Credential or identity mismatch |
| Metadata sync | Remote catalog (writer of record) | Local engine | Sync interval | Stale snapshot after a remote commit |
| Replication | Each copy owns itself | Local engine, often on copied files | Pipeline lag | Silent divergence |
| Query federation | Remote engine | Remote engine | Live | Remote compute cost and pushdown gaps |

The matrix below covers catalog federation and metadata sync, because those are the patterns that rely on the Apache Iceberg REST Catalog (IRC) protocol. The IRC is the open HTTP API, defined by the Iceberg project, that lets any engine list namespaces, load tables and commit changes against any compliant catalog.

## Why This Week Changed the Map

Three things happened inside one week, and they reinforce each other.

First, on November 2, 2026, Google moved its remote catalog providers to general availability (GA). The Lakehouse release notes list four providers: Databricks Unity Catalog on AWS, Azure or Google Cloud, AWS Glue Data Catalog on AWS, Snowflake Horizon Catalog on AWS, Azure or Google Cloud, and Workday Data Lake on AWS or Google Cloud. Each one had shipped as preview earlier in the year. AWS Glue arrived in preview on June 5, Snowflake Horizon on July 13 and Workday on September 21. The same release made cross-cloud caching GA, disabled by default.

Second, on October 29, Snowflake made access to externally managed Iceberg tables through Horizon Catalog GA. External engines such as Apache Spark, Trino, DuckDB and PyIceberg can now read and write those tables through the Horizon IRC endpoint, whether the tables sit in a catalog-linked database or a standard Snowflake database. Snowflake role-based access control (RBAC) applies in both cases. Snowflake shipped Horizon IRC telemetry GA the same day, which writes the HTTP requests from external engines to the account's event table.

Third, AWS Glue Data Catalog added OAuth 2.0 bearer token authentication for its Iceberg REST APIs. Before this change, the Glue IRC endpoint required AWS Signature Version 4 (SigV4) request signing, an AWS-specific scheme that many non-AWS engines and partner tools never implemented. Glue now accepts standard bearer tokens obtained through OAuth 2.0 Token Exchange (RFC 8693), where a caller trades an OpenID Connect (OIDC) identity token for a short-lived, Glue-scoped token. AWS Identity and Access Management (IAM) and Lake Formation permissions still govern access.

The pattern across all three is the same. Each vendor is replacing a proprietary connection method with the IRC plus a standard identity flow. That is why a map is now possible at all. Two years ago, every edge was a custom connector with its own auth story. Today most edges speak the same protocol and differ mainly in direction, write support and identity propagation.

SAP added a fourth signal on October 29 at TechEd Berlin, announcing that SAP Business Data Cloud (BDC) now supports native Apache Iceberg and a universal catalog powered by Apache Polaris. I cover where that fits in the matrix section, along with what is and is not documented yet.

## The Matrix: Who Federates Whom, as of November 3, 2026

Read each row as an edge. The **reader** is the platform or engine that asks. The **catalog** is the system that owns the metadata. Direction matters: an edge from Google to Unity does not imply an edge from Unity to Google.

| Reader | Catalog | Read | Write | Auth method | Status | Date | Source |
|---|---|---|---|---|---|---|---|
| Google Lakehouse (BigQuery, Managed Spark, Spark) | Databricks Unity Catalog | Yes | Not documented | OIDC federation or Secret Manager, plus user identity federation | GA | Nov 2, 2026 | Google Lakehouse release notes |
| Google Lakehouse | AWS Glue Data Catalog | Yes | Not documented | OIDC federation or Secret Manager | GA | Nov 2, 2026 | Google Lakehouse release notes |
| Google Lakehouse | Snowflake Horizon Catalog | Yes | Not documented | OIDC federation or Secret Manager | GA | Nov 2, 2026 | Google Lakehouse release notes |
| Google Lakehouse | Workday Data Lake | Yes | Not documented | OIDC federation or Secret Manager | GA | Nov 2, 2026 | Google Lakehouse release notes |
| Google Lakehouse | SAP BDC (Delta Sharing) | Yes | Publish back to BDC | SAP BDC connector | GA | Jul 20, 2026 | Google Lakehouse release notes |
| Any IRC engine | Snowflake Horizon, Snowflake-managed tables | Yes (GA Feb 6) | Yes (GA May 26) | Snowflake users and roles, WIF with OIDC | GA | May 26, 2026 | Snowflake release notes |
| Any IRC engine | Snowflake Horizon, externally managed tables | Yes | Yes | Snowflake RBAC | GA (policy-protected tables still preview) | Oct 29, 2026 | Snowflake release notes |
| Any IRC engine | AWS Glue Iceberg REST | Yes | Per IAM and Lake Formation | SigV4, or OAuth 2.0 bearer via token exchange | GA | Oct 26, 2026 | AWS What's New |
| Databricks Unity Catalog | Snowflake Horizon (Iceberg tables) | Yes | Not documented | Unity connection to Horizon | Documented, check workspace | n/a | Databricks docs |
| SAP BDC | Universal catalog powered by Apache Polaris | Announced | Announced | IRC, details pending | Announced | Oct 29, 2026 | SAP News |

A few cells deserve explanation.

**"Not documented" is not "no."** Google's GA note describes querying remote Iceberg tables from BigQuery, Managed Service for Apache Spark and Apache Spark. It does not describe committing writes into Unity, Glue or Horizon through the federated catalog. Treat writes through these edges as unsupported until the provider's setup page says otherwise. A federated read path is the safe assumption.

**The SAP BDC row has two shapes.** The July 20 GA integration uses Delta Sharing, not the IRC. Google creates Delta Sharing catalogs that sync shares, schemas and tables from BDC, and it can publish Iceberg tables or data products back to BDC so SAP users consume them as remote tables in SAP Datasphere. The October 29 announcement adds a separate, Polaris-based universal catalog inside BDC. SAP describes zero-copy sharing with Databricks, Snowflake, Google, AWS and Microsoft through SAP BDC Connect, and it says Delta Lake support continues. As of November 3, I found no public endpoint documentation for the Polaris-based catalog. Verify availability, region and entitlements in your own tenant before you design around it.

**Snowflake now has two GA write paths.** The May 26 release covered Snowflake-managed tables, where Snowflake owns the metadata and an external engine writes through Horizon. The October 29 release covers externally managed tables, where another catalog owns the table and Horizon presents it. One exception remains. Access to an externally managed table that carries a Snowflake data protection policy is still in preview, and Horizon access is not available on FedRAMP Moderate or High deployments.

**The Unity to Horizon edge exists but its status needs checking.** Databricks documents catalog federation to Snowflake Horizon for Snowflake-managed Iceberg tables, with Unity reading files directly from object storage. The documentation notes that users need the MODIFY permission on the federated table. I did not find a GA date in this window, so the matrix marks it "check workspace." Confirm the release stage in your workspace before depending on it.

## The Three Auth Paths

Every edge in the matrix authenticates in one of three ways. The choice decides who appears in the remote catalog's audit log, how long a leaked credential stays useful and how much setup each new edge costs.

### OIDC Token Exchange

The reader holds an identity from its own cloud, for example a Google service account. It presents an OIDC token to the remote catalog's token endpoint. The remote side trusts that issuer and returns a short-lived token scoped to the catalog. No long-lived secret crosses the boundary.

This is now the preferred path on most of the matrix. Google's Lakehouse docs recommend OIDC for the catalog's service account. Snowflake added Workload Identity Federation (WIF) with OIDC for external engines on May 26. Glue's October change uses RFC 8693 token exchange for the same purpose. The setup cost is a trust relationship between two identity systems. Once that relationship exists, adding a new engine is a configuration change, not a secret rotation.

### Vended Credentials

Vended credentials solve a different problem. They cover storage, not the catalog API. When an engine loads a table, the catalog returns temporary, downscoped credentials for the object storage prefix that holds that table's files. The engine reads Parquet files with those credentials and nothing broader.

Clients request this with the `X-Iceberg-Access-Delegation: vended-credentials` header. Google's Spark configuration for federated catalogs sets exactly that header. Google's VPC Service Controls guide confirms the behavior for Unity and Horizon tables stored on Google Cloud: during metadata sync and queries, BigQuery reads storage using the downscoped credentials vended by the remote catalog, not the endpoint's own identity.

Vended credentials pair with either of the other two methods. OIDC proves who the engine is to the catalog. Vending decides what the engine can touch in storage.

### Static Keys and Secrets

The oldest path stores a client ID and secret, or a personal access token, and presents it on every request. Google supports Secret Manager as an alternative to OIDC for remote catalogs. Snowflake's own catalog integrations accept a `TYPE = BEARER` option with a fixed token. Static secrets work everywhere and fail in predictable ways. They expire, someone rotates them without telling the platform team, and every holder of the secret looks identical in the audit log.

Use static secrets for proofs of concept. Move production edges to OIDC as soon as both sides support it, which, after this week, covers most of the matrix.

### User Identity Versus Service Identity

One more distinction cuts across all three methods. A federated query runs either as a service identity or as the end user.

Google's default is service identity. Both background metadata refresh and queries run as the catalog's service account. The alternative, user identity federation, keeps metadata refresh on the service account but propagates the end user's identity on queries, so the remote catalog enforces its own permissions and logs the real user. As of this release, Google supports user identity federation only for Databricks Unity Catalog.

This matters more than it looks. With service identity, the remote catalog sees one principal for every Google user. Its row filters and column masks apply to that principal, not to the person running the query. Any per-user governance has to be rebuilt on the reading side. With user identity federation, the remote catalog stays the single place where access policy lives.

## Where Federation Breaks

Federation removes copies. It does not remove the hard problems. It moves them to the seams between catalogs. These are the four seams that break most often.

### Identity Mapping

Two catalogs rarely share a user directory. Platform A knows `analyst@company.com` through its own identity provider. Catalog B knows a role called `ANALYTICS_READER`. Somebody has to decide how one maps to the other.

With service identity, the mapping collapses to "everyone from platform A is this one principal." That is simple and coarse. With user identity federation, both sides need a shared issuer or a mapping table, and the mapping drifts as people change teams. The warning sign is a support ticket that says "I can see this table in Snowflake but not from BigQuery," or the reverse. Those tickets mean the two permission models disagree, and federation exposed the disagreement.

### Write Ownership

An Iceberg table needs one catalog that serializes its commits. The IRC uses optimistic concurrency: a writer reads the current metadata pointer, writes new metadata, and asks the catalog to swap the pointer only if nobody else changed it. That guarantee holds inside one catalog. It does not span two catalogs that each believe they own the same table.

This is why most federation edges are read-only, and why the ones that allow writes route every commit back through the owning catalog. Snowflake's externally managed table writes go through Horizon's IRC, and Horizon forwards to the owning catalog's rules. Before you enable writes on any edge, answer one question in writing: which catalog is the writer of record for this table? If the answer is "both," you have a split-brain risk, and the first conflicting commit will prove it.

### View Portability

Iceberg views store SQL text plus a dialect tag. A view written in Snowflake SQL does not run in Spark just because the catalog federates it. Some catalogs expose views through the IRC. Others expose only tables. Databricks made external access to views through the Unity REST API GA on October 13, which helps engines that speak that API, but the dialect problem remains on every edge.

Plan on federating tables and rebuilding views on the reading side. Treat any cross-engine view that works as a bonus you verify, not a feature you assume.

### Metadata Freshness

Sync-based federation refreshes on an interval. Between refreshes, the reading side can plan queries against a snapshot that is no longer current. Google's caching documentation states that every query verifies metadata and access permissions with the remote source before serving cached data, so a revoked permission does not survive in the cache. The metadata refresh interval is still a separate setting from cache validation. Know both values for each edge.

The failure mode looks like this. A pipeline commits to a Unity-owned table at 9:00. A dashboard on the federated side runs at 9:02 and shows yesterday's totals. Nobody gets an error. Somebody gets a wrong number. If a downstream consumer needs commit-level freshness, give it a direct IRC connection to the owning catalog instead of a synced copy.

## How to Verify an Edge Yourself in 15 Minutes

A matrix is a snapshot, and vendors change release stages quietly. The reliable move is to test the specific edge you plan to use. This procedure works against any IRC endpoint, including federated ones that expose an IRC surface.

**Step one: confirm the endpoint answers and read its defaults.** Every IRC server exposes `GET /v1/config`. The response tells you the catalog's prefix and default properties, and on newer servers it lists the endpoints the server supports.

```bash
# 1. Get a token (OAuth2 client credentials shown; swap in your
#    provider's token exchange flow if it uses OIDC federation)
TOKEN=$(curl -s -X POST "$TOKEN_URL" \
  -d grant_type=client_credentials \
  -d client_id="$CLIENT_ID" \
  -d client_secret="$CLIENT_SECRET" \
  -d scope="$SCOPE" | jq -r .access_token)

# 2. Ask the catalog what it supports
curl -s "$CATALOG_URI/v1/config?warehouse=$WAREHOUSE" \
  -H "Authorization: Bearer $TOKEN" | jq .

# 3. List namespaces under the prefix returned by /v1/config
curl -s "$CATALOG_URI/v1/$PREFIX/namespaces" \
  -H "Authorization: Bearer $TOKEN" | jq .

# 4. Load one table and ask for vended credentials
curl -s "$CATALOG_URI/v1/$PREFIX/namespaces/sales/tables/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Iceberg-Access-Delegation: vended-credentials" \
  | jq '{location: .metadata.location,
         snapshot: .metadata."current-snapshot-id",
         creds: (.config | keys)}'
```

Here is what each step proves. Step one proves the identity flow works and that the token carries a scope the catalog accepts. Step two shows the catalog's `prefix` and, on recent servers, an `endpoints` list. If the list omits the commit endpoint, writes are not available on that surface, whatever the marketing page says. Step three proves your principal can see the namespace. Step four proves the catalog can load table metadata for you, and the `config` keys show whether it vended storage credentials. Empty storage keys mean the engine will need its own storage access.

**Step two: read through an engine, not just curl.** A catalog that answers HTTP calls can still fail inside an engine because of config differences. Google publishes the exact Spark properties for its federated catalogs:

```bash
spark-sql \
  --conf spark.sql.catalog.remote=org.apache.iceberg.spark.SparkCatalog \
  --conf spark.sql.catalog.remote.type=rest \
  --conf spark.sql.catalog.remote.uri=https://biglake.googleapis.com/iceberg/v1/restcatalog \
  --conf spark.sql.catalog.remote.warehouse=bl://projects/PROJECT_ID/catalogs/FEDERATED_CATALOG_NAME \
  --conf spark.sql.catalog.remote.header.x-goog-user-project=PROJECT_ID \
  --conf spark.sql.catalog.remote.header.X-Iceberg-Access-Delegation=vended-credentials \
  -e "SELECT count(*) FROM remote.sales.orders"
```

The `warehouse` value uses the `bl://` scheme to name a federated catalog inside a Google project. The `x-goog-user-project` header tells Google which project to bill and authorize against. The delegation header asks for vended credentials, which is how the engine reads remote files without holding your AWS or Azure keys.

**Step three: test the write path, if you need one.** Run a single-row insert into a scratch table in a scratch namespace. Then load that table directly from the owning catalog and confirm the new snapshot appears there. If the commit lands only on the reading side, you have built a replica, not a federated write.

**Step four: check the audit trail.** Find the request in the owning catalog's logs. Snowflake writes Horizon IRC requests to the account event table now that telemetry is GA. Confirm which principal the log records. That tells you whether you are running on service identity or user identity, which no setup screen states as clearly.

Write down the date and results. A dated test result is worth more than any row in this article, including mine.

## Operational Guidance for Teams Building on Federated Edges

A few rules hold across every edge in the matrix.

**Pick one writer of record per table and document it.** Put it in the table's properties or in your data catalog. When an incident starts, the first question is always "who owns this table," and the answer has to take seconds, not a meeting.

**Prefer OIDC on every new edge.** This week moved Glue onto standard bearer tokens, and Snowflake and Google already supported OIDC. Static secrets now have fewer excuses. Each one you replace removes a rotation chore and a shared-credential audit gap.

**Budget for metadata egress, not just data egress.** Federation reads manifests and metadata files across clouds on every refresh. For tables with thousands of manifests, that traffic adds up even when queries are selective. Google lets you route metadata refresh privately over Cross-Cloud Interconnect for Glue, Unity and Horizon on AWS and Azure, separately from query traffic. Decide that routing deliberately.

**Turn caching on only after you check residency.** Google's cross-cloud cache stores copies of remote file blocks at rest in the Google Cloud region where the query runs. If your source files sit in an EU bucket and the query runs in a US region, the cache places EU data in the US. Google documents this and notes that customer-managed encryption keys (CMEK) are not supported for the cache. If your organization enforces the Restrict Non-CMEK Services policy, Lakehouse disables caching for affected tables and queries read remote storage directly.

**Monitor cache hit ratios with the fields the platform gives you.** Google exposes `cacheBytesRead` and `objectStorageBytesRead` in BigQuery job statistics. Divide the first by the sum of both. A ratio near zero after a week means your query pattern rereads too little to benefit, and the cache only adds a residency question without a cost win.

**Rebuild governance on the reading side when you run on service identity.** If the remote catalog sees one service principal, its masking and row filters protect nothing at the user level. Either use user identity federation where it exists, which today on Google means Unity only, or apply equivalent policies on the reading platform and test them.

**Refresh this map on a schedule.** Release stages move every few weeks. I plan to update this page with a dated changelog rather than publish a new one, so the URL stays the place to check.

## Where the Map Is Heading

Three trends show up when you line the edges up by date.

The IRC has become the default federation protocol. Google's remote providers all connect over the IRC, with Delta Sharing reserved for SAP BDC. Snowflake integrated Apache Polaris into Horizon to serve external engines. AWS moved Glue's IRC onto the spec's standard OAuth flow. SAP built its BDC universal catalog on Polaris and the IRC. When four very different vendors converge on one protocol inside a year, the protocol has won the argument. Vendor differentiation moves up a layer, into governance, semantics and context for AI agents.

Identity propagation is the next contested surface. Today only one edge in the matrix, Google to Unity, carries the end user's identity through to the remote catalog. Everyone else runs on service identity. Expect pressure from security teams to close that gap, because agents make it worse. An AI agent querying through a federated catalog as a shared service principal is the exact pattern auditors flag. The IRC community is already discussing auth changes on the Iceberg dev list, including a proposal to narrow the Java client's OAuth2 AuthManager and a new BearerAuthManager. Those changes will shape how engines carry tokens across these edges.

Write federation will stay narrow on purpose. The commit protocol needs one serializing catalog, and no vendor wants another vendor's engine committing to its tables without its rules in the path. The likely end state is the one Snowflake shipped: external engines write through the owning catalog's IRC endpoint, under the owning catalog's access control. That is federation of access, not federation of ownership, and it is the right design.

The open standards here carry the weight. Apache Iceberg defines the table and the REST protocol. Apache Polaris, which graduated to a Top-Level Project on February 18, 2026, gives vendors a shared implementation to build on. When you evaluate any edge in this map, the most useful question is how much of it is the open spec and how much is vendor glue. The more spec, the more portable your design.

## Changelog

- **November 3, 2026:** First edition. Google remote catalog providers GA (Nov 2). Snowflake externally managed Iceberg tables through Horizon GA, plus Horizon IRC telemetry GA (Oct 29). SAP BDC universal catalog powered by Polaris announced (Oct 29). AWS Glue OAuth 2.0 bearer tokens for the IRC (Oct 26).

## Conclusion

Catalog federation stopped being a vendor-by-vendor connector story this fall. Most edges now run on the Iceberg REST Catalog protocol with standard OIDC identity, and the differences between them come down to direction, write support and whose identity reaches the remote catalog. The matrix above captures those facts as of November 3, 2026, with a source for each row.

Use it as a starting point, then verify the edge you depend on with the 15-minute test. Decide the writer of record for every table before you turn on writes. Move static secrets to OIDC now that nearly every edge supports it. And check where cached copies land before you enable caching across regions. The catalogs will keep changing. Those four habits keep a federated design from turning into a set of silent copies.

## Keep Going

If this piece was useful, I have written a lot more on Iceberg catalogs and how engines share them. *Apache Polaris: The Definitive Guide* (O'Reilly) covers the REST catalog protocol, credential vending and multi-engine catalog design in depth. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
