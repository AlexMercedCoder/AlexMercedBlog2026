---
title: "Inside the Iceberg REST Catalog's Multi-Table Commit Endpoint"
description: "How POST /v1/{prefix}/transactions/commit works: request shape, requirements, atomicity, error codes, idempotency, and limits."
date: 2026-10-27T09:00:00Z
tags: ["Apache Iceberg", "REST catalog", "transactions", "atomic commits", "Apache Polaris"]
canonical: https://iceberglakehouse.com/posts/iceberg-rest-multi-table-commit-transactions/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/iceberg-rest-multi-table-commit-transactions/).

# Inside the Iceberg REST Catalog's Multi-Table Commit Endpoint

A customer asks to be forgotten. Their data lives in five Apache Iceberg tables: orders, payments, support tickets, a marketing profile, and an events table. The erasure job deletes their rows from each table, one commit at a time. The third commit fails on a conflict with a compaction job. The job retries, fails again, and pages someone. For the next hour the customer is half deleted. Two tables say they are gone. Three tables still hold their data.

Nothing about that failure is exotic. It is the default behavior of a lakehouse where every table commits on its own. Each commit is atomic. The set of commits is not.

The Iceberg REST Catalog specification has an answer for this, and it has existed for a while: a single endpoint, `POST /v1/{prefix}/transactions/commit`, that applies changes to several tables as one atomic operation. Either every table moves to its new state or none of them do.

Few teams use it. Most engines do not call it. Many engineers who run REST catalogs every day have never looked at its request shape. This article walks through the endpoint in detail: what goes in the request, how the server validates it, what the response codes mean, how a client discovers whether a server supports it, how retries stay safe, and where the guarantee stops. The broader story of how the REST catalog became a control plane lives in a companion article on IcebergLakehouse, "[How the Iceberg REST Catalog Turned Into the Lakehouse Control Plane](https://iceberglakehouse.com/posts/rest-catalog-v2-multi-table-commits/)." This piece stays on one endpoint and goes deep.

## What a Single-Table Commit Guarantees

To understand the multi-table endpoint, start with the single-table commit it generalizes.

An Iceberg table is a pointer to a metadata file. That metadata file lists schemas, partition specs, sort orders, snapshots, and references such as the `main` branch. A write produces new data files, new manifests, and a new snapshot, then asks the catalog to move the table's pointer to a new metadata state that includes that snapshot.

With a REST catalog, the client never swaps the pointer itself. It sends the catalog a description of the change to `POST /v1/{prefix}/namespaces/{namespace}/tables/{table}`. That description has two parts.

**Requirements** describe what must still be true about the table for the change to be valid. A typical requirement says the `main` branch still points at the snapshot this write started from.

**Updates** describe the changes. A typical update list adds a snapshot and then sets the `main` reference to that snapshot's ID.

The server checks every requirement against the table's current metadata. If all of them hold, it applies the updates, writes a new metadata file, and moves the pointer. If any requirement fails, it rejects the commit with a conflict, and the client refreshes the table, re-applies its changes on top of the new state, and tries again.

This is optimistic concurrency control. Writers do not lock the table while they work. They check at the end that nothing incompatible happened in the meantime. Because the server owns the check, every engine that talks to the catalog gets the same conflict detection.

The guarantee is precise. One table moves from one valid metadata state to another, atomically. Readers loading that table see the old state or the new state, never a mix. That guarantee says nothing about any other table.

## The Endpoint and Its Request Shape

The multi-table endpoint takes the same requirement-and-update structure and wraps several of them in one request.

The path is `POST /v1/{prefix}/transactions/commit`. The `{prefix}` segment comes from the catalog's configuration response and lets one server host several catalogs.

The request body is a `CommitTransactionRequest`. It has one field, `table-changes`, which is an array. Each element is a table commit with three fields: an `identifier`, a list of `requirements`, and a list of `updates`. The identifier is mandatory in this context. In the single-table endpoint the table is named in the URL path, so the identifier is optional in the body. In the transaction endpoint there is no table in the path, so each change must name its table.

