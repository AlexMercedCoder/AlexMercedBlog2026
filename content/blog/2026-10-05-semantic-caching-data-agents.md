---
title: "Semantic Caching for Data Agents Without Serving Stale or Leaked Numbers"
description: "Cache data agent results safely with canonical query keys, Iceberg snapshot freshness checks, and permission-aware cache keys."
date: 2026-10-05T09:00:00Z
tags: ["caching", "AI agents", "Apache Iceberg", "semantic layer"]
canonical: https://iceberglakehouse.com/posts/semantic-caching-data-agents/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/semantic-caching-data-agents/).

A data agent gets the same question forty times before lunch. The finance team asks for net revenue by region this quarter. A regional manager asks for EMEA revenue this quarter. An executive asks how the quarter is tracking. A dashboard assistant asks the same thing on behalf of six people who opened the same report. Each request runs the full pipeline: model calls to understand the question, a semantic query, a scan of Iceberg tables, and another model call to explain six rows.

Caching looks like the obvious fix, and the chatbot world already has a pattern for it. Semantic caching stores past questions as embeddings and returns a stored answer when a new question is close enough in meaning. It works well for support bots, where "how do I reset my password" and "I forgot my password" deserve the same reply.

For data agents, that pattern is dangerous. "Revenue this quarter" and "revenue last quarter" sit almost on top of each other in embedding space, and they have different answers. "Revenue for EMEA" and "revenue for EMEA excluding the UK" are near neighbors with different numbers. A cache that matches on meaning will cheerfully serve the wrong quarter. And a cache that ignores who is asking will serve one user's row-filtered result to another user who should never see it.

This article lays out a caching design that keeps the savings and drops those risks. The core idea is simple. Use meaning to find the right question, then use exact, canonical keys to reuse results. Tie every cached result to the Apache Iceberg snapshots it was computed from, so freshness is checked against the data rather than guessed from a timer. And fold the asker's effective permissions into the key, so a cached result never crosses a policy boundary.

A disclosure: I work at Dremio, whose engine includes automatic materialization features that overlap with parts of this design. Everything here works with any engine that reads Iceberg tables through a REST catalog such as Apache Polaris.

## Why Data Agents Repeat Themselves

Agent traffic is more repetitive than human traffic, and it repeats in specific ways. Knowing which kinds of repetition you have tells you which cache layer pays off.

**Many people ask the same business question.** A company has a few dozen metrics that matter, and most questions are slices of them. Revenue, bookings, active customers, and churn by region, segment, product, and period cover a large share of what anyone types. When an agent becomes the front door to analytics, the same handful of questions arrive from many people in slightly different words.

**One person asks the same question several ways.** Users rephrase when they are unsure the agent understood. "Revenue by region" becomes "show me regional revenue" becomes "break revenue down by region please." Each phrasing reaches the agent as a new request.

**Agents retry.** Tool calls time out, models produce a malformed step, and frameworks retry with small changes. Each retry often regenerates the same semantic query and runs it again.

**Multi-step agents probe.** An agent investigating a dip runs revenue by month, then revenue by month and region, then revenue by month for one region, then the same with a product filter. Many of those intermediate queries repeat across sessions, because different people investigate the same dip.

**Assistants run on schedules.** Morning briefings, report narrators, and alerting agents ask identical questions at fixed times for many recipients.

Each pattern has a different shape. Repeated business questions and paraphrases benefit from matching meaning to a canonical query. Retries and scheduled runs benefit from exact-match result reuse. Probing benefits from caching intermediate results within and across sessions. A single cache keyed on raw question text catches almost none of it, and a single cache keyed on embedding similarity catches all of it, including the cases it should not.

## Three Things a Cache Can Store, and Only One Is Safe to Match by Meaning

A data agent pipeline has three natural places to cache. Each has different risks.

