---
title: "Per-Developer Sandboxes on Apache Iceberg Branches: Lifecycle, Isolation Limits, and Cleanup"
description: "Give every developer and pull request a zero-copy Iceberg sandbox on branches: lifecycle, what branches do not isolate, and cleanup."
date: 2026-10-27T09:00:00Z
tags: ["Apache Iceberg", "branches", "data engineering", "CI/CD", "sandboxes"]
canonical: https://iceberglakehouse.com/posts/iceberg-branch-dev-sandboxes/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/iceberg-branch-dev-sandboxes/).

# Per-Developer Sandboxes on Apache Iceberg Branches: Lifecycle, Isolation Limits, and Cleanup

A data engineer opens a pull request that changes the logic in an orders model. That model feeds eleven downstream tables. To test the change properly, she needs to run the whole chain against realistic data and compare the output to production. She has three options, and all of them are bad.

She can run against production, which nobody allows. She can run against a staging environment, which is a copy of production refreshed weekly at a cost the platform team complains about every quarter, and which is already six days stale. Or she can run against a sample, which finishes fast and proves almost nothing, since the bugs that matter show up in the long tail of real data.

Apache Iceberg's branches offer a fourth option. A branch is a named pointer to a snapshot. Creating one copies no data. Writing to one adds only the files the write produces. Dropping one leaves production untouched. That makes it possible to give every developer, and every pull request, its own sandbox over full production data, at a storage cost proportional to what the test changes.