Here is a trimmed example that commits a delete to two tables at once.

```json
{
  "table-changes": [
    {
      "identifier": { "namespace": ["crm"], "name": "orders" },
      "requirements": [
        { "type": "assert-table-uuid", "uuid": "7a1c0e6e-4b1f-4a52-9f0e-2d5e8b3c1a90" },
        { "type": "assert-ref-snapshot-id", "ref": "main", "snapshot-id": 5523148870012948211 }
      ],
      "updates": [
        {
          "action": "add-snapshot",
          "snapshot": {
            "snapshot-id": 6100034412208854477,
            "parent-snapshot-id": 5523148870012948211,
            "sequence-number": 812,
            "timestamp-ms": 1793142000000,
            "manifest-list": "s3://lake/crm/orders/metadata/snap-6100034412208854477.avro",
            "summary": { "operation": "delete" },
            "schema-id": 3
          }
        },
        {
          "action": "set-snapshot-ref",
          "ref-name": "main",
          "type": "branch",
          "snapshot-id": 6100034412208854477
        }
      ]
    },
    {
      "identifier": { "namespace": ["crm"], "name": "payments" },
      "requirements": [
        { "type": "assert-table-uuid", "uuid": "c94f1b2d-0a7e-4d0b-8c35-61f2e9a7b4d3" },
        { "type": "assert-ref-snapshot-id", "ref": "main", "snapshot-id": 1180037741129904532 }
      ],
      "updates": [
        { "action": "add-snapshot", "snapshot": { "...": "..." } },
        { "action": "set-snapshot-ref", "ref-name": "main", "type": "branch", "snapshot-id": 2299104458831007716 }
      ]
    }
  ]
}
```

Walk through the first table change.

The `identifier` names the table by namespace and name. Namespaces are arrays because Iceberg supports nested namespaces.

The first requirement, `assert-table-uuid`, pins the change to one specific table instance. If someone dropped `crm.orders` and created a new table with the same name between the client's read and its commit, the UUID changes and this requirement fails. Without it, a commit built against the old table lands on the new one.

The second requirement, `assert-ref-snapshot-id`, says the `main` branch must still point at snapshot 5523148870012948211. This is the core optimistic concurrency check. If another writer committed to `main` in the meantime, the branch has moved and the requirement fails.

The first update, `add-snapshot`, registers the new snapshot in the table's metadata. The snapshot object points at a manifest list file the client already wrote to storage. The client writes all data files, delete files, manifests, and the manifest list before it sends the request. The catalog never touches data. It only records metadata.

The second update, `set-snapshot-ref`, moves `main` to the new snapshot. Without this update, the snapshot exists in metadata but no branch points at it, so no reader sees it.

The second table change has the same shape for a different table. The server treats the whole array as one unit.

## Requirements in Depth

Requirements are the part of the request that decide whether a transaction is safe. The REST specification defines a fixed set of requirement types, and each one guards against a different kind of race.

`assert-create` says the table must not exist yet. It is used when a transaction creates a table.

`assert-table-uuid` says the table's UUID must match. It protects against drop-and-recreate races.

`assert-ref-snapshot-id` says a named reference must point at a given snapshot ID, or must not exist when the snapshot ID is null. It protects against concurrent data commits on that branch or tag.

`assert-last-assigned-field-id` says the table's highest assigned column ID must match. It protects against a concurrent schema change that added columns.

`assert-current-schema-id` says the table's current schema must match. It protects against writing data that was validated against an outdated schema.

`assert-last-assigned-partition-id` says the highest assigned partition field ID must match. It protects against concurrent partition spec changes.

`assert-default-spec-id` says the default partition spec must match. It protects against writing files under an outdated partition layout.

`assert-default-sort-order-id` says the default sort order must match.

A client chooses requirements based on what its updates depend on. A pure data append usually needs only the table UUID and the branch snapshot. A schema change needs the field ID and schema assertions. A transaction that changes both a table's schema and its data needs the union.

The important design point is that requirements are evaluated per table but decided together. In a multi-table transaction, the server checks every requirement for every table in the request. One failed requirement on any table fails the entire transaction.