**Question to answer.** The chatbot pattern. Store the user's question, its embedding, and the final answer, including the narrative. On a new question, find the nearest stored question and return its answer if similarity clears a threshold. This has the highest hit rate and the highest risk. Embeddings capture topic far better than they capture the small tokens that change a number: a quarter, a region, a comparison operator, a negation. There is no similarity threshold that reliably separates "this quarter" from "last quarter" while still matching "this quarter" with "the current quarter."

**Semantic query to result.** Store the structured query the agent sends to the semantic layer, in canonical form, and the result it produced. On a new request, build the canonical query and look for an exact match. This has a lower hit rate than question matching, because it only hits after the agent has worked out what the question means. It is also safe, because two requests with the same canonical query ask for the same thing by construction.

**SQL to result.** Store the SQL the engine executed and its result. Engines already do some of this internally. It is the safest layer and the least useful one for agents, because small differences in generated SQL defeat exact matching, and the semantic layer generates different SQL for the same question as its planner changes.

The design in this article uses the second layer as the source of truth for reuse, and uses meaning only to get to it faster. A question's embedding helps find the canonical query that a similar past question produced. That canonical query is then re-checked against the new question, re-resolved for relative dates, and matched exactly. Meaning finds candidates. Exact keys decide reuse.

## Turning a Question Into a Canonical Key

The canonical key is the heart of the design. It has to be identical for two requests that mean the same thing and different for any two that do not. Getting there takes four normalization steps.

**Resolve relative time to absolute time.** "This quarter," "last month," "year to date," and "the past 30 days" must become explicit date ranges before the key is built, using the fiscal calendar the semantic model defines. A query for "this quarter" cached on September 30 must not match "this quarter" asked on October 1. Once the dates are absolute, the two requests produce different keys automatically.

**Resolve values to their stored form.** "EMEA," "Europe, Middle East and Africa," and "emea" must all become the exact dimension value the data uses. This happens anyway when the agent builds a semantic query, so the key uses the resolved values, not the user's words.

**Sort everything that has no order.** Metrics, dimensions, filters, and filter values are sets unless the query specifies an order. Sort them, so "revenue and orders by region and month" and "orders and revenue by month and region" produce the same key. Keep `order_by` and `limit` as they are, because those change the answer.

**Include the semantic model version.** If someone redefines `net_revenue` to exclude a new refund type, every cached result that uses `net_revenue` is now wrong, even though the data did not change. Put the version of the semantic model, or better, a hash of each referenced metric's definition, into the key.

Here is a key builder that applies those rules to a dimensional semantic query.

```python
import hashlib
import json

def canonical_query(query: dict, metric_defs: dict) -> dict:
    """Normalize a resolved semantic query so equivalent requests produce identical output."""
    filters = sorted(
        (
            {
                "dimension": f["dimension"],
                "operator": f["operator"],
                "values": sorted(str(v) for v in f["values"])
                          if f["operator"] in ("in", "equals") else [str(v) for v in f["values"]],
            }
            for f in query.get("filters", [])
        ),
        key=lambda f: (f["dimension"], f["operator"], f["values"]),
    )
    metrics = sorted(query["metrics"])
    return {
        "metrics": metrics,
        "metric_definitions": {m: metric_defs[m]["definition_hash"] for m in metrics},
        "dimensions": sorted(query.get("dimensions", [])),
        "filters": filters,
        "time_grain": query.get("time_grain", "none"),
        "order_by": query.get("order_by", []),
        "limit": query.get("limit"),
    }

def query_key(query: dict, metric_defs: dict) -> str:
    canonical = canonical_query(query, metric_defs)
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()
```

Walk through the pieces.

The function assumes the query is already resolved. Relative dates have become explicit `between` filters with ISO dates, and dimension values have been matched to stored values. That resolution step belongs to the agent pipeline, and the cache must sit after it, never before.

Filters with set semantics, `in` and `equals`, get their values sorted. Range operators such as `between` keep their value order, because the first value is the lower bound.

`metric_definitions` maps each metric to a hash of its definition. If your semantic models live in Apache Ossie, the open specification for semantic model interchange, the hash comes from the metric's expression and any filters in the model file. When a definition changes, its hash changes, and every key that depended on it stops matching. Old entries age out on their own.

