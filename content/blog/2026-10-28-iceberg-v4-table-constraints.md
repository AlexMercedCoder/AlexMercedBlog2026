---
title: "Primary Keys Come to Apache Iceberg V4, and Most of Them Start Out Unenforced"
description: "Apache Iceberg V4 adds primary key, unique and check constraints, an enforced flag and per-snapshot status. What the spec says and how to prepare tables."
date: 2026-10-28T09:00:00Z
tags: ["apache-iceberg", "iceberg-v4", "data-quality", "table-constraints"]
canonical: "https://datalakehousehub.com/blog/iceberg-v4-table-constraints/"
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/iceberg-v4-table-constraints/).

Every team that moves a warehouse onto Apache Iceberg hits the same wall in week two. Someone runs the migration script, the row counts match, and then a dashboard shows the same customer twice. The old warehouse had a primary key on `customer_id`. The Iceberg table has a column called `customer_id` and nothing else. No declared key, no unique rule, no check that `amount` is positive. The rules lived in the warehouse engine, and the engine did not come along for the migration.

Iceberg has had a partial answer for years in the form of identifier fields. They tell engines like Apache Flink which columns identify a row for upserts. They never told anyone whether those columns were actually unique, and they said nothing about other rules a table is supposed to follow.

On October 27, 2026, the Iceberg community passed a vote to add table constraints to the V4 table spec. The change adds three constraint types (`check`, `unique` and `primary-key`), an `enforced` flag, and a per-snapshot record of whether each constraint holds. The vote passed with 8 +1 votes, 5 of them binding, and no -1 votes. A related vote the same day replaced a per-column statistics flag with a file-level `tight_stats` flag, which matters more to constraints than it first appears.

This article walks through what the constraint spec says, why most constraints will start life unenforced, how snapshot-level status works, what happens to identifier fields when you upgrade, and what you can do to prepare your tables today. A quick note on where I sit: I work at Dremio, which builds a query engine and catalog on Apache Iceberg and Apache Polaris. Everything here comes from the public spec and dev list, and it applies to every engine that reads Iceberg.

## Why Lakehouse Tables Never Had Constraints

A relational database owns its storage. Every insert goes through one process that holds the index, the lock manager and the constraint checker. When you declare `PRIMARY KEY (order_id)`, the database checks a B-tree index on every write and rejects a duplicate before it lands. The cost of that check is small because the index is right there and nobody else writes to the files.

An Iceberg table has no single owner. Spark writes to it from a batch job. Flink writes to it from a stream. A Python job using PyIceberg appends a few thousand rows at night. Each writer produces its own Parquet files and commits a new snapshot through the catalog. The only coordination point is the atomic swap of the table's metadata pointer. Nothing in that design looks at the rows.

Checking a primary key across that setup is expensive. To prove a new batch of 10 million rows has no duplicate keys, a writer has to compare those keys against every live row in the table. On a table with 5 billion rows, that is a join against the whole table on every commit. Some writers can afford that. A Flink job committing every 60 seconds cannot.

So the lakehouse world settled on informational constraints. Engines such as Spark have long accepted `PRIMARY KEY ... NOT ENFORCED` style declarations that the optimizer reads and the writer ignores. Iceberg's own identifier fields followed the same pattern. They describe intent. They do not prove anything.

The problem is that informational constraints and real constraints look the same to a reader. A query planner that sees `PRIMARY KEY (order_id)` will happily remove a `DISTINCT` or turn an outer join into an inner join. If the key is not actually unique, those rewrites return wrong answers. The planner has no way to know whether the declaration is a fact or a wish.

That gap is what the V4 spec closes. It does not force every writer to run expensive checks. It gives every table a shared place to declare rules, a flag that says whether writers must honor them, and a per-snapshot verdict that tells readers what is actually known about the data.

## What the Spec Adds: Three Constraint Types

The new spec section defines a constraint as a condition that a table's live rows are expected to satisfy. The definition lives in table metadata. It sits apart from the schema and refers to columns by field ID, so renaming a column does not break the constraint.

There are three types.