That changes how you think about conflicts. In single-table land, a conflict on table three only affects table three. In a transaction, a conflict on table three blocks tables one, two, four, and five. A transaction with many tables has a larger conflict surface than any of its parts. The operational section returns to this, because it decides how large a transaction should be.

## Matching Requirements to the Change You Are Making

Clients that build requests by hand, or that wrap the Java API in their own tooling, need a rule for which requirements to send. Too few and the commit lands on a table state it was not built for. Too many and it conflicts for reasons that do not matter. This table is the mapping I use.

| Change in the transaction | Requirements to send for that table |
|---|---|
| Append or delete data on `main` | `assert-table-uuid`, `assert-ref-snapshot-id` for `main` |
| Fast-forward `main` to a staging branch | `assert-table-uuid`, `assert-ref-snapshot-id` for `main` and for the staging branch |
| Add a column | `assert-table-uuid`, `assert-current-schema-id`, `assert-last-assigned-field-id` |
| Change the partition spec | `assert-table-uuid`, `assert-default-spec-id`, `assert-last-assigned-partition-id` |
| Change the sort order | `assert-table-uuid`, `assert-default-sort-order-id` |
| Create a table inside the transaction | `assert-create` |
| Schema change plus data write | the union of the schema and data rows above |

Two rows deserve comment.

The fast-forward row asserts both references. Asserting `main` catches a concurrent writer on the published branch. Asserting the staging branch catches a late write to staging that arrived after validation. Without the second assertion, a transaction publishes data nobody audited.

The schema-plus-data row matters because the Iceberg writer validated the new data files against a specific schema. If someone else changed the schema in between, those files describe columns by field IDs the table no longer expects. The schema assertions turn that silent mismatch into a clean conflict.

`TableCommit.create` derives these requirements for you from the base and updated metadata. When you build requests yourself, this table is the checklist.

## Server-Side Semantics and Response Codes

The specification describes the endpoint as committing updates to multiple tables in an atomic operation. The server either applies every change in the request or applies none of them.

How a server achieves that is up to the server. A catalog backed by a relational database can wrap all pointer updates in one database transaction. A catalog backed by a key-value store needs a store that supports conditional writes across keys, or it needs its own coordination layer. This is why multi-table commits are a catalog feature and not a table format feature. A file-based catalog that swaps one pointer file per table has no atomic way to swap five.

The response codes follow the same conventions as single-table commits, with one difference in the success case.

**204 No Content.** The transaction committed. Every table moved. The single-table endpoint returns 200 with the new metadata in the body. The transaction endpoint returns nothing, so a client that needs the new metadata for any table loads it afterward.

**400 Bad Request.** The request was malformed, such as a missing identifier or an unknown update action.

**401 and 403.** The caller is not authenticated or lacks permission. Authorization applies to every table in the request. A principal who can write four of five tables cannot commit a transaction that touches all five.

**404 Not Found.** A table in the request does not exist.

**409 Conflict.** At least one requirement failed. Nothing was committed. The client refreshes every table in the transaction and rebuilds the request.

**500, 502, 504.** These are the dangerous ones. A server error or gateway timeout during a commit means the client does not know whether the commit happened. The Java client surfaces this as a `CommitStateUnknownException`. The correct response is not to retry blindly, since the commit landed in some fraction of these cases. The correct response is to reload the tables and check whether the new snapshots are present before deciding what to do.

## How a Catalog Makes Five Tables Move at Once

It helps to know roughly what the server does with the request, because it explains both the latency of transaction commits and some of their failure behavior.

A catalog that stores table pointers in a relational database, which is the common case for open source REST catalogs, handles a transaction in roughly four steps. It loads the current metadata for every table in the request. It evaluates every requirement against that metadata. If all pass, it computes the new metadata for each table and writes each new metadata file to object storage. Then it opens one database transaction, updates every table's pointer row conditionally on the pointer still matching what it loaded, and commits.

The conditional update is what makes the operation atomic. If any pointer changed between the load and the database commit, the condition fails, the database rolls back every pointer update, and the server returns a conflict. The metadata files it wrote to storage become orphans, which is harmless.