`json.dumps` with `sort_keys=True` and fixed separators produces one exact byte string for one canonical query. Hashing it gives a fixed-length key suitable for any key-value store.

The result is a key that captures what was asked and what the metrics mean. It still says nothing about which data the answer came from or who asked. The next two sections add those.

## Snapshot-Aware Invalidation With Iceberg

Every cache faces the same question: when is a stored result no longer true? Most caches answer with a timer. Keep an entry for five minutes, or an hour, then throw it away. A timer is a guess. Set it too short and the cache rarely hits. Set it too long and the agent serves revenue that excludes the last hour of orders, with full confidence.

Iceberg offers a better answer, because an Iceberg table carries its own version number. Every commit creates a new snapshot with a unique snapshot ID, and the catalog records which snapshot is current. If none of the tables behind a result has a new current snapshot, the result is still exactly what the query returns today. If any of them does, the result needs a closer look.

So instead of a timer, each cache entry stores a dependency map: the tables the result was computed from, and the snapshot ID of each table at compute time. A lookup compares that map to the current snapshot IDs. Equal means fresh. Different means stale.

Three details make this work in practice.

**Getting the table list.** The cache needs to know which physical tables a semantic query touched. The semantic layer already knows, because it planned the joins. Expose that list from the execution step, or derive it from the semantic model's dataset definitions for the referenced metrics and dimensions. Do not try to parse it out of generated SQL. The semantic layer is the authority on lineage.

**Reading the snapshot IDs at the right moment.** Record each table's snapshot ID from the same table metadata the engine used to run the query. Reading snapshot IDs a few seconds before or after execution opens a race: a commit lands in between, and the cache labels a result computed from the old snapshot with the new ID. Most engines expose the snapshot they scanned in query profiles or execution metadata. When yours does not, pin the read: look up the snapshot IDs first, then run the query against those exact snapshots with time travel.

**Keeping the freshness check cheap.** Checking freshness means asking the catalog for the current snapshot of each dependent table. Through an Iceberg REST catalog such as Apache Polaris, that is a load-table call that reads metadata, not data. It is fast, but an agent serving thousands of requests a minute should not make several catalog calls per request. Cache the current snapshot IDs themselves for a short window, such as 15 to 60 seconds, and share that lookup across all requests. This bounds staleness to the window you choose, which is a deliberate, visible setting instead of a hidden guess.

Here is a freshness check built on PyIceberg against a Polaris catalog.

```python
import time
from pyiceberg.catalog import load_catalog

catalog = load_catalog(
    "polaris",
    **{
        "type": "rest",
        "uri": "https://polaris.example.com/api/catalog",
        "warehouse": "analytics",
        "credential": "agent-cache-client-id:agent-cache-secret",
        "scope": "PRINCIPAL_ROLE:agent_cache",
    },
)

_snapshot_memo: dict[str, tuple[float, int | None]] = {}
SNAPSHOT_TTL_SECONDS = 30

def current_snapshot_id(table_name: str) -> int | None:
    """Current snapshot ID for a table, memoized for a short window."""
    now = time.monotonic()
    cached = _snapshot_memo.get(table_name)
    if cached and now - cached[0] < SNAPSHOT_TTL_SECONDS:
        return cached[1]
    table = catalog.load_table(table_name)
    snapshot = table.current_snapshot()
    snapshot_id = snapshot.snapshot_id if snapshot else None
    _snapshot_memo[table_name] = (now, snapshot_id)
    return snapshot_id

def dependencies_fresh(dependencies: dict[str, int | None]) -> bool:
    """True when every table behind a cached result is still at the recorded snapshot."""
    return all(current_snapshot_id(t) == sid for t, sid in dependencies.items())
```

Walk through it.

The catalog connection uses a dedicated principal for the cache service. It needs to read table metadata for every table agents query, and nothing else. In Polaris terms, that is a catalog role with metadata read privileges on the relevant namespaces, granted to the cache service's principal role. It does not need to read data files, because it never scans anything.