**`check`** says every row must satisfy a predicate. A check constraint holds an `expression` written in the Iceberg expressions format, the same JSON format the REST catalog uses for scan filters. A rule like "amount is greater than zero" becomes a serialized predicate that references the `amount` field by its ID.

**`unique`** says the values of a set of fields must be distinct across rows. It follows the SQL standard on nulls. A row where any field in the set is null is not compared, so the table can hold many rows with a null in the key. That matches what most databases do with a `UNIQUE` index on a nullable column.

**`primary-key`** says the values of a set of fields must be distinct across all rows and must never be null. A table gets at most one primary key.

Every constraint carries the same core fields:

| Field | Type | What it does |
|---|---|---|
| `constraint-id` | int | Stable ID, unique within the table |
| `type` | string | `check`, `unique` or `primary-key` |
| `name` | string | Human label, unique within the table, never used as an identifier in metadata |
| `enforced` | boolean | Whether writers must keep added or modified rows in line with the rule |
| `timestamp-ms` | long | When the constraint was created or last modified, informational only |
| `expression` | expression | The predicate, required for `check` and forbidden for other types |
| `field-ids` | list of int | The key fields, required for `unique` and `primary-key` and forbidden for `check` |

The table also tracks a `last-constraint-id`, the same pattern Iceberg uses for `last-column-id` and `last-partition-id`. A new constraint always gets an ID above the current maximum. That keeps IDs from being reused, which matters because snapshots refer to constraints by ID.

The spec puts firm limits on what a key can contain. The fields of a `unique` or `primary-key` constraint must be primitive. They cannot live inside a list or a map. They cannot be `float` or `double`, because floating-point equality is a mess of rounding and NaN rules. They cannot be `geometry` or `geography`, because Iceberg does not define equality for those types. They cannot be the `unknown` type, whose values are always null, or the new V4 `file` type and its sub-fields.

Primary key fields have one more rule. They must be `required` in the schema and cannot sit inside an optional struct. That rule does real work. Even when nobody enforces the primary key, the schema itself already rejects null keys. Half of the primary-key promise (no nulls) gets enforced by every writer for free, because every writer already validates nullability.

Check constraints have their own rules. The expression has to be a predicate, not a value expression. It can only reference fields in the same row, by ID. It has to be pure, meaning the result depends only on the referenced values and evaluating it has no side effects. If the predicate calls a user-defined function from Iceberg's UDF spec, that function must be declared deterministic. A check like "`created_at` is earlier than now" is out, because "now" changes.

Notice what is missing. There are no foreign keys. Referential integrity across tables needs cross-table reads at write time and a shared view of two tables' snapshots. That problem is a lot harder than per-table uniqueness, and the spec leaves it alone.

## Enforced Is a Promise About Writes, Not About History

The `enforced` flag is the part of the spec that most people will misread, so it is worth slowing down.

When a constraint is enforced, writers must make sure the rows they write conform to it. A write that violates an enforced constraint must fail. When a constraint is not enforced, writers have no such duty.

That sounds like the usual SQL meaning. The difference is in what enforcement covers. An enforced constraint obliges a writer not to add or modify rows in a way that breaks the rule. It does not oblige the writer to repair rows that already break it. The spec says this plainly: a constraint can be enforced while the table already contains violations, and writers can still commit to that table.

Think about what that allows. You have a 3-billion-row `orders` table that came from a warehouse migration. You suspect it has a few thousand duplicate order IDs from an old bug. In a relational database, you cannot add a primary key until you clean every duplicate, because `ALTER TABLE ADD PRIMARY KEY` validates the whole table first. In Iceberg V4, you can declare the primary key, mark it enforced, and start protecting new writes today. The old duplicates stay visible and known. You clean them on your own schedule.

That ordering matches how lakehouse teams actually work. Stopping the bleeding matters more than proving the patient was always healthy.

It also means you cannot read `enforced: true` as "this key is unique." Enforcement tells you about the rules writers follow from now on. It says nothing about rows written before the constraint existed, or rows written by an engine that did not understand constraints at all. To know whether the rule holds for the data in front of you, you need the status the spec records on each snapshot.