Two details follow from that design.

First, a transaction holds row locks on several pointer rows for the duration of the database commit. Servers usually lock rows in a consistent order, such as sorted by table identifier, so two transactions touching overlapping tables cannot deadlock each other. If you run a catalog you built yourself, check that it does this.

Second, transaction latency scales with the number of tables. Each table adds a metadata load, a requirement check, and a metadata file write before the database commit even starts. A two-table transaction costs little more than a single commit. A thirty-table transaction holds its locks noticeably longer and blocks every concurrent single-table commit against those tables while it does.

Some catalogs go further and resolve conflicts on the server. If a requirement fails only because another writer appended unrelated data, a server can rebase the change onto the new state and retry internally rather than returning a 409. Server-side conflict resolution is an optional catalog capability, not part of the transaction contract. Treat it as a bonus and keep the client retry loop regardless.

## Discovering Whether a Server Supports It

The transaction endpoint is optional. A server that implements the REST specification is not required to support it. Clients need a way to find out before they depend on it.

That mechanism is endpoint discovery through the configuration route. Every REST client starts by calling `GET /v1/config`, optionally with a `warehouse` query parameter. The response contains three kinds of information: `defaults`, which are suggested client properties, `overrides`, which are required client properties such as the `prefix`, and `endpoints`, which lists the API routes the server supports.

A server that supports multi-table commits includes `POST /v1/{prefix}/transactions/commit` in its `endpoints` list. A server that omits the entry does not support the feature. If the server omits the `endpoints` field entirely, the Java client assumes a default set of namespace and table routes, which does not include transactions.

This is worth checking by hand against every catalog you run, because support varies by catalog and by version. Several open source REST catalogs, including Apache Polaris, Project Nessie, and Lakekeeper, have shipped transaction support at various points. Whether your deployed version advertises it is a question your config response answers in one request:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://catalog.example.com/api/catalog/v1/config?warehouse=prod" \
  | jq '.endpoints[] | select(contains("transactions"))'
```

An empty result means the server does not advertise the endpoint, and a client must not use it.

## The Java API, Step by Step

The Iceberg Java library exposes the endpoint as `RESTCatalog.commitTransaction`. It accepts a list of `TableCommit` objects, or the same objects as varargs. A `TableCommit` bundles a table identifier with its requirements and updates.

The convenient way to build a `TableCommit` is `TableCommit.create(identifier, base, updated)`, which compares two versions of a table's metadata and derives the requirements and updates that move one to the other. The pattern below follows the approach Iceberg's own REST catalog tests use.

```java
import org.apache.iceberg.*;
import org.apache.iceberg.catalog.TableCommit;
import org.apache.iceberg.catalog.TableIdentifier;
import org.apache.iceberg.expressions.Expressions;
import org.apache.iceberg.rest.RESTCatalog;
import java.util.List;
import java.util.Map;

RESTCatalog catalog = new RESTCatalog();
catalog.initialize("prod", Map.of(
    "uri", "https://catalog.example.com/api/catalog",
    "warehouse", "prod",
    "credential", System.getenv("CATALOG_CREDENTIAL")));

List<String> tables = List.of("orders", "payments", "tickets");
List<TableCommit> commits = new java.util.ArrayList<>();

for (String name : tables) {
  TableIdentifier id = TableIdentifier.of("crm", name);
  Table table = catalog.loadTable(id);
  TableMetadata base = ((HasTableOperations) table).operations().current();

  Transaction tx = table.newTransaction();
  tx.newDelete()
    .deleteFromRowFilter(Expressions.equal("customer_id", 48211L))
    .commit();   // stages the change in the transaction, not in the catalog

  TableMetadata updated = ((BaseTransaction) tx).currentMetadata();
  commits.add(TableCommit.create(id, base, updated));
}