`current_snapshot_id` calls `load_table`, which goes to the REST catalog and returns the table's current metadata. `current_snapshot()` gives the snapshot the table currently points at. An empty table has no snapshot, which the function represents as `None`.

The memo dictionary holds each table's snapshot ID with a timestamp. Within the 30-second window, repeated checks reuse the stored value without a catalog call. In a multi-process deployment, keep this memo in a shared store rather than process memory, so every worker sees the same view.

`dependencies_fresh` compares every recorded snapshot to the current one. One mismatch makes the entry stale.

**Smarter staleness.** A new snapshot does not always change your result. If a commit added orders for October and the cached result covers July through September, the cached numbers are still right. You can detect this. Iceberg records which data files each snapshot added and removed, along with their partition values, and engines and PyIceberg can read those changes through the table's metadata tables or incremental scans. If every added and removed file falls outside the partitions the query filtered on, the result stands. This is a worthwhile optimization for append-heavy tables with time partitioning, which describes most fact tables. Build it second, after the simple check is in production, and verify it with periodic recomputation, because partition reasoning is easy to get subtly wrong when partition specs evolve.

**Freshness policies per metric.** Not every number needs to be current to the minute. Finance close figures change rarely and matter a lot. Website traffic changes constantly and tolerates some lag. Let the semantic model carry a freshness tolerance per metric, and let the cache serve an entry whose snapshots have moved on if the entry is younger than that tolerance. Then report it. An answer that says "as of 10:42" is honest. An answer that silently reflects 10:42 at 11:30 is not.

## Permission-Aware Keys

The canonical key says what was asked. The snapshot map says which data answered it. One more thing changes the result: who asked.

In a governed lakehouse, two users running the identical semantic query against identical snapshots can get different numbers. Row filters restrict a regional manager to their region. Column masks hide customer names from some roles. A tenant filter limits each customer of a SaaS product to its own rows. If the cache key ignores these, the first user's result becomes everyone's result. That is a data leak, and caches cause it more often than any other component, because they are added for speed by people thinking about speed.

The fix is to include the asker's effective policy in the key. There are two ways to do it, and the choice matters for hit rate.

**Key by principal.** Include the user or agent principal's identity in the key. This is always safe and simple. It also means two analysts with identical access never share cache entries, which cuts the hit rate sharply in large organizations.

**Key by policy fingerprint.** Include a hash of the policies that actually applied to the query: the row filter predicates, the masking rules, and the set of roles that granted access to each table. Two users whose queries ran under identical effective policies share entries. Two users under different policies never do. This keeps safety and recovers most of the hit rate, because most users fall into a small number of access profiles.

The policy fingerprint has to come from the system that enforced the policy. That is the engine or the semantic layer applying row filters and masks, informed by the catalog's grants. Do not compute it in the agent from what you believe the user's roles are. If the engine applied a row filter you did not know about, your fingerprint is wrong, and the cache leaks. When the enforcing system cannot report the applied policies, fall back to keying by principal.

Two more rules close the remaining gaps.

**Check access before serving, not only before storing.** A user loses access to a table at 9:00. At 9:05 they ask a question whose answer is cached under their old fingerprint. The cache must not serve it. Before returning an entry, confirm the principal can still read every dependent table, using the same catalog grants that govern live queries. A memoized grant check with a short window keeps this cheap, just like the snapshot check.

**Isolate tenants completely.** In multi-tenant deployments, put the tenant identifier in the key and, ideally, use a separate cache namespace or store per tenant. A bug in fingerprinting then fails inside one tenant rather than across customers.

Putting the pieces together, a full cache entry looks like this:

```python
cache_entry = {
    "key": f"{tenant_id}:{policy_fingerprint}:{query_key(query, metric_defs)}",
    "canonical_query": canonical_query(query, metric_defs),
    "dependencies": {"sales.orders": 7340029183526114402, "sales.regions": 1188200371150052117},
    "computed_at": "2026-10-05T14:02:11Z",
    "result_arrow_ipc": b"...",     # Arrow IPC stream bytes of the result table
    "row_count": 6,
    "semantic_model_version": "2026.10.03-1",
}
```