Most constraints will start unenforced, at least for the first year or two of V4. The reason is engine support. An enforced primary key requires every engine that writes to the table to perform the uniqueness check, or to refuse to write. A table written by Spark, Flink and a Python job is only as safe as its least capable writer. Until all three implement V4 constraint enforcement, the honest setting is `enforced: false`, with status tracking doing the real work.

The upgrade path reinforces this. When a V3 table moves to V4, its identifier fields become a primary key that is explicitly not enforced. More on that below.

## Constraint Status: Every Snapshot Carries a Verdict

The most useful idea in the spec is that each snapshot records the status of every constraint that existed when the snapshot was created. The field is called `constraint-statuses`, and it holds four lists of constraint IDs, one per status.

| Status | Meaning |
|---|---|
| `validated` | Someone checked the constraint and it holds for every row in this snapshot |
| `valid` | The writer made sure its additions and changes do not break the rule, and the parent snapshot was `valid` or `validated` |
| `invalid` | At least one row in this snapshot is known to break the rule |
| `unvalidated` | Nobody knows whether the rule holds for every row |

Every constraint that exists when a snapshot is created must appear in exactly one list. Empty lists can be left out. A constraint missing from every list counts as `unvalidated`, which is the safe default for old writers that know nothing about constraints.

The difference between `validated` and `valid` is subtle and important. `validated` means a full check ran against this snapshot's rows. `valid` means the rule holds by induction. The parent was known good, and this commit's changes were checked against the rule. Both tell a reader the constraint holds. `validated` tells you it was confirmed directly. `valid` tells you it was carried forward.

Induction is what makes constraint tracking cheap enough for streaming. A Flink job that commits every minute cannot rescan the table each time. It can check the keys in its own batch against the keys it touches and record `valid`, as long as the parent was `valid` or `validated`. A nightly job can then run a full check and record `validated`, which resets the chain.

Some commits never need a check at all. A commit that does not add or modify rows cannot introduce a violation. A delete removes rows, and removing rows never creates a duplicate key or a failing check. A compaction rewrites files but keeps the same rows. For those operations, the spec lets the writer record `valid` for any constraint that was `valid` or `validated` in the parent, with no row checks.

Statuses are immutable. Once a snapshot exists, its `constraint-statuses` never change. If a validation job finishes and wants to mark a constraint `validated`, it commits a new snapshot. That snapshot changes no data, so it uses the `replace` operation, the same operation type compaction uses. Time travel stays honest. If you query the table as of last Tuesday, you see last Tuesday's verdict, not today's.

There is one more rule a reader has to respect. A snapshot can list a constraint ID that no longer appears in the table's `constraints` list, because someone dropped the constraint later. Readers must ignore those IDs. They must also never assume that every ID in a snapshot still has a definition.

Here is what this gives a query planner. Before it removes a `DISTINCT` on the primary key, it reads the current snapshot's statuses. If the key is `validated` or `valid`, the rewrite is safe. If it is `unvalidated` or `invalid`, the planner keeps the `DISTINCT`. The same metadata that tells a human "this key has known duplicates" tells the optimizer not to trust it.

## Commit Retries and Concurrent Writers

Iceberg uses optimistic concurrency. Two writers start from the same snapshot, both write their files, and both try to commit. One wins. The loser rebases its change onto the new current snapshot and tries again. For appends, that retry has always been simple, because appends never conflict.

Constraints change that. The spec now says appends have no retry requirements other than the constraint requirements. When a commit retries against a new parent, every enforced constraint must hold for the rows the commit adds or changes, checked against the snapshot that results from applying the commit to the new parent. That includes constraints the other writer just added or switched to enforced. The writer must also recompute `constraint-statuses` from the new parent rather than reuse what it computed the first time.

Here is why that matters. Writer A and writer B both insert a row with `order_id = 42`. Each checks its batch against the table as it stood when it started. Neither sees a duplicate. A commits first. If B simply retried its append, the table ends up with two rows keyed 42 and a status of `valid`, and that status is a lie. The retry rule forces B to recheck its rows against a table that now includes A's row. B finds the duplicate and fails.