catalog.commitTransaction(commits);   // one POST to /transactions/commit
```

Here is what each part does.

The `initialize` call configures the client. On startup it calls `GET /v1/config` and reads the endpoint list. If the server does not advertise the transaction endpoint, `commitTransaction` fails rather than silently falling back to separate commits.

The loop loads each table and captures its current metadata as `base`. That is the state the transaction builds on, and it becomes the source of the requirements.

`table.newTransaction()` opens a local, in-memory transaction on one table. Operations committed inside it update the transaction's working metadata, not the catalog.

`deleteFromRowFilter` expresses the erasure. This form deletes whole data files where every row matches the filter. If matching rows share files with other customers' rows, a row-level delete through an engine such as Spark, which writes position deletes or deletion vectors, is the right tool, and the transaction pattern stays the same.

`currentMetadata()` returns the transaction's staged metadata. The cast to `BaseTransaction` reaches past the public `Transaction` interface. That is the honest price of this pattern today: the public API for building multi-table commits is thin, and the cast ties your code to an implementation class.

`TableCommit.create` diffs `base` against `updated` and produces the requirement and update lists the server needs.

The final `commitTransaction` sends one request with all three table changes. On success every table moves. On a `CommitFailedException` none of them move, and the code above needs a retry loop that reloads all three tables and rebuilds every commit from scratch. On a `CommitStateUnknownException` the code needs to reload and inspect before doing anything else.

## What Engines Do Today

This is the part that surprises people. The Iceberg documentation states it plainly: engines commit tables individually today, so the multi-table endpoint is primarily a Java API feature, and servers are not required to support it.

In practice that means a `MERGE` in Spark commits one table. A Flink sink commits one table per checkpoint. A dbt run that builds five models produces five separate commits, in dependency order, through whatever engine dbt drives. None of these paths call the transaction endpoint.

So the way to get multi-table atomicity today is to write the commit path yourself. The common patterns are:

**A custom Java or JVM job.** Do the data work with an engine or with the Iceberg API, stage the metadata changes per table, and commit them together through `commitTransaction`, as in the example above.

**A two-phase pattern with branches.** Have each engine write to a staging branch on each table, using ordinary single-table commits. Then run a small Java step that builds one transaction moving `main` on every table to the head of its staging branch. The heavy work runs through normal engines. Only the final publish step uses the transaction endpoint. This is the most practical pattern I know for teams whose writes run through Spark or Flink.

**Catalog-native branching.** Some catalogs offer branches that span many tables, so a merge of a catalog-level branch moves every table at once. Project Nessie is the best-known example. That model works well when every table lives in one catalog that supports it. It is a different mechanism from the REST transaction endpoint, and it ties the workflow to that catalog's own API.

Clients outside the JVM are a separate question. The endpoint is plain JSON over HTTP, so any language can call it. The hard part is not the request. It is producing the snapshot objects inside it, which point at manifest lists and manifests the client must write correctly first. Libraries such as PyIceberg, iceberg-rust, and iceberg-go build those files for their own single-table commits, and their support for the transaction endpoint varies by release. Check the client's changelog before you assume it. The reference-only publish pattern helps here too. A transaction that only moves references needs no new manifests, so a thin HTTP client in any language can send it safely once the heavy writes are done through an engine.

The branch-based publish pattern deserves one more sentence. A transaction whose updates only move references, with no new snapshots, is small, cheap to validate, and fast to retry. Keeping the expensive work out of the transaction makes the transaction itself more likely to succeed.

## A Worked Example: Staging Branches Plus One Publish Transaction

The erasure job from the opening is a good fit for the branch-based pattern, because the deletes are row-level and run best through an engine, while the publish step needs atomicity.

Step one creates a staging branch on each table and runs the deletes there with ordinary Spark commits.

```sql
-- once per table, per erasure request
ALTER TABLE crm.orders   CREATE BRANCH erase_48211 RETAIN 3 DAYS;
ALTER TABLE crm.payments CREATE BRANCH erase_48211 RETAIN 3 DAYS;
ALTER TABLE crm.tickets  CREATE BRANCH erase_48211 RETAIN 3 DAYS;

-- direct subsequent writes in this session to the staging branch
SET spark.wap.branch = erase_48211;