The key combines tenant, policy fingerprint, and canonical query. The dependencies map supports the freshness check. The result is stored as Arrow IPC bytes, covered next.

## Where to Keep the Cache

A data agent cache has two jobs with different storage needs. It must answer lookups in a few milliseconds, and it must leave a record you can analyze later.

**The hot store.** Lookups need a fast key-value store: an in-memory cache inside the agent service for single-node deployments, or a shared store such as Redis or a similar system for anything larger. Store each entry under its full key, with the dependency map, metadata, and result bytes. Size limits matter. Most agent results are small, a few rows to a few thousand, but an occasional detail query returns far more. Cap the cacheable result size, such as 1 MB, and skip caching above it.

**Arrow IPC for results.** Store results in Apache Arrow's IPC stream format. Engines increasingly return results as Arrow through Arrow Flight, ADBC, or their Python clients, so the result arrives in Arrow and goes into the cache without conversion. On a hit, it comes back out as an Arrow table with exact types, ready for the narration step or the client. No CSV formatting, no float drift, no date strings parsed two different ways.

```python
import pyarrow as pa

def to_ipc(table: pa.Table) -> bytes:
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue().to_pybytes()

def from_ipc(data: bytes) -> pa.Table:
    return pa.ipc.open_stream(data).read_all()
```

`new_stream` writes the schema once and then the record batches. `open_stream` reads them back into a table. The round trip preserves types exactly, including decimals, timestamps with time zones, and nulls.

**The cache ledger in Iceberg.** Every lookup, hit, miss, and invalidation is worth recording, and an Iceberg table is a good place for it. Each row holds the key, the canonical query, the tenant and policy fingerprint, the dependency snapshot IDs, whether the lookup hit, why a miss happened (no entry, stale snapshot, definition change, or access change), and the time saved. Because the ledger is an Iceberg table, any engine can query it. It answers questions such as which metrics drive the most repeat traffic, how often freshness checks invalidate entries, and what the cache actually saved, without a separate observability tool. Append to it in batches rather than per lookup, so the ledger itself does not generate thousands of tiny commits.

## Using Meaning to Route, Not to Answer

The canonical key only exists after the agent has turned a question into a resolved semantic query. That step costs model calls, so a cache that starts there saves the query execution and the narration but not the understanding. You can save part of the understanding too, as long as meaning never decides reuse on its own.

Keep an embedding index of past questions, each linked to the canonical query it produced, with relative dates stored in their unresolved form. "Revenue by region this quarter" maps to a query template with metric `net_revenue`, dimension `region`, and a filter of `current_fiscal_quarter`. When a new question arrives, search the index. If a past question is very similar, take its template as a strong candidate.

Then verify the candidate before using it. Three checks keep this safe.

**Resolve the template fresh.** Turn `current_fiscal_quarter` into today's date range, not the range from when the template was stored. Resolve dimension values again against current data.

**Confirm the template fits the new question.** Use a small, fast model to compare the new question with the template and answer one narrow question: does this structured query fully answer this question, yes or no? A yes-or-no check on a short structured input is far more reliable than open generation, and it catches the dangerous near misses. "Revenue for EMEA excluding the UK" is close to "revenue for EMEA," and the check fails it because the template has no exclusion filter.

**Fall back on any doubt.** If similarity is below a high threshold, or the check says no, run the full understanding step as if the cache did not exist.

When all three pass, the agent skips the expensive understanding step and goes straight to building the canonical key, which then hits or misses the result cache on exact match. Meaning shortened the path. Exactness decided the answer.

This pairs well with a small model handling routine agent steps. The template lookup plus a yes-or-no check costs a fraction of a frontier model call, and for the repetitive questions that dominate agent traffic, it removes the frontier model from the path entirely.