For unenforced constraints, the retry still has to recompute statuses. B is allowed to commit the duplicate, but it cannot carry forward a `valid` status it no longer earned. It records `unvalidated` or `invalid`.

This is the hidden cost of enforced keys on busy tables. Every retry repeats the uniqueness check, so a table with many concurrent writers pays for the check once per attempt. That pushes teams toward a single writer per enforced table, or toward unenforced keys with a scheduled validation job.

## What Happens to Identifier Fields When You Upgrade to V4

Iceberg V2 introduced `identifier-field-ids` on the schema. They mark the columns that identify a row, and engines use them in a few places. Flink's upsert mode uses them as the key for equality deletes. Spark exposes them through a SQL extension:

```sql
-- Iceberg V2/V3, Spark SQL with the Iceberg extensions enabled
ALTER TABLE prod.sales.orders SET IDENTIFIER FIELDS order_id;

-- Composite identifiers work the same way
ALTER TABLE prod.sales.order_lines SET IDENTIFIER FIELDS order_id, line_number;

-- Remove them
ALTER TABLE prod.sales.orders DROP IDENTIFIER FIELDS order_id;
```

In V4, identifier field IDs go away. A V4 schema must not set them, and readers of a V4 table must ignore them if they show up. The `primary-key` constraint takes their place.

The upgrade is mechanical. When a table moves from V2 or V3 to V4, the current schema's identifier fields get rewritten as one `primary-key` constraint. That constraint is not enforced. It gets a `constraint-id` from `last-constraint-id` like any other constraint, and its `timestamp-ms` is the upgrade time. If any identifier field cannot legally sit in a primary key (a `geometry` column, for example), no constraint gets created and the upgrade continues without one.

The unenforced default is the right call. Identifier fields never promised uniqueness. Many V2 tables written by Flink in upsert mode do hold unique keys, because upsert writes a delete for the old row before inserting the new one. Plenty of other tables carry identifier fields that someone set for documentation and never maintained. Upgrading those to an enforced key makes every future write responsible for a promise the table never kept.

The upgrade also does not record a status for the new constraint in old snapshots, because old snapshots have no `constraint-statuses` field at all. Those snapshots treat the key as `unvalidated`, and the first V4 snapshot does the same unless the writer has grounds to say otherwise.

There is a second V4 change that touches the same tables. V4 forbids writing new equality deletes. Readers still apply equality deletes that were carried over from V2 or V3 tables, but no V4 writer can create new ones. Flink's upsert path has relied on equality deletes keyed by identifier fields. Once a table is on V4, writers have to express updates through deletion vectors and other position-based mechanisms, which means finding the old row's position before writing. That is more work at write time, and it is the same kind of key lookup an enforced primary key needs. Engines that build a fast key lookup for V4 upserts get most of what they need for enforcing primary keys too.

If you run Flink upsert jobs against V2 tables today, the V4 upgrade is a bigger event for you than for a batch-only shop. Plan the writer upgrade and the table upgrade together.

## The Rules That Keep Constraints Honest Through Schema Change

Iceberg's schema evolution is one of its best features. You can rename, add, drop and promote columns without rewriting data, because everything refers to columns by field ID. Constraints follow the same model, and the spec adds a few rules so evolution cannot quietly break them.

**Referenced fields must exist.** Every field a constraint references must exist in the current schema. A field is referenced if it appears in a check expression or in a key's `field-ids`. A schema change that drops a referenced field must be rejected, unless the same change also removes the constraint. You cannot strand a primary key on a column that no longer exists.

**Renames are free.** Constraints use field IDs, so `ALTER TABLE ... RENAME COLUMN cust_id TO customer_id` leaves the constraint untouched. Check expressions also use ID references for the same reason.

**Type promotion is allowed, with a condition.** A referenced field can be promoted using Iceberg's normal promotion rules, such as `int` to `long`. For `unique` and `primary-key` constraints, the promotion must preserve distinctness. Widening an integer keeps every distinct value distinct, so it passes. This was one of the last details settled during the vote, and it is worth checking against the final merged spec text when your engine ships support.