This article covers how to build that. The audit-and-publish side of branching, where a pipeline writes to a branch and fast-forwards `main` after checks pass, is covered in [Write-Audit-Publish with Apache Iceberg Branches](https://iceberglakehouse.com/posts/write-audit-publish-iceberg-branches/). This piece is about a different job: disposable environments for development and testing. It covers how branches make sandboxes cheap, what they do not isolate, how to coordinate sandboxes across many tables, how to automate the lifecycle per pull request, and how to keep abandoned branches from accumulating storage you pay for.

## What a Development Sandbox Actually Needs

Before looking at mechanics, it helps to be precise about requirements. A useful sandbox for data development has five properties.

**Write isolation.** Anything the developer writes lands in the sandbox and nowhere else. Production readers never see it.

**Realistic data.** The sandbox starts from production as it exists now, not from a weekly copy or a sample.

**Cheap creation.** Spinning up a sandbox takes seconds and costs nothing until the developer writes.

**Cheap disposal.** Tearing down a sandbox is one action, and its storage is reclaimed afterward without manual cleanup.

**No risk to production.** Creating, using, and dropping sandboxes cannot break production tables, slow production queries, or corrupt production maintenance.

Traditional approaches trade these off against each other. Full copies get realism but fail on cost and freshness. Samples get cost but fail on realism. Separate schemas with views over production get realism and cost for reads, but they fail on write isolation the moment a test needs to modify a table that other models read.

Iceberg branches satisfy the first four properties directly. The fifth depends on understanding what branches share with `main`, which is where most sandbox designs go wrong.

## How a Branch Makes a Sandbox Zero-Copy

An Iceberg table's metadata holds a list of snapshots and a set of references. A reference is either a branch or a tag. Every table has at least one branch, `main`. A tag points at one snapshot forever. A branch points at a snapshot and moves forward when someone commits to it.

Creating a branch adds one entry to the table's reference map. The new branch points at the same snapshot `main` points at. No data files are read, copied, or written. On a petabyte table, `CREATE BRANCH` finishes as fast as it does on an empty one, because the only thing it writes is a new metadata file.

Writing to the branch produces a new snapshot whose parent is the branch's previous head. That snapshot references new data files for whatever the write added, plus delete files or rewritten data files for whatever the write removed or changed. Everything the write did not touch stays referenced through the manifests the branch inherited from `main`. The cost of the sandbox is the bytes the test wrote.

Reading the branch resolves the branch's current snapshot and plans the scan from there. Engines that support branch reads see the sandbox's view of the table: production data, plus the developer's changes, minus anything the developer deleted.

Meanwhile, `main` keeps moving. Production pipelines commit to `main` as usual. The branch does not see those commits, because its history diverged at creation. That is the isolation property in both directions. The developer does not see production's new writes, and production does not see the developer's.

The divergence is also the main tradeoff, and it is worth planning around from the first day. A long-lived sandbox drifts away from production. A sandbox created at 9 a.m. holds 9 a.m. data at 5 p.m. For most testing that is fine, and far fresher than a weekly copy. For tests that depend on the newest data, recreate the branch rather than keeping it alive for days.

## What a Branch Does Not Isolate

Branches isolate snapshots. They do not isolate everything else in table metadata. The Iceberg documentation states this directly for schemas: the schema tracked for a table is valid across all branches, and writes to a branch are validated against the table's schema. The same table-level scope applies to several other parts of metadata.

**Schema.** If a developer runs `ALTER TABLE ... ADD COLUMN` while testing on a branch, the column is added to the table, not to the branch. Production writers see the new column on their next commit. A rename or a type promotion behaves the same way. Schema changes in a sandbox are production schema changes.

**Partition spec and sort order.** Both are table-level. Testing a new partition layout on a branch changes the default spec for everyone.

**Table properties.** Write settings such as file size targets, compression codecs, and format version live in table properties. Changing them on a branch changes them for the table.

**Access control.** Most REST catalogs, including Apache Polaris, authorize at the table level. The REST specification has no concept of per-branch permissions. A principal who can write to a branch can write to `main` on the same table.

**Maintenance.** Snapshot expiration and orphan file cleanup run per table, not per branch. A badly configured expiration job affects every branch. A compaction job on `main` does not rewrite the branch's files, which keeps the sandbox stable but means the branch keeps referencing the old, uncompacted files for as long as it lives.

The practical consequence is a rule for sandboxes: **branches are for data changes, not structural changes.** Testing new transformation logic, new filters, new aggregations, backfills, deletes, and merges all work cleanly on branches. Testing a schema migration or a partition change does not. Structural changes need a different environment, such as a scratch table created from a branch with `CREATE TABLE ... AS SELECT`, or a dedicated test catalog.

The access control point needs its own rule: **the sandbox runner, not the permission system, prevents writes to `main`.** Since the catalog cannot stop a developer's credentials from writing production on a table they can write a branch of, the tooling that runs sandbox jobs must guarantee every write goes to the branch. The lifecycle section shows how.

## Sandboxes That Span Many Tables

A real pull request rarely touches one table. The orders change from the opening affects twelve. Iceberg branches are per table, so a multi-table sandbox is a set of same-named branches across every table the job writes.

The convention is simple. Name the branch after the pull request, such as `pr_4812`. Create that branch on every table in the job's write set. Point every write at it. Read every table in the job's read set at that branch if it exists, and at `main` otherwise.

Getting the write set right is the core engineering problem. For a dbt project, the compiled manifest lists every model the selected run builds, so the write set comes from the manifest. For Spark jobs, it comes from the job's configuration or from a declared list in the repository. Whatever the source, compute it before the run, create branches for all of it, and fail the run if any write target lacks a branch.

The read set has a subtlety. A job that writes table B and reads table A sees production A, unless A is also on the branch. That is usually correct. If the pull request changes A and B together, both belong in the write set, both get branches, and B's job reads A's branch.

Same-named branches across tables are not atomic as a group. Each table's branch is created and written independently. For a sandbox, that is acceptable. Nobody outside the pull request reads the branches. If the job fails halfway, some branches hold partial results, and the next run drops and recreates them.

### Catalog-Level Branching as the Alternative

Some catalogs offer branches that span every table in the catalog at once. Project Nessie is the best-known open source example. A Nessie branch is a branch of the entire catalog, so `CREATE BRANCH` covers every table in one operation and a merge moves every table together.

That model fits sandboxes well. One branch per pull request covers every table automatically, so there is no write set to compute. Schema changes on a Nessie branch are scoped to the branch, since each branch tracks its own table metadata pointers.

The tradeoff is portability. Catalog-level branching is a feature of that catalog and its own API, not of the Iceberg table format or the Iceberg REST specification. Engines reach the branch through catalog-specific configuration, and the workflow does not move to a different REST catalog without rework. Table-level branches, by contrast, work in any catalog and any engine that supports Iceberg branch reads and writes.

For teams already running a catalog with catalog-level branches, use them. For teams on a REST catalog without that feature, table-level branches with a disciplined runner deliver most of the value.

## Automating the Lifecycle per Pull Request

The lifecycle has five stages: create, run, verify, compare, and drop. The script below implements them with PySpark against an Iceberg catalog named `lake`. It reads the write set from a file the build step produces.

```python
import sys
from pyspark.sql import SparkSession

PR = sys.argv[1]                       # e.g. "4812"
BRANCH = f"pr_{PR}"
WRITE_SET = [l.strip() for l in open("write_set.txt") if l.strip()]
RETAIN_DAYS = 3

spark = (SparkSession.builder
         .appName(f"sandbox-{BRANCH}")
         .getOrCreate())

def sql(q):
    return spark.sql(q)

# 1. Create: one branch per written table, forked from main, with a TTL
for t in WRITE_SET:
    sql(f"ALTER TABLE lake.{t} SET TBLPROPERTIES ('write.wap.enabled'='true')")
    sql(f"ALTER TABLE lake.{t} DROP BRANCH IF EXISTS {BRANCH}")
    sql(f"ALTER TABLE lake.{t} CREATE BRANCH {BRANCH} RETAIN {RETAIN_DAYS} DAYS")

# 2. Guard: refuse to run if any write target lacks the branch
for t in WRITE_SET:
    refs = {r.name for r in sql(f"SELECT name FROM lake.{t}.refs").collect()}
    if BRANCH not in refs:
        raise SystemExit(f"{t} has no branch {BRANCH}, refusing to run")

# 3. Run: route every write in this session to the sandbox branch
spark.conf.set("spark.wap.branch", BRANCH)
import pipeline                         # the job under test
pipeline.run(spark)
spark.conf.unset("spark.wap.branch")

# 4. Verify: confirm main did not move during the run
for t in WRITE_SET:
    last_main = sql(f"""
        SELECT committed_at FROM lake.{t}.snapshots s
        JOIN lake.{t}.refs r ON s.snapshot_id = r.snapshot_id
        WHERE r.name = 'main'""").collect()[0][0]
    print(f"{t}: main head committed at {last_main}")

# 5. Compare: row counts and a diff sample, branch vs main
for t in WRITE_SET:
    main_n = sql(f"SELECT count(*) FROM lake.{t}").collect()[0][0]
    br_n = sql(f"SELECT count(*) FROM lake.{t} VERSION AS OF '{BRANCH}'").collect()[0][0]
    print(f"{t}: main={main_n} branch={br_n} delta={br_n - main_n}")
```

Here is what each stage does.

The create stage enables write-audit-publish routing on each table, which Iceberg requires before the `spark.wap.branch` session setting takes effect. It drops any leftover branch with the same name from a previous run of the same pull request, then creates a fresh branch from the current `main` with a three-day retention. That retention is the safety net for abandoned sandboxes. Without it, a branch lives forever, since the default retention for Iceberg branches and tags is unlimited.

The guard stage reads each table's `refs` metadata table and confirms the branch exists. This is the check that replaces per-branch permissions. If the write set is wrong, or a branch creation silently failed, the run stops before a single write.

The run stage sets `spark.wap.branch` for the session, so every write to a WAP-enabled table goes to the sandbox branch. Recent Iceberg Spark integrations also resolve reads of those tables to the WAP branch, which is what a sandbox wants, since downstream models see upstream sandbox output. Confirm that read behavior on your Iceberg version before relying on it. Unsetting the conf afterward keeps later statements in the same session from writing to the branch by accident.

The verify stage reads the `main` head's commit time from the `snapshots` and `refs` metadata tables. This is a sanity check, not a guarantee. `main` moves legitimately when production pipelines commit during the sandbox run. What you look for is a `main` commit attributable to the sandbox job. Spark commits record the Spark application ID in the snapshot summary, so a `main` snapshot carrying the sandbox job's application ID is a leak.

The compare stage counts rows on `main` and on the branch for each table. A real runner goes further, with a sampled row diff on primary keys, aggregate comparisons on key measures, and a report posted back to the pull request.

The drop stage is missing on purpose. Drop branches when the pull request closes, not when the run finishes, so the developer can inspect the sandbox after the run. A webhook on pull request close runs `ALTER TABLE lake.<t> DROP BRANCH IF EXISTS pr_<n>` across the write set. The three-day retention catches anything the webhook misses.

## Comparing Branch Output Against Production

A sandbox earns its keep in the comparison step. Row counts catch gross errors. Key-level diffs catch the subtle ones. The cleanest comparison is against `main` as it stood when the branch was created, because that removes production's newer commits from the diff.

The branch's base snapshot is the point where it diverged from `main`. In a freshly created branch with only sandbox commits on it, that is the parent of the branch's first sandbox snapshot. The runner records it at creation time, which is simpler than recovering it later. Read it from the `refs` table right after `CREATE BRANCH` and store it with the run.

With the base snapshot ID in hand, a key-level diff looks like this:

```sql
WITH base AS (
  SELECT order_id, status, total_amount
  FROM lake.sales.orders VERSION AS OF 7781203394471120055
),
sandbox AS (
  SELECT order_id, status, total_amount
  FROM lake.sales.orders VERSION AS OF 'pr_4812'
)
SELECT
  coalesce(b.order_id, s.order_id) AS order_id,
  CASE
    WHEN b.order_id IS NULL THEN 'added'
    WHEN s.order_id IS NULL THEN 'removed'
    ELSE 'changed'
  END AS change_type,
  b.status AS old_status,       s.status AS new_status,
  b.total_amount AS old_amount, s.total_amount AS new_amount
FROM base b
FULL OUTER JOIN sandbox s ON b.order_id = s.order_id
WHERE b.order_id IS NULL
   OR s.order_id IS NULL
   OR b.status <> s.status
   OR b.total_amount <> s.total_amount
```

The `base` CTE time-travels to the snapshot the branch forked from, so it shows production exactly as the sandbox started. The `sandbox` CTE reads the branch head. The full outer join on the primary key pairs rows from both sides. The `WHERE` clause keeps only rows that were added, removed, or changed in the compared columns. Because both sides start from the same snapshot, every row in the result is caused by the pull request, not by production traffic during the run.

Two refinements make this practical at scale. First, aggregate before you list. Count rows by `change_type` and sum the amount deltas, then sample a few hundred changed rows for the report. A diff that returns four million rows tells a reviewer nothing. Second, compare null-safe. The `<>` operator treats a comparison with null as unknown, so a value that changed from null to something is missed. Use your engine's null-safe equality operator, such as `<=>` in Spark SQL, wrapped in `NOT`, for nullable columns.

The output goes into the pull request as a short table: rows added, removed, and changed per table, the net change in key measures, and a link to the full diff for anyone who wants to dig. Reviewers then approve a data change they have actually seen.

## A Worked Example: The Orders Change End to End

Here is the opening scenario carried through the full lifecycle.

The developer changes how the orders model treats partially refunded orders. The dbt project's compiled manifest shows that a run selecting the orders model and everything downstream builds twelve models. The build step writes those twelve table names to `write_set.txt`.

The pull request opens. A CI job calls the runner with the pull request number. The runner enables WAP on the twelve tables, creates `pr_4812` on each with three-day retention, records each table's base snapshot, and confirms every branch exists.

The runner sets `spark.wap.branch` and runs the twelve models in dependency order. The orders model writes a new snapshot to `pr_4812` on the orders table. The next model reads orders, which resolves to the `pr_4812` branch because the session branch is set, and writes its own sandbox snapshot. The chain continues through all twelve.

The runner checks that no `main` snapshot carries the job's application ID. It then runs the key-level diff on each table against its recorded base snapshot and aggregates the results.

The report posted to the pull request shows that 1,204 orders changed status from `refunded` to `partially_refunded`, that revenue in the downstream finance summary moved by the expected amount, and that two downstream tables changed in ways the developer did not expect. One of them is a regional rollup where a filter on `status = 'refunded'` silently dropped the new status value.

The developer fixes the rollup filter and pushes. CI reruns. The runner drops the old `pr_4812` branches, creates fresh ones from the current `main`, and runs again. This time the unexpected change is gone.

The pull request merges. The production pipeline picks up the new code on its next scheduled run and writes to `main` as usual. The close webhook drops `pr_4812` on all twelve tables. The next daily expiration removes the sandbox snapshots and deletes their files.

Total extra storage at the peak of the sandbox: the files the twelve models rewrote, which for this change was a few percent of the tables' size. Total extra storage a day after merge: zero.

## Personal Sandboxes Versus Pull Request Sandboxes

The lifecycle above is built for pull requests, where creation and teardown follow clear events. Developers also want a personal sandbox for exploratory work before a pull request exists. The two need different rules.

Personal sandboxes use the `dev_<user>` naming convention, live longer, and get recreated less often. A developer opens one in the morning, iterates on a transformation all day, and throws it away in the evening or keeps it for a few days. Seven-day retention fits that rhythm.

Personal sandboxes need a smaller write set, scoped to the tables the developer is changing, not the entire downstream graph. Running twelve models every time someone tweaks a filter is slow and expensive. Let the developer declare the tables, and keep the guard check identical.

Personal sandboxes also drift. A branch held for a week falls a week behind production. The runner offers a refresh command that drops and recreates the developer's branches from current `main`. Developers run it before any comparison they plan to trust.

The one rule that stays the same for both: every write goes through the runner. Personal sandboxes are where shortcuts happen, such as a developer setting `spark.wap.branch` by hand in a notebook and forgetting one table. The guard check exists for exactly that moment.

## What Sandboxes Cost in Practice

Branch-based sandboxes are cheap, but not free, and the cost has a predictable shape.

Creation costs one metadata file per table. At a few kilobytes to a few megabytes each, depending on table history, that is negligible.

Running costs the files each write produces. For appends, that is the new data. For deletes on merge-on-read tables, it is small delete files or deletion vectors. For updates and merges on copy-on-write tables, it is the rewritten data files, which for a change that touches rows spread across many files approaches the size of those files. A change that touches one percent of rows spread evenly across every file rewrites close to all of them under copy-on-write. The same change under merge-on-read writes a small amount of delete data plus the new row versions. Tables that host frequent sandbox runs benefit from merge-on-read write modes for exactly this reason.

Holding costs the sandbox's files for as long as the branch lives, plus the time until expiration runs after it is dropped. Short retention and daily expiration keep that window to a few days.

Compute costs the job runs themselves, which are the same as running the job against production. This is usually the larger cost, and it is a cost you were already paying for staging environments, typically against stale data.

As a rough illustration, consider a 20 TB set of tables that hosts thirty pull request sandboxes a week, where each sandbox writes on average 2 percent of the data it touches. Each sandbox adds about 400 GB at peak. With three-day retention and daily expiration, around fifteen sandboxes are live or awaiting expiration at any time, for about 6 TB of extra storage at steady state. A full weekly staging copy of the same tables costs 20 TB of storage plus the copy job, and serves data that averages three and a half days stale. Your numbers will differ. The shape of the comparison usually does not.

## Reading the Sandbox

Developers inspect sandboxes in notebooks and SQL clients, so read syntax matters as much as the runner.

In Spark SQL, a branch can be read two ways. `SELECT * FROM lake.sales.orders VERSION AS OF 'pr_4812'` uses time travel syntax with the branch name. `SELECT * FROM lake.sales.orders.branch_pr_4812` uses the branch as an identifier suffix. Both return the branch's current state using the table's current schema.

Writing directly to a branch without the session setting uses the same suffix: `INSERT INTO lake.sales.orders.branch_pr_4812 SELECT ...`. That form is explicit and safe for one-off fixes, since the target branch is visible in the statement.

Engine support varies. Spark and Flink support branch reads and writes through Iceberg's integrations. Other engines support reading branches with their own syntax, and support for writing to branches is less uniform. Before standardizing a team's sandbox workflow, check which engines your developers use and confirm each one can read the branch. A sandbox that only one engine can open is a sandbox half the team ignores.

Metadata tables are the developer's best inspection tool. `SELECT * FROM lake.sales.orders.refs` lists every branch and tag with its snapshot and retention settings. `SELECT * FROM lake.sales.orders.snapshots` shows every commit, including the sandbox's. Querying `history` shows the lineage. These make it easy to answer "what did my run actually write?" without guessing.

## Cleanup: Where Sandbox Storage Goes When You Are Done

Zero-copy creation is only half the cost story. The other half is what happens to the files a sandbox wrote after the sandbox is gone. This is where branch-based sandboxes quietly cost money if nobody plans for it.

When a sandbox writes, it adds data files, delete files, manifests, and a manifest list. Those files are referenced only by snapshots on the sandbox branch.

Dropping the branch removes the reference. The snapshots still exist in table metadata until snapshot expiration removes them. Iceberg's snapshot expiration removes snapshots that are no longer reachable from any retained reference and are past the configured age, and then deletes the files that only those snapshots referenced.

So the cleanup chain is: drop branch, then expire snapshots, then files are deleted. If expiration never runs, dropped sandboxes leave every file they wrote in storage. A team running fifty sandboxes a week that each rewrite a few hundred gigabytes accumulates tens of terabytes of dead files a month.

Branch retention shortcuts the first step. A branch created with `RETAIN 3 DAYS` has a maximum reference age. When snapshot expiration runs after that age, it removes the branch reference itself, then expires the unreachable snapshots and deletes their files in the same pass. The `main` branch is exempt from reference expiration.

A second retention control limits how many snapshots a branch keeps while it is alive. `WITH SNAPSHOT RETENTION 2 SNAPSHOTS` on branch creation tells expiration to keep only the two most recent snapshots on that branch. For sandboxes where the developer reruns the job many times, this keeps intermediate runs from piling up.

Orphan file cleanup handles the rest. A sandbox job that crashes mid-write leaves files that no snapshot ever referenced. Snapshot expiration never sees them. Running `remove_orphan_files` on a schedule, with an `older_than` threshold safely past your longest job, deletes them.

A complete maintenance schedule for tables with sandbox traffic looks like this:

```sql
-- daily: expire snapshots and expired refs, deleting unreferenced files
CALL lake.system.expire_snapshots(
  table => 'sales.orders',
  older_than => TIMESTAMP '2026-10-24 00:00:00',
  retain_last => 10
);

-- weekly: remove files no snapshot ever referenced
CALL lake.system.remove_orphan_files(
  table => 'sales.orders',
  older_than => TIMESTAMP '2026-10-20 00:00:00'
);
```

The `expire_snapshots` call removes snapshots older than the timestamp, while keeping at least the last ten snapshots on `main`, and deletes data and metadata files that no remaining snapshot references. Branch references past their maximum age are removed in the same call. The `remove_orphan_files` call lists files under the table location and deletes any that no metadata references and that are older than the threshold. The threshold protects files from jobs that are still writing. In a scheduler, compute both timestamps relative to the run date rather than hard-coding them.

## Sandboxes on Busy Tables

Most tables worth testing against are busy. Streaming writers append every minute, deletes arrive from retention jobs, and compaction rewrites files overnight. Branches handle all of that, with a few behaviors worth knowing.

**Streaming writers keep committing to `main`.** A Flink or Spark streaming job commits to `main` throughout the sandbox's life. Those commits never touch the branch, because each commit asserts its own branch head. The streaming job and the sandbox do not conflict. The branch simply stops seeing new streaming data after it forks.

**Deletes on `main` do not reach the branch.** If a retention job deletes old rows on `main` after the branch forks, the branch still holds them. For most testing that is harmless. For tables subject to erasure requests, it means a sandbox can briefly hold data production has already deleted. Short retention keeps that window to days, and dropping sandboxes promptly when a pull request closes shortens it further. Teams with strict erasure deadlines add a rule that any erasure job also drops open sandbox branches on the affected tables.

**Compaction on `main` leaves the branch on old files.** The branch keeps referencing the files it inherited, so compacted replacements on `main` do not help sandbox queries. The old files also cannot be deleted while the branch references them, which is one more reason to keep sandboxes short-lived.

**Merge-on-read deletes work the same on branches.** A sandbox `DELETE` or `MERGE` on a table configured for merge-on-read writes delete files or, on format version 3, deletion vectors to the branch. Readers of the branch apply them. Readers of `main` never see them.

## Rolling Out a Sandbox Program

Teams that succeed with branch sandboxes roll them out in a deliberate order.

Start with cleanup, not creation. Before the first sandbox exists, confirm snapshot expiration and orphan file removal run on a schedule for the target tables. Without them, the first month of sandboxes leaves a storage bill that kills the program.

Pick a small set of tables. The dozen tables most pull requests touch cover most of the value. Enable WAP on them and leave the rest alone.

Build the runner before inviting developers. The create, guard, run, compare, and report stages need to work end to end on one real pull request before anyone else uses them. Developers who hit a broken sandbox once tend not to come back.

Wire the report into code review. The data diff in the pull request is what changes behavior. Once reviewers see diffs, they start asking for them on every change.

Then expand the table set, add personal sandboxes, and tune retention based on how people actually work. Watch the sandbox storage chart through every expansion. If it trends upward week over week, something in cleanup is broken.

## Failure Modes

**Schema changes leak to production.** A developer runs a DDL statement while testing on a branch, and the schema changes for every writer. Production jobs that write with an explicit column list start failing or start writing nulls. Block DDL in the sandbox runner, and route structural changes to scratch tables or a test catalog.

**Writes escape to `main`.** A table was missing from the write set, so it had no branch and no WAP routing, and the job wrote to production. The guard stage exists for this. Generate the write set from the job definition, never by hand.

**Branch sprawl.** Branches created without retention live forever, and so do their files. After a year, the `refs` table lists hundreds of forgotten sandboxes. Always create sandbox branches with `RETAIN`, and alert when any table has more branches than you expect.

**Expiration that never runs.** Dropped branches leave their files until snapshot expiration removes the unreferenced snapshots. If expiration is missing or misconfigured, sandbox storage grows without bound. Monitor total table storage against `main`'s live data size. A widening gap means dead files.

**Stale sandboxes.** A branch held open for a week tests against week-old data, and its comparison against `main` shows production's newer rows as differences. Recreate branches on every run, and compare against `main` as of the branch's base snapshot when you want a clean diff.

**Maintenance conflicts.** A compaction job on `main` and a sandbox job run at the same time. They touch different branches and do not conflict with each other at the commit level, since each commit asserts its own branch. They do compete for compute and storage bandwidth. Schedule heavy sandbox runs away from maintenance windows.

**Confusing branch reads in engines without support.** A developer queries the table in an engine that ignores branch syntax or does not support it, sees production data, and concludes the sandbox run did nothing. Document which engines support branch reads, and make the runner print exact queries for inspection.

**Sensitive data in sandboxes.** A sandbox over full production data carries production's sensitivity. Developers who lack read access to a table in production gain nothing from a branch, since permissions are table-level, but developers who have access now write derived copies into branches that outlive their tickets. Short retention and automatic drop on pull request close keep that exposure bounded, and a periodic report of open branches per table gives the data governance team a view of it.

## Operational Guidance

**Standardize branch names.** Use `pr_<number>` for pull request sandboxes and `dev_<user>` for personal sandboxes. Predictable names make cleanup scripts and alerts simple.

**Cap retention.** Three days for pull request branches and seven for personal branches covers most work. Anything longer belongs in a different environment.

**Make the runner the only door.** Developers run sandbox jobs through the runner, not by setting session properties by hand. The runner computes the write set, creates branches, guards, runs, compares, and reports.

**Report in the pull request.** Post row count deltas, aggregate comparisons, and a sample of changed rows back to the pull request. Reviewers then review the data change alongside the code change.

**Track sandbox storage.** Sum file sizes referenced only by non-`main` branches using the `files` and `all_files` metadata tables. Chart it weekly. That number is the actual cost of the sandbox program, and it should stay flat.

**Run expiration daily on sandbox-heavy tables.** Weekly expiration is fine for quiet tables. Tables with daily sandbox traffic need daily expiration to keep dead files from piling up between runs.

**Separate structural testing.** Provide a scratch namespace or a test catalog for schema and partition changes. Make the boundary explicit in team documentation, so nobody discovers it in production.

**Record the base snapshot at creation.** Store each table's base snapshot ID with the run record when the branch is created. Clean diffs depend on it, and recovering it later from snapshot lineage is slower and easier to get wrong.

**Alert on branch counts.** A scheduled query over each table's `refs` metadata table that counts non-`main` branches catches sprawl early. Alert when a table exceeds the number of open pull requests plus a small margin.

**Prefer merge-on-read on sandbox-heavy tables.** Copy-on-write rewrites whole files for small changes, which multiplies sandbox storage. Merge-on-read writes small delete files instead. Weigh that against read performance on `main`, and compact `main` on its normal schedule.

**Keep sandboxes out of production dashboards.** Business intelligence tools should always read `main`. If a dashboard tool supports branch reads, restrict that capability to development workspaces so nobody publishes a chart built on someone's sandbox.

**Start with the hot tables.** Enable sandboxes first on the dozen tables that most pull requests touch. Expand once the runner and cleanup schedule have run cleanly for a few weeks.

## Where This Is Heading

Three developments are worth watching.

The first is engine support for branch writes. Spark and Flink lead today. As more engines support writing to branches with consistent syntax, sandboxes stop depending on a single engine for the run.

The second is branch-aware tooling in transformation frameworks. dbt and similar tools already understand environments and targets. Native support for mapping a development target onto Iceberg branches, with the write set computed from the project graph, removes most of the runner code shown above.

The third is the question of branch-scoped structure. Today's table-level schema is a deliberate design choice that keeps branches simple and merges predictable. Catalog-level branching already scopes structure per branch. Whether table-level branching ever gains a narrower form of structural isolation is an open question in the community, and teams should design sandboxes around today's behavior.

## Conclusion

Iceberg branches give data teams something software teams have had for decades: a private place to test changes against the real thing, created in seconds and thrown away without consequence. Creation is zero-copy, writes cost only what they change, and production never sees sandbox work.

The design work is in the edges. Branches isolate snapshots, not schemas, properties, or permissions, so keep structural changes out of sandboxes and let the runner, not the catalog, guarantee writes go to the branch. Branches spanning many tables need a computed write set and a guard. And sandboxes cost nothing only if retention and snapshot expiration actually run, so set `RETAIN` on every sandbox branch and schedule expiration on every table that hosts them.

None of this requires new infrastructure. It requires a short runner script, two scheduled maintenance procedures, and a team agreement about what belongs in a sandbox and what does not. Get those right, and every pull request can run against full production data, every reviewer can see the data diff, and the storage bill stays flat.

## Keep Going

If this piece was useful, I have written a lot more on Iceberg table management and developer workflows. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers branching, tagging, snapshot expiration, and the metadata tables used throughout this article. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