## Caching Narration and Intermediate Results

Two more layers are worth adding once the result cache works.

**Narration keyed on the result.** The summary an agent writes for a result depends on the question's intent and the numbers. Key the narration cache on a hash of the canonical query plus a hash of the result bytes. If the data changes, the result hash changes, and the old narration stops matching. Never cache narration keyed on the question alone, because the same question next week has different numbers and the cached summary will describe last week's trend.

**Intermediate results for multi-step agents.** An agent investigating a question runs a chain of related queries. Many of those intermediate queries recur across sessions, because different people investigate the same events. Intermediate results go through the same result cache, with the same canonical keys, snapshot maps, and policy fingerprints. No separate mechanism is needed. Agents probing the same dip at the same time share most of their queries, and the second agent's investigation runs much faster than the first.

Do not cache the agent's final multi-step conclusions as answers. A conclusion such as "the dip came from two enterprise accounts delaying renewals" depends on reasoning over several results, and it is the kind of output where a cached version goes wrong quietly. Let the reasoning run again over cached inputs. It is cheaper than it sounds, because the queries underneath it hit the cache.

## The Lookup Path, End to End

Here is the full lookup path in one function, using the pieces above.

```python
def answer_with_cache(question, user, pipeline, cache, ledger):
    query = pipeline.understand(question, user=user)          # template lookup or full model step
    resolved = pipeline.resolve(query, user=user)              # absolute dates, stored values
    executed_policy = pipeline.policy_fingerprint(resolved, user=user)
    key = f"{user.tenant_id}:{executed_policy}:{query_key(resolved, pipeline.metric_defs)}"

    entry = cache.get(key)
    if entry and dependencies_fresh(entry["dependencies"]) and pipeline.can_read_all(user, entry["dependencies"]):
        ledger.record(key, hit=True)
        table = from_ipc(entry["result_arrow_ipc"])
        return pipeline.narrate(question, resolved, table, cached_at=entry["computed_at"])

    reason = "no_entry" if entry is None else "stale_or_access_changed"
    result = pipeline.execute(resolved, user=user)             # returns table, dependencies, policy
    if result.ok and result.table.nbytes < 1_000_000:
        cache.put(key, {
            "canonical_query": canonical_query(resolved, pipeline.metric_defs),
            "dependencies": result.dependencies,
            "computed_at": result.computed_at,
            "result_arrow_ipc": to_ipc(result.table),
        })
    ledger.record(key, hit=False, reason=reason)
    return pipeline.narrate(question, resolved, result.table, cached_at=None)
```

Walk through the order of operations, because the order is the design.

Understanding and resolution happen first, every time. The cache never sees an unresolved question.

The policy fingerprint comes from `pipeline.policy_fingerprint`, which asks the enforcing layer which policies apply to this resolved query for this user. Only then is the key built.

A hit requires three things: an entry under the exact key, fresh dependencies, and current read access to every dependent table. Any failure falls through to execution.

`pipeline.execute` returns the dependencies it actually read, with snapshot IDs taken from the execution itself, so the stored map matches the data that produced the result.

`cached_at` flows into narration, so a served answer can say when its numbers were computed. Users trust answers that state their age far more than answers that hide it.

## A Morning of Traffic, Traced

To see how the layers interact, follow a handful of requests through the morning of September 29, near the end of the fiscal quarter. The tables commit every 15 minutes from an ingestion pipeline, and the snapshot memo window is 30 seconds.

At 8:58, a finance analyst asks for net revenue by region this quarter. Nothing is cached. The agent understands the question, resolves "this quarter" to July 1 through September 30 under the fiscal calendar, builds the canonical key, misses, runs the query, and stores the result with the snapshot IDs of the orders, refunds, and regions tables. The analyst's policy fingerprint reflects full access to all regions.

At 9:01, a second finance analyst asks "how much net revenue did each region book this quarter?" The template index finds the 8:58 question, the yes-or-no check confirms the template fits, and resolution produces the identical canonical query. The fingerprint matches, because both analysts hold the same access profile. The snapshots have not moved. The result comes back from the cache, and the narration cache hits too, because the result bytes are identical.