**Definitions are frozen.** Once a constraint exists, its `field-ids` must never change, and its expression must always produce the same validation result. To change what a constraint means, you drop it and add a new one with a new ID. This rule protects the status history. Editing a check expression in place makes every old snapshot that recorded `validated` for that ID claim something it never checked. A new ID makes the old verdicts point at the old rule.

**Names are labels.** A constraint name must be unique within the table, and engines use it in DDL and error messages. Metadata never uses the name to find a constraint. Renaming `pk_orders` to `orders_pk` is cosmetic.

**UDFs must stay stable.** If a check expression calls a deterministic UDF and someone redefines that UDF with different behavior, Iceberg does not detect it. Readers and writers are not required to notice the change or recompute statuses. Treat UDFs used in constraints the way you treat a public API. Version them, and never change their meaning under the same name.

## Tight Stats and Why Constraints Need Exact Metadata

The second vote that passed on October 27 looks unrelated. It replaced a per-column `tight_bounds` flag in V4's new content stats structure with a single file-level `tight_stats` flag. It passed with 9 binding +1 votes and no objections.

Iceberg tracks statistics for every data file: lower and upper bounds, value counts, null counts and NaN counts. Planners use them to skip files. For pruning, the bounds only need to be conservative. A lower bound smaller than the true minimum still lets the planner skip files safely.

Conservative is not always enough. Bounds drift loose over time. Strings get truncated when written. Deleting rows with a deletion vector leaves the file's original stats in place, so the bounds and counts now describe rows that are no longer live. A null count that includes deleted rows is not the null count of the table.

The new spec text defines stats as tight when the bounds and the value, null and NaN counts are exact for the live rows of a file. For fixed-length types, tight bounds equal the real minimum and maximum of live values. The counts are counts across live rows only. String and binary bounds are never tight, since they can be truncated. Geometry and geography bounds are never tight, because they describe a bounding box. When `tight_stats` is absent, readers must assume the stats are loose. Writers can recompute stats to restore tightness without rewriting the data file.

Moving the flag from each column to the whole file makes it simpler to produce and cheaper to store. A writer either computed exact stats for the file's live rows or it did not. Tracking that per column added bytes to every manifest entry for a distinction few writers made.

Here is where constraints come in. A constraint validator wants to answer as much as possible from metadata before reading any Parquet.

Take a check constraint `amount > 0`. If every file's lower bound on `amount` is above zero, the constraint holds, and loose bounds are good enough to prove that. Now flip it. If a file reports a lower bound of `-5`, loose stats tell you nothing. That value can belong to a deleted row. With tight stats, a lower bound of `-5` means a live row has `amount = -5`. The validator can mark the constraint `invalid` without opening the file.

Counts work the same way. A tight `null_value_count` of zero on every key column of a `unique` constraint tells the validator there are no null rows to skip during comparison. A tight `value_count` tells it exactly how many live keys each file holds, which is how you size the comparison job before you run it.

Uniqueness itself still needs real data. Two files whose key ranges do not overlap cannot share a key, and bounds help the validator skip those pairs. Two files whose ranges overlap need a real comparison. On a table sorted or clustered by the key, overlap is rare, and the validator touches a small fraction of the table. On a table with random key order, every file overlaps every other file and the check becomes a full scan.

A third V4 vote opened on October 27 and was still open at the time of writing. It proposes stats-only fields: a `stats-fields` list that assigns field IDs so stats can be kept for partition fields and for expressions such as a lowercased string. If it passes, it gives engines a way to keep metadata on derived values. It does not change what a constraint can reference today, which is plain field IDs for keys and row-level predicates for checks.

## Reading the Metadata: A Worked Example

Here is what constraint metadata looks like in a V4 table metadata file, following the serialization the spec defines. The table is `orders`, with `order_id` as field 1, `customer_id` as field 2, `amount` as field 3 and `promo_code` as field 4.