DELETE FROM crm.orders   WHERE customer_id = 48211;
DELETE FROM crm.payments WHERE customer_id = 48211;
DELETE FROM crm.tickets  WHERE customer_id = 48211;
```

The `CREATE BRANCH` statements fork each table's current `main` into a new branch. The `RETAIN 3 DAYS` clause gives each branch a maximum age, so abandoned erasure branches expire instead of living forever, which is the default. The `spark.wap.branch` session setting routes the deletes to the staging branch instead of `main`. Write-audit-publish routing requires the table property `write.wap.enabled` set to `true` on each table. Each delete is an ordinary single-table commit to its staging branch. Readers of `main` see nothing yet.

Step two verifies the staging state. A check such as `SELECT count(*) FROM crm.orders VERSION AS OF 'erase_48211' WHERE customer_id = 48211` must return zero for every table. This is where you add any other audit the erasure process requires.

Step three publishes all three branches in one transaction.

```java
List<TableCommit> commits = new java.util.ArrayList<>();
for (String name : List.of("orders", "payments", "tickets")) {
  TableIdentifier id = TableIdentifier.of("crm", name);
  Table table = catalog.loadTable(id);
  TableMetadata base = ((HasTableOperations) table).operations().current();

  Transaction tx = table.newTransaction();
  tx.manageSnapshots().fastForwardBranch("main", "erase_48211").commit();
  TableMetadata updated = ((BaseTransaction) tx).currentMetadata();

  commits.add(TableCommit.create(id, base, updated));
}
catalog.commitTransaction(commits);
```

Each table change in this request contains no new snapshot at all. It only moves `main` to the head of `erase_48211`. Fast-forward succeeds only when `main` is an ancestor of the staging branch head, which is true as long as nobody committed to `main` after the branch was created. If someone did, the fast-forward fails locally before the request is ever sent, and the job rebuilds the staging branch from the new `main`.

The result: three engine-driven deletes, one audit gate, and one atomic publish. The customer goes from fully present to fully gone with no intermediate state visible on `main`.

Step four cleans up with `ALTER TABLE ... DROP BRANCH erase_48211` on each table, or simply lets the three-day retention expire the branches.

## Idempotency Keys and Safe Retries

Retries are where atomic commits get tricky. A client sends a transaction, the network drops the response, and the client has no idea whether the catalog applied it. Retrying blindly produces either a harmless conflict, if the first attempt landed, or a duplicate change, if the server's requirement checks happen to pass a second time.

The REST specification addresses this with idempotency keys. A server that supports them advertises an `idempotency-key-lifetime` value in its configuration response, written as an ISO-8601 duration such as `PT30M`. The presence of that field tells the client the server honors the `Idempotency-Key` header on mutation endpoints. A client then attaches a unique key to each mutating request and reuses the same key for retries of that request within the advertised lifetime. The server remembers the key and the outcome, and a retry with the same key returns the original result instead of applying the change again.

If the field is absent, the client must assume the server does not support idempotency.

For multi-table transactions this matters more than for single-table commits, because the cost of a duplicate is multiplied by the number of tables. Check whether your catalog advertises the lifetime, check whether your client sends the header, and size your retry window inside the lifetime. A retry after the key expires gets a fresh key and loses the protection.

## Observability and Audit

A transaction endpoint in production needs the same visibility as any other write path, plus a few signals specific to multi-table work.

**Conflict rate per table.** Track how often each table appears in a transaction that fails with a 409, and which requirement failed. A single table that drives most conflicts is usually a table with a busy maintenance job or a streaming writer. Move that table out of the transaction or give it a quieter window.

**Transaction size.** Record the number of tables per transaction. A distribution that creeps upward over months is a sign that pipelines are bundling tables that do not need to move together.

**Commit latency by size.** Plot server-side commit time against table count. A sharp jump at some size tells you where lock hold time starts to hurt concurrent writers.

**Unknown-state outcomes.** Count 5xx responses on the transaction endpoint separately from other errors, and count how often a reload afterward showed the commit had landed. Those numbers tell you how much your idempotency and reload logic is actually doing.

**An audit record per transaction.** Compliance workflows such as erasure need proof. Log the principal, the request ID, every table identifier, the prior snapshot ID and the new snapshot ID per table, and the outcome. Iceberg's own snapshot history shows that each table changed. Only a transaction-level record shows that they changed together, in one request, under one identity.

Catalogs differ in how much of this they emit natively. Where the catalog emits little, wrap the client call and record it yourself. The wrapper is a few dozen lines and pays for itself the first time someone asks you to prove an erasure was atomic.

## Failure Modes

**Atomic commit is not a consistent multi-table read.** This is the misunderstanding I see most. The transaction guarantees that the catalog moves every table together. It does not guarantee that a reader sees every table at the same moment. A query that loads `orders`, runs for ten seconds, then loads `payments` can see `orders` before the commit and `payments` after it. Readers that need a consistent view across tables must pin snapshots, such as by recording the snapshot IDs after a known commit and querying each table at those IDs. The REST protocol has no cross-table read snapshot.

**A large transaction conflicts constantly.** Every table in the request adds conflict surface. A twenty-table transaction against busy tables fails whenever any one of those tables sees a concurrent commit between the client's load and its request. Keep transactions to the tables that must move together. Split everything else into ordinary commits.

**Maintenance jobs collide with transactions.** Compaction and snapshot expiration commit to the same branches as your pipelines. A compaction job that rewrites files on `crm.orders` moves `main`, and the next transaction that touches `crm.orders` fails its `assert-ref-snapshot-id` check. Schedule maintenance away from transaction windows, or have maintenance write to a separate branch and fast-forward later.

**Silent fallback to separate commits.** Code that checks for the endpoint, finds it missing, and falls back to committing tables one at a time quietly loses the guarantee the code was written to provide. If a workload needs atomicity, a missing endpoint is a hard failure.

**Treating a 5xx as a failure.** A server error during commit does not mean nothing happened. Retrying without checking, and without an idempotency key, can apply the change twice or fail confusingly on requirements that the first attempt already satisfied.

**Partial authorization.** A principal with write access to most but not all tables in a transaction gets a 403 for the whole request. That is correct behavior, but it surprises teams who granted permissions table by table and never tested the union.

**Orphaned files after a failed transaction.** The client writes data files and manifests before it sends the request. If the transaction fails and the client gives up, those files sit in storage with nothing pointing at them. Orphan file cleanup removes them eventually. Until it runs, they cost storage.

## Operational Guidance

**Check the endpoint list first.** Before designing around transactions, call `GET /v1/config` against every catalog in scope and confirm the endpoint is advertised. Re-check after catalog upgrades.

**Keep transactions small and reference-only where you can.** The branch-based publish pattern keeps heavy writes out of the transaction. The transaction then only moves references, which validates fast and retries cheaply.

**Always include `assert-table-uuid`.** It costs nothing and prevents a class of drop-and-recreate bugs that are miserable to diagnose.

**Retry from a full reload.** On a 409, reload every table in the transaction, rebuild every change against the new state, and resubmit. Never patch a single table's requirements and resend the rest.

**Use idempotency keys if the server supports them.** Retries inside the advertised lifetime stay safe. Retries outside it need the reload-and-inspect step.

**Bound retries and alert.** A transaction that conflicts five times in a row usually means a maintenance job or another pipeline is fighting it. Alert on that pattern instead of retrying forever.

**Record the committed snapshot IDs.** After a successful transaction, load each table and record the new `main` snapshot IDs in a run log. That log gives downstream readers a consistent set of IDs to pin, which closes the read consistency gap described above.

**Test with fault injection.** Run your commit path against a test catalog while a second writer commits to one of the tables. Confirm the transaction fails cleanly, retries correctly, and never leaves a subset of tables moved.

## When Not to Use a Transaction

Atomic multi-table commits are a sharp tool. Several common workloads do not need them, and forcing them in adds conflict surface without adding safety.

**Independent tables that happen to run in the same job.** A nightly job that refreshes ten unrelated reporting tables gains nothing from committing them together. If table four fails, tables one through three are still correct on their own. Commit them separately and retry the failure.

**Pipelines that already tolerate lag.** A fact table and a dimension table that update minutes apart often do not need atomicity if the fact table only references dimension keys that already exist. Order the commits so the dimension lands first. The window of inconsistency becomes a window where new dimension rows have no facts yet, which most reports handle fine.

**Streaming ingestion.** A streaming writer commits every few seconds or minutes. Wrapping several streaming tables in one transaction couples their checkpoint cadence and turns one slow table into backpressure on all of them. Streaming tables are usually better served by per-table commits plus downstream readers that pin snapshot IDs.

**Very wide fan-out.** Thirty tables in one transaction against busy tables rarely succeed on the first attempt. If thirty tables genuinely must move together, the branch-based publish pattern is the only version of this that holds up, because it keeps the transaction to reference moves.

The test I apply: if a reader observing one table updated and another not yet updated produces a wrong answer, a compliance violation, or an action that cannot be undone, the tables belong in a transaction. If the reader produces a slightly stale answer that corrects itself on the next run, they do not.

## Migrating an Existing Multi-Table Pipeline

Most teams that adopt the endpoint start from a pipeline that already commits tables one at a time. The migration has a natural order.

Start by listing the table groups that must move together. Use the test above, and expect the list to be short. In most lakehouses it is a handful of groups: erasure and retention workflows, financial ledgers with paired entries, and slowly changing dimensions with their bridge tables.

Next, confirm catalog support. Call the config route, confirm the endpoint and, ideally, the idempotency key lifetime. If the catalog lacks support, upgrading the catalog is the first task, and nothing else in this list matters until it is done.

Then move the heavy writes for each group onto staging branches. This step changes no consumer behavior, since consumers read `main`, and it can roll out one pipeline at a time. Enable `write.wap.enabled` on the tables, add branch creation with a retention limit, and point the engine's writes at the branch.

Add the audit gate between staging and publish. Even a trivial gate, such as checking that row counts on the branch moved in the expected direction, catches a surprising number of bad runs before they reach consumers.

Replace the per-table publish with the single transaction. This is the only step that needs JVM code, and it is short, as the worked example shows.

Finally, add the observability from the previous section and the reload-and-inspect handling for unknown outcomes. Run the new path in parallel with the old one on a test catalog for a few cycles, with a second writer injecting conflicts, before switching production over.

## Where This Is Heading

Three directions are worth watching.

The first is engine support. The endpoint has existed in the specification and the Java client for some time, but engines still commit one table at a time. Multi-statement transactions in SQL engines, where a `BEGIN` and `COMMIT` wrap writes to several Iceberg tables, are the natural consumer of this endpoint. When an engine ships that feature against REST catalogs, the endpoint stops being a Java-only tool.

The second is idempotency. Catalogs are adding idempotency key support to their mutation endpoints. As that spreads, retry logic for transactions gets simpler and safer, and the 5xx failure mode loses most of its sting.

The third is read consistency. Atomic writes across tables expose the gap on the read side. Expect more discussion of ways for a reader to ask the catalog for a consistent set of table states, whether through recorded commit IDs, catalog-level branches, or something new in the protocol.

## Conclusion

The `transactions/commit` endpoint does one thing well. It takes the requirement-and-update model that makes single-table Iceberg commits safe and applies it to several tables at once, with all-or-nothing semantics enforced by the catalog.

To use it well, check that your catalog advertises it, keep transactions to the tables that genuinely must move together, keep heavy writes out of the transaction by publishing from staging branches, handle 409s with a full reload, treat 5xx responses as unknown rather than failed, and remember that atomic writes do not give readers a consistent cross-table view on their own.

Start with one table group, ideally the one where a partial update carries legal or financial risk, and prove the pattern there before you spread it. None of that is complicated. It is just rarely written down in one place, which is why so many lakehouses still delete customers one table at a time.

## Keep Going

If this piece was useful, I have written a lot more on Iceberg catalogs and the REST protocol. *Apache Polaris: The Definitive Guide* (O'Reilly) covers how a production REST catalog handles commits, access control, and credential vending end to end. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