At 9:03, the EMEA regional manager asks the same question. The canonical query matches, but the enforcing layer applies a row filter limiting the manager to EMEA, so the policy fingerprint differs. The key differs. The cache misses, the query runs under the manager's filter, and a separate entry is stored. No row from another region leaves the engine.

At 9:15, the ingestion pipeline commits new orders. The next request for the finance query, at 9:16, finds a different current snapshot for the orders table after the memo window expires, so the entry is stale. The agent recomputes and stores a fresh entry. Had the commit only touched order-date partitions from June, such as a late correction to the prior quarter, the partition-aware check keeps the old entry, because the query covers July through September.

At 9:20, a scheduled briefing assistant asks the finance query on behalf of twelve executives who share the finance access profile. Eleven of those twelve requests hit the 9:16 entry. The first one checks freshness against the catalog, and the rest reuse the memoized snapshot lookup.

On October 1, every one of these questions resolves "this quarter" to October through December. Every canonical key changes, and none of the September entries match. The period boundary, which breaks naive caches, passes without anyone noticing.

## Measuring Whether the Cache Helps

A cache that nobody measures drifts into either uselessness or danger. Track these from the ledger.

**Hit rate by layer.** Template hits, result hits, and narration hits separately. Each tells a different story. A low template hit rate with a high result hit rate means questions repeat in meaning but rarely in wording, so the template index needs work.

**Miss reasons.** No entry, stale snapshot, definition change, and access change. A high stale-snapshot rate on a table that commits every minute says the cache will never help that table, so exclude it or add the partition-aware staleness check.

**False hit rate.** The number that matters most and the one most teams skip. Sample a small share of cache hits, such as one in a hundred, recompute them from scratch in the background, and compare the results exactly. Any mismatch is a bug in canonicalization, dependency tracking, or policy fingerprinting. The acceptable false hit rate is zero, and the sampling is how you prove you are there.

**Staleness served.** For hits served under a freshness tolerance rather than an exact snapshot match, record how old the result was. Compare it to each metric's tolerance.

**Saved cost and latency.** Model calls, scanned bytes, and seconds avoided per hit. This is the number that justifies the cache, and with the ledger in Iceberg, it is one aggregate query.

If you already run a golden-question benchmark for your agent, run it twice: once with a cold cache and once with a warm cache. The pass rate must be identical. A warm-cache run that scores lower has found a correctness bug before a user did.

## Failure Modes and Warning Signs

These are the ways agent caches go wrong, and how each one shows up.

**Relative dates cached unresolved.** The cache stores "this quarter" as text and serves September's answer in October. The warning sign is a spike of complaints at period boundaries: the first day of a month, quarter, or fiscal year. Resolve before keying, always, and add golden questions that cross a period boundary.

**Near-miss semantic matches.** An embedding-only cache matches "EMEA excluding UK" to "EMEA." The warning sign is false hits clustered on questions with exclusions, comparisons, or negations. Never serve on similarity alone, and keep the yes-or-no template check.

**Cross-policy leakage.** A result computed under one user's row filter is served to another user. The warning sign is any false hit in sampled recomputation where the recomputed result has different row counts for the same query. Treat a single occurrence as a security incident. Fingerprint from the enforcing layer, isolate tenants, and check access on every serve.

**Silent definition changes.** A metric definition changes, but the key used a semantic model version that did not change because the edit bypassed versioning. The warning sign is a gap between cached and fresh results right after a semantic model deploy. Hash metric definitions directly rather than trusting a version label.

**Snapshot races.** Snapshot IDs are read before execution while a commit lands, so a result from the old snapshot carries the new ID. The warning sign is rare, unreproducible false hits on frequently updated tables. Take snapshot IDs from execution metadata, or pin execution to the snapshots you recorded.