```json
{
  "format-version": 4,
  "last-constraint-id": 3,
  "constraints": [
    {
      "constraint-id": 1,
      "type": "primary-key",
      "name": "pk_orders",
      "enforced": false,
      "timestamp-ms": 1793145600000,
      "field-ids": [1]
    },
    {
      "constraint-id": 2,
      "type": "check",
      "name": "chk_amount_positive",
      "enforced": true,
      "timestamp-ms": 1793232000000,
      "expression": {
        "type": "gt",
        "term": { "type": "reference", "id": 3 },
        "value": 0
      }
    },
    {
      "constraint-id": 3,
      "type": "unique",
      "name": "uq_promo_code",
      "enforced": false,
      "timestamp-ms": 1793318400000,
      "field-ids": [4]
    }
  ],
  "snapshots": [
    {
      "snapshot-id": 7001,
      "summary": { "operation": "append" },
      "constraint-statuses": {
        "unvalidated": [1, 3],
        "valid": [2]
      }
    },
    {
      "snapshot-id": 7002,
      "parent-snapshot-id": 7001,
      "summary": { "operation": "replace" },
      "constraint-statuses": {
        "validated": [2, 3],
        "invalid": [1]
      }
    }
  ]
}
```

I trimmed fields that do not matter here, such as manifest locations and schema IDs. The JSON for the check expression follows the shape of Iceberg's expression serialization with an ID reference, but treat that block as illustrative until your engine writes one. The expression format is defined in a separate spec document, and small details such as how literals get encoded matter.

Read it from the top.

`last-constraint-id` is 3, so the next constraint added gets ID 4 or higher, even if constraint 3 gets dropped later.

Constraint 1 is the primary key. It came from an upgrade or a DDL statement, and it is not enforced. Writers can add duplicate `order_id` values without failing.

Constraint 2 is an enforced check. Any writer that tries to commit a row with `amount <= 0` must fail. The `term` points at field ID 3, not at the column name, so a rename leaves it intact.

Constraint 3 is an unenforced unique key on `promo_code`. Because it is `unique` and not `primary-key`, rows with a null promo code are not compared. A thousand orders with no promo code do not violate it.

Snapshot 7001 is an append. The writer checked its new rows against the enforced check constraint and the parent was in good standing, so constraint 2 is `valid`. The writer did nothing about the two unenforced constraints, so they stay `unvalidated`.

Snapshot 7002 is a `replace` with no data changes. A validation job ran full checks and committed the results. The check constraint and the promo code key both hold for every row, so they moved to `validated`. The primary key is `invalid`. At least one `order_id` appears twice.

That `invalid` status is information you have never had in an Iceberg table. The duplicates were probably there from the migration. Now the table says so, every engine can read it, and the optimizer knows not to trust the key.

Here is the kind of query a validation job runs to produce those verdicts, written in plain SQL that works in most engines:

```sql
-- Primary key: count duplicate and null keys in one pass
SELECT
  COUNT(*) FILTER (WHERE order_id IS NULL)            AS null_keys,
  COUNT(*) - COUNT(DISTINCT order_id)                 AS duplicate_rows
FROM prod.sales.orders;

-- Show the worst offenders so someone can clean them up
SELECT order_id, COUNT(*) AS copies
FROM prod.sales.orders
GROUP BY order_id
HAVING COUNT(*) > 1
ORDER BY copies DESC
LIMIT 100;

-- Unique key: nulls are excluded from the comparison, matching the spec
SELECT promo_code, COUNT(*) AS copies
FROM prod.sales.orders
WHERE promo_code IS NOT NULL
GROUP BY promo_code
HAVING COUNT(*) > 1;

-- Check constraint: any row that fails the predicate
SELECT COUNT(*) AS violations
FROM prod.sales.orders
WHERE NOT (amount > 0) OR amount IS NULL;
```

A few things to notice. The primary key query checks for nulls even though the schema should already reject them. That costs almost nothing and catches tables where someone loosened the column to optional. The `FILTER` clause is standard SQL, but a few engines spell it differently, so swap in `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` where needed. The unique key query filters nulls, because the spec says rows with a null in the key are not compared.

