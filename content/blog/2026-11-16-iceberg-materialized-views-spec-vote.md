---
title: "Iceberg Materialized Views Go to a Vote: Storage Tables, Refresh State and the Freshness Contract"
description: "Iceberg materialized views as a view plus a storage table: refresh state in snapshot summaries, the freshness rule, and what the November 2026 vote decides."
date: 2026-11-16T09:00:00Z
tags: ["Apache Iceberg", "Materialized Views", "Specification", "Catalog", "Query Engines"]
canonical: https://iceberglakehouse.com/posts/iceberg-materialized-views-spec-vote/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/iceberg-materialized-views-spec-vote/).

An Iceberg materialized view is a regular Iceberg view whose version points to a storage table holding precomputed results. Refresh state lives in the storage table's snapshot summary and records the source snapshot and version IDs. Readers that don't understand materialized views ignore the pointer and run the query, and stale storage tables must never be read.

That is the design the Apache Iceberg community is voting on now. On November 16, 2026, Jan Kaul opened "[VOTE] Add Materialized Views to the Iceberg View Spec" on the dev list ([vote thread](https://lists.apache.org/thread/wq9gpwbloy3socj64vr4f1f5gk8tzwkb)). The vote follows a call for broader review on November 10 ([review thread](https://lists.apache.org/thread/zpl1pk6v7k49s30gmm3kr986bc9y7jyv)) and a long review on [pull request #11041](https://github.com/apache/iceberg/pull/11041).

This article walks through the proposed spec text. It covers how the view points at its storage table, what the refresh state records, and the rule that decides when a reader can use precomputed data. If you need the basics of Iceberg views first, start with the [Apache Iceberg Views](https://iceberglakehouse.com/iceberg/iceberg-views/) entry in the knowledge base. A disclosure before going further: I work at Dremio, which ships its own query acceleration feature. This article covers only the open Iceberg spec.

## Why materialized views needed a spec

A materialized view stores the result of a query so later reads skip the expensive work. Every warehouse and query engine has some version of this. The problem in an open lakehouse is that the stored result has to be trusted by engines that did not create it.

Before this proposal, an engine that wanted materialized views on Iceberg had two options. The first was to store the precomputed table in its own private format and metadata, which locked the view to that engine. The second was to write a normal Iceberg table and track the relationship to the source tables in engine-specific properties. Other engines saw a regular table with no idea where its data came from or whether it was current.

Both options break the main promise of Iceberg, which is that any compliant engine can read any table and get the correct answer. A precomputed table with no shared freshness rules is a cache that only one engine understands. Another engine reading it has no way to know whether the source data changed since the last refresh.

So the spec has to answer three questions in a way every engine can follow:

1. Where does the precomputed data live, and how does the view point at it?
2. What did the last refresh read, so a consumer can tell whether the sources changed?
3. What must a consumer do when the precomputed data is out of date?

The draft answers each one with existing Iceberg building blocks instead of a new kind of catalog object.

## The design choice: a view plus a table

The community decided early that a materialized view is two existing Iceberg objects working together, not a new combined object in the catalog. Jan Kaul's vote email restates this background. The design follows the earlier decision to model a materialized view as a separate Iceberg view and Iceberg table rather than a new catalog object.

That choice has practical consequences.

**Catalogs need no new object type.** An Iceberg REST catalog already stores views and tables. A materialized view is a view whose current version carries a reference to a table. Catalogs that store views and tables today can store materialized views without a new endpoint family.

**The storage table is a normal table.** It has snapshots, manifests, and data files like any other Iceberg table. Compaction, snapshot expiration, and every other maintenance operation work on it unchanged. Engines that read it as a plain table get valid data, with one caveat covered below.

**The view stays the source of truth for the query.** The view's SQL text and dialect describe what the materialized view means. The storage table is only a precomputed copy of that query's result at a point in time.

The alternative, a new combined catalog object, gives tighter guarantees around atomic updates of definition and data. It also requires every catalog to implement a new object type and every engine to understand it before materialized views work anywhere. The view-plus-table design trades some atomicity for the ability to ship on today's catalogs.

## The storage table pointer

The first piece of the spec lives in the view metadata. Iceberg view metadata holds a list of versions. Each version records the SQL representations of the view, the schema, the default catalog and namespace, and a summary. The view's `current-version-id` says which version is active.

The draft adds an optional field to the view version that identifies a storage table. In the PR, this field is named `storage-table`, and it holds an identifier for the table that stores the precomputed results. Reviewers debated whether the field belongs in the immutable version struct. Putting it in the version means a change to the storage table location creates a new view version, which keeps history consistent.

An illustrative fragment of a view version under the draft looks like this. Field names follow the PR as reviewed and are subject to the final merged text:

```json
{
  "version-id": 3,
  "timestamp-ms": 1794000000000,
  "schema-id": 1,
  "summary": { "engine-name": "spark" },
  "representations": [
    {
      "type": "sql",
      "sql": "SELECT region, sum(amount) AS total FROM sales.orders GROUP BY region",
      "dialect": "spark"
    }
  ],
  "default-namespace": ["sales"],
  "storage-table": {
    "namespace": ["sales"],
    "name": "orders_by_region__mv"
  }
}
```

The `representations` list holds the query, as it does for any Iceberg view. The `storage-table` object names the table that holds the precomputed output. The exact shape of the identifier, including how catalog and namespace are expressed, is one of the details the final merged text settles.

**Backward compatibility rests on this field being optional.** A reader built before materialized views existed sees a view version with an extra field it does not recognize. Iceberg readers ignore unknown fields in metadata. That reader evaluates the view query against the source tables, exactly as it does for any other view. It never touches the storage table, so it can never read stale precomputed data. The vote email states this directly: readers that do not understand materialized views ignore the pointer and evaluate the view query directly, so existing view consumers keep working unchanged.

## Refresh state: what the last refresh read

The second piece of the spec lives in the storage table. Each time an engine refreshes a materialized view, it writes new data to the storage table and commits a snapshot. The draft records the refresh state in that snapshot's summary.

The vote email lists what the refresh state captures:

- **The view version that was materialized.** If someone changes the view's SQL, the view gets a new version ID. Precomputed data built from an older version no longer matches the definition.
- **The refresh start timestamp.** This is when the refresh began reading its sources.
- **The state of each source at refresh time.** For source tables, that means snapshot IDs. For source views, it means version IDs.

In the PR's proposed appendix, the example JSON uses `view-version-id`, `refresh-start-timestamp-ms`, and `source-states`. A reviewer also referred to `source-table-states`, so treat the exact names as settled only when the PR merges. An illustrative refresh-state record looks like this:

```json
{
  "view-version-id": 3,
  "refresh-start-timestamp-ms": 1794000123456,
  "source-states": [
    {
      "type": "table",
      "namespace": ["sales"],
      "name": "orders",
      "snapshot-id": 8812736451209381000
    }
  ]
}
```

The value of this design is that the refresh state travels with the data. The record sits inside the storage table's own snapshot. When the storage table's current snapshot changes, the refresh state changes with it in the same atomic commit. There is no separate bookkeeping table to fall out of sync, and the full history of refreshes lives in the snapshot log.

Why the start time and not the end time? A refresh reads its sources at specific snapshots. Those snapshots are fixed when the refresh begins, regardless of how long the job runs. Recording the start time ties the precomputed data to the moment its inputs were chosen.

## The freshness decision

The third piece is the rule every consumer must follow. This is the part that makes materialized views safe in a multi-engine lakehouse.

A consumer that understands materialized views reads the view, follows the pointer to the storage table, and reads the refresh state from the storage table's current snapshot. It then compares the recorded state to the current state of the world:

1. Does the recorded `view-version-id` match the view's current version? If not, the view's definition changed after the last refresh.
2. For each source table in the refresh state, is the recorded snapshot ID still the table's current snapshot?
3. For each source view, is the recorded version ID still the view's current version?

If everything matches, the storage table is fresh. The consumer reads it instead of running the query.

If anything differs, the storage table is stale. The vote email spells out the consumer's choices. A consumer facing a stale storage table can fail, refresh, or fall back to the view query. It must not read from the storage table.

That last clause is the core of the contract. The spec gives engines freedom in how they handle staleness and no freedom to serve stale data silently. An engine can return an error, trigger a refresh and wait, or run the original query against the sources. It cannot hand back old precomputed rows as if they were current.

Here is the freshness check written as plain Python against a hypothetical metadata API. The function names are illustrative, and the logic follows the draft:

```python
def storage_table_is_fresh(view, catalog):
    version = view.current_version()
    storage = catalog.load_table(version.storage_table)
    state = storage.current_snapshot().summary_refresh_state()

    # Rule 1: the definition must not have changed since the refresh.
    if state["view-version-id"] != version.version_id:
        return False

    # Rules 2 and 3: every recorded source must still be current.
    for src in state["source-states"]:
        if src["type"] == "table":
            current = catalog.load_table(src["identifier"]).current_snapshot_id()
            if current != src["snapshot-id"]:
                return False
        elif src["type"] == "view":
            current = catalog.load_view(src["identifier"]).current_version_id()
            if current != src["version-id"]:
                return False
    return True
```

The function loads the view's current version and follows its storage table pointer. It reads the refresh state from the storage table's current snapshot. It then returns false on the first mismatch. A caller that gets false must fail, refresh, or run the view query. It must not read the storage table.

## A refresh, step by step

The spec describes state, not procedure. It helps to walk through what a producer does during one refresh, because the order of steps decides whether the recorded state is honest.

1. **Load the view's current version.** The producer reads the view metadata, notes the `version-id`, and follows the `storage-table` pointer. If the pointer is missing, the producer creates the storage table first and writes a new view version that points to it.
2. **Pin the sources.** The producer resolves every source table to its current snapshot ID and every source view to its current version ID. It records the time this happens as the refresh start timestamp. From here on, the refresh reads only these pinned snapshots, even if new commits land on the sources.
3. **Run the query.** The producer evaluates the view's SQL against the pinned sources. Pinning matters here. A query that reads a source at whatever snapshot is current when each scan starts produces results that match no single point in time.
4. **Write the results.** The producer writes data files for the new result. For a full refresh, it replaces the storage table's contents. For an incremental refresh, it writes only the changes.
5. **Commit with the refresh state.** The producer commits a snapshot to the storage table and puts the refresh state in that snapshot's summary. The commit is atomic, so the data and the record of what produced it become visible together.

Step 2 is the one engines get wrong most easily. If a producer records snapshot IDs after the query runs instead of before, and a source changed in between, the recorded state claims a version of the source the query never read. A consumer then trusts data that does not match its recorded inputs. Pin first, read the pinned snapshots, record the pinned IDs.

Step 5 depends on Iceberg's commit protocol. If another writer commits to the storage table between steps 1 and 5, the producer's commit fails its optimistic check and retries. On retry, the producer has to decide whether its results are still valid. A refresh that started from older pinned sources than the competing commit should not overwrite newer results. Engines handle this policy themselves, and it is worth asking any vendor how theirs does.

## Incremental refresh and what the refresh state enables

A full refresh recomputes the whole query. That is simple and correct, and it is expensive for large views. The refresh state makes a cheaper path possible.

Because the refresh state records the exact source snapshots the last refresh read, the next refresh knows its starting point. Iceberg tables expose the changes between two snapshots. A producer can read only the rows appended to `sales.orders` between the recorded snapshot and the current one, aggregate them, and merge the result into the storage table.

This works cleanly for append-only sources and for aggregates that combine, such as sums and counts. It gets harder in three cases:

- **Sources with deletes.** Deleted rows must be subtracted from the materialized result. That requires the producer to read delete files or deletion vectors between snapshots, not just appended data files.
- **Aggregates that do not combine.** A median or a distinct count cannot be updated from a delta without extra state.
- **Expired snapshots.** If the recorded source snapshot was expired, the producer cannot compute a delta from it and falls back to a full refresh.

The spec does not require incremental refresh. It records enough that engines can attempt it safely and detect when they cannot. The freshness rule stays the same either way, since a consumer checks only whether the recorded state matches the present.

## Staleness windows and why they are separate from freshness

Strict freshness is easy to reason about and expensive to maintain. Any write to any source table makes the materialized view stale. For a view over a table that ingests every minute, the storage table is almost never fresh.

The PR discussion addresses this with a staleness bound. The draft includes an optional view property, `max-staleness-ms`, described as the maximum interval during which changed source snapshots are still fresh enough to skip refreshing. Proposed wording in the review says that staleness bounds data age but does not establish freshness.

That distinction is subtle and important. A staleness window does not claim the data is current. It claims the data is no older than a stated limit. A dashboard that tolerates fifteen minutes of lag can read a storage table whose refresh started within the last fifteen minutes, even if a source table changed since.

Reviewers flagged that this section had to stay consistent with the freshness section, and the terminology went through several rounds. Expect the merged text to define the staleness window precisely in terms of `refresh-start-timestamp-ms`. Until then, treat any staleness behavior as engine policy layered on top of the strict freshness rule.

## Who decides what gets tracked

The draft gives the producer, meaning the engine that runs the refresh, some control over what lands in the refresh state. The vote summary says the refresh state captures "the state of the source tables and views the refresh chose to track." Policy examples in the PR show the producer's serving policy deciding what goes into `source-states`.

This matters for nested materialized views. If materialized view B reads from materialized view A, what should B record? It can record A's view version, A's storage table snapshot, or the base tables found by expanding A's definition all the way down. The PR discussion presents these as options, and nested views and diamond dependencies were raised as open questions.

Each choice has a different meaning:

| What B records about A | What a change triggers | Trade-off |
| --- | --- | --- |
| A's view version ID | B goes stale only when A's definition changes | Misses data changes in A's sources |
| A's storage table snapshot | B goes stale when A refreshes | Depends on A being refreshed on time |
| A's base table snapshots | B goes stale when any underlying data changes | Most accurate, most expensive to check |

The spec does not need to pick one answer for every engine. It needs every engine to record enough that a consumer can apply the freshness rule to whatever was recorded. A consumer checks the sources listed, nothing more and nothing less.

## Proofs of concept and what to test

The working group validated the spec with two proof-of-concept implementations, according to the November 10 review thread: one in Spark ([PR #9830](https://github.com/apache/iceberg/pull/9830)) and one in Trino ([PR #31027](https://github.com/trinodb/trino/pull/31027)). Two engines with different codebases implementing the same text is the right test of whether a spec is clear enough.

Once the vote closes and engines ship support, here is what I recommend testing in your own environment. These tests map to the rules above.

1. **Old reader safety.** Point a reader that does not support materialized views at the view. Confirm it runs the view query and returns correct results. It must never read the storage table.
2. **Definition change.** Replace the view's SQL. Confirm a materialized-view-aware reader treats the storage table as stale before the next refresh.
3. **Source change.** Append to a source table. Confirm the reader detects the new snapshot and either refreshes, falls back, or fails.
4. **Cross-engine refresh.** Refresh with one engine and read with another. Confirm the second engine reads the refresh state and agrees on freshness.
5. **Maintenance.** Expire old snapshots on the storage table and on the sources. Confirm freshness checks still work, since they compare against current snapshots, not old ones.

Test 5 deserves a note. Snapshot expiration on a source table can remove the snapshot recorded in the refresh state. That does not break the freshness check, because the check compares the recorded ID to the current one, and a removed snapshot is by definition not current. It does mean an engine cannot use the recorded snapshot for an incremental refresh after expiration. Time travel behavior on the sources is covered in [Apache Iceberg Snapshots and Time Travel](https://iceberglakehouse.com/apache-iceberg-snapshots-and-time-travel/).

## Failure modes and warning signs

The spec closes the biggest risk, serving stale data silently, for any engine that follows it. Several failure modes remain, and they show up in operations.

**Refresh lag turns every read into a fallback.** If a view's sources change faster than it refreshes, freshness checks fail constantly, and every query runs against the sources. The materialized view adds cost and saves nothing. The warning sign is a high fallback rate in engine logs. The fix is a staleness window, a faster refresh schedule, or a different design.

**An engine reads the storage table directly by name.** The storage table is a normal Iceberg table, and nothing stops a user from querying it by name. That query bypasses the freshness rule. Treat storage tables as internal, restrict access through catalog grants, and use naming conventions that signal they are not for direct use.

**Partial refresh state.** An engine that tracks only some sources produces a freshness check that passes when untracked sources changed. The spec allows producers to choose what they track, so consumers need to know the producer's policy. Document it per view.

**Definition drift across dialects.** Iceberg views can hold SQL in several dialects. If two engines interpret the same view differently, their refreshes produce different storage table contents. This is not new to materialized views, but precomputation makes it persistent. Keep one dialect authoritative for views that are materialized.

**Concurrent refreshes.** Two engines refreshing the same view at the same time both write snapshots to the storage table. Iceberg's optimistic concurrency resolves the commit, and the later commit wins. The refresh state in the winning snapshot describes what that refresh read, so freshness checks stay correct. The cost is wasted compute.

## Governing the storage table

A materialized view has two objects, so it has two sets of permissions. Plan both before anyone queries the view.

The view carries the user-facing permission. Grant `SELECT` on the view to the people and agents who need the result. In a catalog with role-based access control, such as Apache Polaris, that grant lives on the view object like any other view grant.

The storage table carries the refresh permission. Only the refresh job needs to write to it. Grant write access to the service principal that runs refreshes and to no one else. Read access is the subtle part. An engine that serves the view from the storage table has to read it on the user's behalf. Some engines do this with the engine's own credentials after checking the user's view grant. Others need the user to hold read access on the storage table too. Check which model your engine uses, because the second model exposes the storage table to direct queries that bypass the freshness rule.

Row and column policies add one more wrinkle. If a source table has a row filter or a column mask, the precomputed result was built from whatever the refresh principal was allowed to see. A user with narrower access reading that result sees rows the policy hides from them in the source table. Until engines handle this explicitly, do not materialize views over sources with row-level or column-level policies unless the view's own access matches the narrowest policy.

## What the vote means for engines and catalogs

If the vote passes, the spec section lands in `format/view-spec.md`. That makes it a stable target, and engines can implement against it without chasing a moving draft.

For catalogs, the work is small. Catalogs already store views and tables. They need to round-trip the new optional field in view versions without dropping it. A catalog that strips unknown fields from view metadata breaks materialized views for every engine that uses it. Check your catalog's behavior on this before relying on cross-engine materialized views.

For engines, the work is larger. An engine that wants to create materialized views must write the storage table pointer, run refreshes, and record refresh state. An engine that wants to read them efficiently must implement the freshness check and choose a staleness policy. An engine that does nothing still works, because old readers run the query.

That last property is what makes this spec easy to adopt. Support grows engine by engine, and no engine has to coordinate a release with any other. The freshness contract gives users the same guarantee from every engine that implements it: precomputed data is either current by the recorded sources or not used at all. That idea connects to a broader practice of treating freshness as an explicit promise, covered in [Freshness Is a Contract, Not a Note on a Dashboard](https://iceberglakehouse.com/posts/freshness-as-a-contract/).

## Conclusion

The Iceberg materialized view spec builds on what already exists. A view gains an optional pointer to a storage table. The storage table records what each refresh read in its snapshot summary. Consumers compare that record to the current state of the sources and either use the precomputed data or fall back, with no option to serve stale rows silently. Readers that know nothing about materialized views keep running the view query and keep getting correct answers.

The vote opened November 16, 2026. Field names in this article follow the PR as reviewed, so check the merged text before you write code against them. The design itself is stable enough to plan around now: test old-reader safety, cross-engine freshness, and source changes as soon as your engines ship support.

## Keep Going

If this piece was useful, I have written a lot more on Iceberg views, catalogs, and table metadata. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers view and table metadata structure, snapshots, and the catalog's role in multi-engine access. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