**Catalog overload.** The freshness check calls the catalog for every dependency of every request. The warning sign is rising catalog latency and load-table call counts that track agent traffic. Memoize snapshot lookups with a short shared window, and batch them.

**Cache stampedes.** A popular entry goes stale after a commit, and fifty concurrent requests all miss and run the same expensive query. The warning sign is query bursts right after commits to popular tables. Let one request recompute while others wait briefly for its result, a pattern usually called request coalescing.

**Unbounded growth.** Every unique key gets stored forever. The warning sign is a cache store that grows with total traffic rather than with distinct popular questions. Set a size cap with least-recently-used eviction, and stop caching results above the size limit.

## Operational Guidance

Introduce the cache in stages, so each layer proves itself before the next one adds risk.

**Start with exact result caching.** Canonical keys, snapshot dependency maps, principal-based keys, and Arrow IPC storage. Turn on sampled recomputation from day one. This layer alone catches retries, scheduled assistants, and repeated popular questions.

**Move to policy fingerprints.** Once the enforcing layer reports applied policies reliably, switch keys from principal to fingerprint. Watch the hit rate rise and the false hit rate stay at zero.

**Add template routing.** Build the embedding index of question templates and the yes-or-no check. Start with a high similarity threshold and lower it slowly while watching false hits.

**Add partition-aware staleness last.** Only for append-heavy, time-partitioned fact tables, and only with continued sampling.

**Set freshness tolerances with metric owners.** The people who own each metric decide how stale it can be. Record the tolerance in the semantic model, next to the definition, where everyone can see it.

**Exclude what should not be cached.** Queries over tables that commit every few seconds, results that include sensitive columns your policy forbids storing outside the engine, and any question with a personal scope, such as "my accounts," unless the key includes the principal.

**Keep the cache disposable.** Every entry can be recomputed. Flushing the whole cache must always be safe, and you should do it after any change to fingerprinting or canonicalization logic.

## Where This Is Heading

Three developments will make this design easier to build.

Catalogs are getting better at telling the world what changed. Apache Polaris has been expanding its event system, and an event stream of table commits lets a cache invalidate entries the moment a dependency changes, instead of polling for snapshot IDs. Polling with a short window works well today. Push invalidation will make it cheaper and fresher.

Semantic queries are becoming a standard shape. Apache Ossie's community is defining standard query interfaces for semantic models, including a dimensional interface of measures, dimensions, and filters. A standard canonical form for semantic queries means canonical cache keys can be shared across tools, and the same cache can serve a BI tool, an agent, and an API.

Engines are making snapshot lineage visible. More engines report exactly which snapshots a query read. That turns the most delicate part of this design, recording the right snapshot for each result, into a field you copy from the execution metadata.

## Conclusion

Data agents repeat themselves constantly, and caching is the cheapest way to make them faster and less expensive. The chatbot version of semantic caching, matching new questions to old answers by embedding similarity, is the wrong tool for numbers, because the words that change a number are exactly the words embeddings blur.

The safe design separates meaning from reuse. Use embeddings to find a candidate query template, verify it, and resolve it fresh. Reuse results only on exact canonical keys that capture the resolved query and the metric definitions. Tie every result to the Iceberg snapshots it came from, and check freshness against the catalog instead of a timer. Fold the enforced policy into every key, check access on every serve, and isolate tenants completely. Then measure false hits by recomputing a sample, and hold the rate at zero.

The open lakehouse makes each of those steps straightforward. Iceberg snapshots give every table a version you can compare. Polaris answers "what is current" and "who can read this" from one place. Arrow carries results into and out of the cache without loss. Ossie keeps metric definitions in a form you can hash. Put together, they let an agent answer the fortieth copy of a question in milliseconds, with the same number a fresh query returns.

## Keep Going

If this piece was useful, I have written a lot more on running AI agents on top of open lakehouse data. *Architecting an Apache Iceberg Lakehouse* covers how snapshots, catalogs, and the semantic layer fit together in an open lakehouse, which is the foundation every technique in this article sits on. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