The check query needs a decision from you. In SQL, `amount > 0` evaluates to unknown when `amount` is null, and a SQL `CHECK` constraint passes rows where the predicate is unknown. Iceberg's expression semantics for null handling are defined in its expressions spec, and you should confirm how your engine treats a null against a check before you count nulls as violations. I included `amount IS NULL` above to show the stricter reading. If `amount` is required in the schema, the question goes away.

Until engines expose constraint DDL for V4 tables, these queries are also the best way to rehearse. Run them on your V3 tables today. The numbers tell you which declared keys are already true and which ones are aspirations.

## Failure Modes and Warning Signs

Constraints add a new kind of metadata that engines read and act on. That creates new ways to get burned. These are the ones I expect to show up first.

**Trusting `enforced` instead of status.** The most common mistake will be reading `enforced: true` as "the rule holds." It does not. It means future writes from compliant writers respect the rule. A table can be enforced and `invalid` at the same moment. Any tool, dashboard or optimizer rule that makes decisions about data quality has to read `constraint-statuses` from the snapshot it is querying. The warning sign is a report that lists constraints and their `enforced` flag with no status column.

**Old writers that ignore constraints.** A writer built for V3 cannot write to a V4 table at all, because format version gates writes. The real risk is a V4 writer that supports the new metadata layout but treats constraints as opaque. The spec handles the status side safely, since a constraint missing from a snapshot's lists counts as `unvalidated`. The enforcement side depends on that writer refusing to commit when an enforced constraint exists that it cannot check. Before you mark any constraint enforced, confirm how every engine that writes to the table behaves. Test it with a deliberately bad row in a branch.

**The validation bill on unsorted keys.** Proving uniqueness on a table with random key order means comparing every live key. On a 5-billion-row table with a 16-byte key, that is about 80 GB of keys to shuffle before overhead. If your validation job runs much longer each week, check whether files still cluster by the key. Compaction that sorts by the primary key keeps file key ranges narrow, and narrow ranges let a validator skip most file pairs.

**Retry storms on enforced keys.** Each commit retry repeats the uniqueness check for the rows being added, against the new parent. With five writers committing to one enforced table every minute, the losing writers redo work constantly. The warning sign is a rising commit retry count paired with longer commit latency. The fix is usually structural: route writes for an enforced table through one writer, or keep the key unenforced and validate on a schedule.

**Stale verdicts after compaction.** A compaction carries forward `valid` from a `valid` or `validated` parent, because it does not change rows. That is correct. It also means a chain of compactions and deletes can stretch far from the last real check. Nothing is wrong with that in principle, since each step is sound. In practice, bugs in writers do happen. A good habit is to record when each constraint was last `validated` and alert if it goes more than a week without a full check.

**UDF drift in check constraints.** If a check calls a UDF and someone changes the function body, every status recorded against that check becomes suspect. Iceberg does not detect it. The warning sign is a check that stays `validated` while downstream data quality tests start failing. Keep UDFs in constraints rare, versioned and owned.

**Silent upgrade surprises.** A V3 table with identifier fields becomes a V4 table with an unenforced primary key. Anyone who later flips that key to enforced without running a validation first gets an enforced, `invalid` key. Writes keep working, but the optimizer will refuse to use the key, and a few teams will spend an afternoon wondering why. Validate before you enforce, every time.

**Expecting foreign keys.** V4 constraints are single-table. A team that migrates a star schema and expects the fact table to reject orphan dimension keys will not get that from the spec. Keep your orphan-key tests in your data quality tooling.

## How to Prepare Your Tables Now

V4 engine support will roll out over the coming releases. You do not need to wait for it to get ready.

**Inventory your intended keys.** List every table where your team assumes uniqueness: business keys, natural keys and surrogate keys from the source system. For each one, write down which columns form the key and whether nulls are allowed. That list becomes your V4 `primary-key` and `unique` constraints.

**Run the validation queries on V3 today.** Use the queries in the worked example against each table on the list. Record the duplicate and null counts. Any table with a nonzero count will upgrade to an `invalid` key the first time anyone validates it. Better to know now.

**Set identifier fields where they are true.** If a table's key is already clean, set identifier fields on it with `ALTER TABLE ... SET IDENTIFIER FIELDS`. When the table upgrades to V4, that becomes the unenforced primary key automatically, and you skip a manual step.

**Make key columns required.** Primary key fields in V4 must be `required` and cannot sit in an optional struct. If your key columns are optional today, the upgrade cannot create a primary key from them. Fix nullability now, during a quiet week, rather than during the upgrade.

**Avoid float and geometry keys.** Keys on `double` columns are not allowed in V4 constraints. If a table uses a floating-point value as part of its natural key, plan a new key column, such as a decimal or a string.

**Sort or cluster by the key.** Tables that keep data clustered by the primary key are far cheaper to validate. If you already compact these tables, add the key to the sort order.

**Map your writers.** For each table, list every engine and job that writes to it. Enforced constraints are only as safe as the least capable writer. This list tells you which tables can move to enforced first. Single-writer tables are the obvious candidates.

**Write down your check rules.** Most teams have rules like "amount is positive" or "status is one of five values" buried in dbt tests or pipeline code. Pull the simple, row-level ones into a list. Those are your future `check` constraints. Leave anything that needs other rows or other tables in your test framework.

## Where This Is Heading

The constraint spec is one piece of a much larger V4 effort. In the same few weeks, the community voted on the File type, adaptive metadata changes, `tight_stats`, and REST spec updates, with stats-only fields still in a vote. Together these changes push Iceberg closer to a table format that engines can reason about without guessing.

Constraints fill a specific gap. Until now, every engine had its own way to declare keys and checks, stored in its own catalog or table properties, invisible to every other engine. A primary key declared in one engine's DDL meant nothing to the next engine that read the table. With V4, the declaration and the verdict live in the table itself, in a format every V4 reader understands. That is the same shift Iceberg made for schemas and partitions years ago, now applied to data rules.

The first benefit will come from the optimizer side. Engines can use `validated` and `valid` keys to drop redundant `DISTINCT` operations, simplify joins and pick better join strategies, because the status tells them when the key is safe to trust. That works even with unenforced constraints, as long as someone runs validation.

Enforcement will come more slowly. It needs every writer to implement key checks, and it needs fast key lookups to keep commit times reasonable. The V4 move away from equality deletes pushes engines to build those lookups anyway, so I expect enforced primary keys to arrive in the same releases that bring efficient V4 upserts.

Catalogs have a role too. A REST catalog sees every commit. It is a natural place to reject commits that leave enforced constraints in a bad state, or to report constraint health across a whole catalog. Projects like Apache Polaris already govern access at the catalog level, and constraint visibility fits the same layer.

Check the final merged text of PR #17822 in the Iceberg repository when you start building against it. Spec PRs pick up small edits after a vote passes, and the details of type promotion and null handling are exactly the kind of thing that gets tightened during the merge.

## Conclusion

Iceberg V4 constraints give tables a shared, engine-neutral place to declare primary keys, unique keys and check rules. The design is honest about the lakehouse. It does not pretend every writer can check every rule on every commit. It separates two questions that relational databases fold together. The `enforced` flag answers whether writers must respect the rule from now on. The per-snapshot status answers what is actually known about the data in front of you.

That split is what makes the feature usable on day one. You can declare a primary key on a table with known duplicates, leave it unenforced, record `invalid`, and fix the data on your own schedule. You can enforce a check on a single-writer table and leave keys on busy streaming tables unenforced with nightly validation. Upgraded tables keep their identifier fields as unenforced keys, which is exactly the promise those fields made all along.

Start with the inventory. List your keys, run the validation queries, fix nullability, and sort your large tables by key. When your engines ship V4 constraint support, the hard part will already be done.

## Keep Going

If this piece was useful, I have written a lot more on Apache Iceberg's design and how to run it in production. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers the table format, metadata structure and engine integrations in depth, and *Architecting an Apache Iceberg Lakehouse* (Manning) covers how to design the platform around it. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
