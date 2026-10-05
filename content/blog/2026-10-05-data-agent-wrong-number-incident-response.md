---
title: "When a Data Agent Gives a Wrong Number: Incident Response for Agentic Analytics"
description: "A plan for when a data agent gives a wrong number: severity levels, containment, Iceberg time travel reproduction, and blast radius queries."
date: 2026-10-05T09:00:00Z
tags: ["incident response", "AI agents", "Apache Iceberg", "data quality"]
canonical: https://iceberglakehouse.com/posts/data-agent-wrong-number-incident-response/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/data-agent-wrong-number-incident-response/).

A regional director pastes a number from the company's AI analyst into a board deck. Net revenue for the quarter, broken down by region. Three days later, the finance team reconciles the deck against the close numbers and finds that the director's region is overstated by 11 percent. The agent did not crash. It did not throw an error. It answered confidently, the number looked reasonable, and it was wrong.

Now the hard questions start. Was this one bad answer or many? Who else asked something similar and got the same wrong number? When did it start? Was it the model, the metric definition, the data, or a cached result? Which decks, emails, and decisions already contain the number? And what do you tell the people who received it?

Most teams have incident response for outages. Very few have it for wrong answers, and wrong answers from data agents are the more dangerous failure. An outage is visible and stops people from acting. A wrong number is invisible and invites people to act on it. As agents become the front door to company data, a plan for this failure stops being optional.

This article lays out that plan. It covers how to classify severity, how to detect wrong answers before a board member does, how to contain the problem in the first hour, how to reproduce the exact answer a user saw with Apache Iceberg time travel, how to find the blast radius with a query over agent telemetry, how to correct and notify, and how to make sure the same failure cannot recur. The open lakehouse turns out to be the reason most of this is possible, because Iceberg tables remember every version of the data and every answer the agent gave.

A disclosure: I work at Dremio, which builds a semantic layer and an MCP server that agents use. The practices here apply to any agent that queries Iceberg tables.

## Why Wrong Numbers Are a Different Kind of Incident

Software incident response grew up around outages and errors. A service goes down, alerts fire, someone restores it, and a postmortem follows. Wrong answers from a data agent break almost every assumption in that model.

**They do not trigger alerts.** A query that runs and returns plausible numbers looks exactly like a correct one to every monitoring system. Error rates stay flat. Latency stays flat. The only signal is a human noticing that a number does not match something else.

**They spread.** Users copy agent answers into slides, emails, chat threads, spreadsheets, and tickets. By the time someone notices, the number has left the system. Fixing the agent does not fix the deck.

**They lead to actions.** People ask agents questions because they intend to do something with the answer: approve a budget, prioritize an account, set a target. An agent that can take actions itself, such as opening tickets or adjusting settings, can act on its own wrong number.

**They are often systematic.** A wrong metric definition, a broken join path, or a stale cache entry does not produce one wrong answer. It produces the same wrong answer for everyone who asks a similar question, for as long as the cause persists. The first report is usually the tip of a cluster.

**They have several possible causes at once.** An outage usually has one root cause. A wrong number can come from the model, the prompt, retrieval, the semantic model, the data, the cache, permissions, or the engine, and sometimes from two of these interacting.

So incident response for wrong numbers needs different detection, different containment, and a different definition of done. Done is not "the agent answers correctly now." Done is "everyone who received the wrong number knows the right one, and the cause cannot recur."

## Severity Levels

Classify wrong-answer incidents by impact, not by how embarrassing the bug looks. A table makes the levels concrete.

| Severity | What happened | Examples | Response |
|---|---|---|---|
| SEV1 | Wrong number reached an external party or drove a material decision, or the agent exposed data the user was not allowed to see | Number in a board deck, investor update, customer report, or regulatory filing. Cross-tenant data in an answer. | Immediate containment, executive and legal notification, full correction campaign |
| SEV2 | Systematic wrong answers on a governed metric, with many affected users or decisions | A metric definition error affecting every revenue question for a week | Containment within the hour, notify all affected users, postmortem |
| SEV3 | Wrong answers limited to a narrow question type or a few users, caught before decisions | Fiscal versus calendar quarter mix-up on one phrasing | Fix through the normal release process, notify affected users |
| SEV4 | Isolated wrong answer with no systematic cause, or a near miss caught by checks | A one-off misread of an ambiguous question | Add to the golden set, review in the weekly triage |

Any exposure of data across a permission boundary is SEV1, regardless of how small. A wrong number and a data leak are different failures, but they share the same response path because both require knowing exactly who saw what.

Severity can change during an investigation. A report that starts as a SEV3 single answer often becomes a SEV2 once the blast radius query runs. Re-classify as soon as the scope is known.

## Detection: Finding Wrong Answers Before Your Users Do

Most wrong-answer incidents today are detected by a person who happens to know the right number. That is not a detection strategy. Build several layers, so each catches what the others miss.

**User reports, made easy.** Every answer needs a one-click way to say "this number looks wrong," separate from a general thumbs-down. A thumbs-down means many things. A wrong-number report means one thing, and it should page someone during business hours for answers on governed metrics. Ask the reporter what they expected and why, in one optional text field.

**Sampled recomputation.** For a small share of answers, such as one in two hundred, recompute the answer independently after the fact: run the same canonical semantic query through a separate, simpler path, against the same Iceberg snapshots the original answer read, and compare. Any mismatch points to a bug in the agent's path. This catches cache errors, query construction bugs, and engine differences without needing a human to notice.

**Reconciliation against trusted reports.** Your organization already has numbers it trusts: the finance close, the certified dashboards, the board metrics. Schedule the agent to answer the questions those reports answer, daily, and compare. A gap between the agent and the certified dashboard on the same metric and period is an incident until explained.

**Golden question regressions.** A golden-question benchmark runs before every release. Running it daily against production as well, with frozen data, catches changes that bypassed the release process, such as a hosted model alias that moved.

**Distribution checks.** Track the distribution of answers to common questions over time. If the median "revenue last month by region" answer suddenly shifts by 20 percent with no corresponding change in the data, something changed in how the agent computes it.

**Canary values.** In test tenants and synthetic data, seed values that no correct answer can contain. Any answer containing one indicates a leak or a wrong join.

Detection layers produce false alarms, especially reconciliation, where definitions legitimately differ between a dashboard and a governed metric. Every false alarm is still useful, because it usually reveals an undocumented definitional difference that will confuse users eventually. Record them, explain them in the metric's description, and tune the check.

## The First Hour: Contain

When a wrong-answer report looks credible, the first goal is to stop the wrong number from reaching more people. Investigation comes second. Containment options, from narrowest to broadest:

**Disable the affected question pattern.** If the problem is limited to one metric or one dimension combination, have the agent refuse or caveat questions that touch it. Most semantic layers and agent tool layers can block a metric for agent use without touching dashboards. The agent answers: "Net revenue by region is temporarily unavailable while we verify it. Here is the certified dashboard."

**Invalidate related caches.** If cached results carry the suspect number, mark every cache entry that depends on the affected metric or tables as unservable, and keep the entries for the investigation. A cache keyed on canonical queries and metric definition hashes makes this a targeted operation rather than a full flush.

**Roll back the agent.** If the problem started after a release, switch the router back to the previous release manifest. If every component of the agent, including model, prompt, tools, semantic model commit, and retrieval index, is pinned in a manifest, this is a single change.

**Pin the semantic model.** If a recent metric definition change is suspected, pin the agent to the previous semantic model commit while dashboards continue on the new one. Do this only if the old definition is known to be correct. Rolling back a correction reintroduces the original error.

**Show a banner.** If the scope is unclear, put a notice on every answer that touches the affected area: numbers for this metric are under review, verify against the certified source before sharing. It is blunt, and it works.

Record every containment action with a timestamp in the incident record. The blast radius analysis later needs to know exactly when the wrong number stopped being served.

Do not delete anything during containment. The telemetry, the cache entries, and the release manifests are the evidence. Containment stops new damage. It does not erase the record of old damage.

## What You Need to Have Recorded Beforehand

Everything after containment depends on records that have to exist before the incident. If the agent does not log the right things, the investigation becomes guesswork, and the blast radius becomes "everyone, probably."

For every answer the agent gives, record these fields in an Iceberg table, partitioned by day and, in multi-tenant products, by tenant:

- The answer ID, session ID, user, tenant, and timestamp.
- The question text, or a redacted form where policy requires it.
- The release manifest ID that produced the answer.
- The canonical semantic query the agent ran, in a normalized form with relative dates resolved to absolute ones.
- The governed metrics and dimensions the query referenced.
- The tables the query read and the Iceberg snapshot ID of each table at execution time.
- Whether the result came from a cache, and if so, which entry.
- A hash of the result, and either the result itself or enough to reconstruct it.
- The answer's behavior: answered, clarified, refused, or failed.
- Any actions the agent took, such as tickets, writes, or notifications.

Two of these do most of the work. The canonical query lets you find every answer that asked the same thing, whatever the phrasing. The snapshot IDs let you reproduce exactly what the answer saw, even after the tables have changed many times since.

Store result values with care. For many organizations, the numbers themselves are sensitive enough that logging them requires the same controls as the source data. Keeping the telemetry in Iceberg, under the same Apache Polaris catalog and grants as the source tables, means access to the record follows access to the data. A support engineer who cannot read the revenue tables cannot read revenue answers in the telemetry either.

Retention matters too. Wrong numbers are often discovered weeks later, at quarter close or during an audit. Keep answer telemetry for at least two full reporting cycles. And make sure snapshot expiration on the source tables does not remove the snapshots that answers referenced before you finish investigating. For regulated metrics, tag the relevant snapshots at period close so they survive routine expiration.

## Reproduce the Exact Answer With Iceberg Time Travel

The first investigative step is to reproduce the wrong answer exactly as the user saw it. Not approximately, not "the agent says something different now," but the same query against the same data.

Iceberg makes this possible because each table keeps its snapshot history until expiration removes it, and any engine can read a table as of a specific snapshot. Pull the answer's record from telemetry, then rerun its query against the recorded snapshots.

```sql
-- 1. Pull the answer the user saw.
SELECT answer_id, asked_at, manifest_id, canonical_query, snapshot_ids,
       served_from_cache, cache_entry_id, result_hash
FROM agent_ops.answers
WHERE answer_id = 'ans_7f3c91';

-- 2. Recompute the metric directly, pinned to the snapshots that answer read.
SELECT r.region_name AS region,
       SUM(o.amount) AS gross_revenue
FROM sales.orders  VERSION AS OF 7340029183526114402 o
JOIN sales.regions VERSION AS OF 1188200371150052117 r
  ON o.region_id = r.region_id
WHERE o.order_date BETWEEN DATE '2026-07-01' AND DATE '2026-09-30'
GROUP BY r.region_name;

-- 3. Compute the same metric against the same snapshots using the certified definition.
SELECT r.region_name AS region,
       SUM(o.amount) - COALESCE(SUM(f.total_refunds), 0) AS net_revenue
FROM sales.orders  VERSION AS OF 7340029183526114402 o
JOIN sales.regions VERSION AS OF 1188200371150052117 r
  ON o.region_id = r.region_id
LEFT JOIN (
  SELECT order_id, SUM(refund_amount) AS total_refunds
  FROM sales.refunds VERSION AS OF 5521098371623004418
  GROUP BY order_id
) f ON f.order_id = o.order_id
WHERE o.order_date BETWEEN DATE '2026-07-01' AND DATE '2026-09-30'
GROUP BY r.region_name;
```

Walk through it.

The first query retrieves everything the investigation needs from telemetry: which manifest produced the answer, the canonical query, the snapshot ID of each table, and whether the answer came from cache.

The second query recomputes what the agent's query appears to have done, pinned with `VERSION AS OF` to the exact snapshots recorded in telemetry. In this example, the investigator suspects the agent computed gross revenue instead of net revenue, so the query tests that hypothesis. If its result matches the hash of the answer the user saw, the hypothesis is confirmed.

The third query computes the correct answer against the same snapshots, using the certified definition. It pre-aggregates refunds per order before joining, which avoids inflating order amounts when an order has several refunds. The difference between the second and third results is the error, measured exactly on the data the user's answer saw.

Pinning matters more than it first appears. If you rerun against today's tables, the numbers include orders that arrived after the answer was given. Your recomputed "wrong" answer will not match what the user saw, the correct answer will differ from what it was at the time, and every comparison becomes muddled. With pinned snapshots, the only variable left is the computation itself.

Reproduction usually lands in one of four outcomes.

**The recomputation matches the user's answer, and the certified definition gives a different number.** The agent computed something other than the governed metric. The cause is in the agent's path: model, prompt, retrieval, or tools.

**The recomputation through the governed semantic query matches the user's answer, and so does the certified definition.** Both agree with the user's number, so the number was right for that data. Either the reporter compared against a different definition, or the data itself was wrong at that snapshot. Check later snapshots for corrections.

**The user's answer matches neither.** Look at the cache. If `served_from_cache` is true, the cached result probably came from different snapshots or under a different policy than the record claims, which points to a cache key or freshness bug.

**The snapshots no longer exist.** Expiration removed them. Reproduction is approximate at best. This is the outcome to prevent with retention policies and tags, because it turns a precise investigation into an argument.

## Find the Blast Radius

Reproduction explains one answer. The blast radius tells you how many others share the problem. This is where the telemetry pays for itself, because finding every affected answer becomes a query.

Start from the cause you identified, and express it as a filter. If the agent used the wrong metric, find every answer whose canonical query used that metric in place of the intended one. If a metric definition was wrong, find every answer that referenced that metric while the bad definition was live. If a cache entry was bad, find every answer served from it.

```sql
-- Every answer that referenced net_revenue while the bad release was live,
-- with the users and tenants who received them.
SELECT a.tenant_id,
       a.user_id,
       COUNT(*)                           AS answers,
       MIN(a.asked_at)                    AS first_seen,
       MAX(a.asked_at)                    AS last_seen,
       SUM(CASE WHEN a.served_from_cache THEN 1 ELSE 0 END) AS from_cache,
       SUM(CASE WHEN SIZE(a.actions) > 0 THEN 1 ELSE 0 END) AS with_actions
FROM agent_ops.answers a
JOIN agent_ops.releases r ON a.manifest_id = r.manifest_id
WHERE r.manifest_id = 'analyst-agent-2026.09.24-2'
  AND array_contains(a.metrics, 'net_revenue')
  AND a.behavior = 'answered'
  AND a.asked_at < TIMESTAMP '2026-10-03 14:20:00'   -- containment time
GROUP BY a.tenant_id, a.user_id
ORDER BY answers DESC;
```

Walk through it.

The join to the release ledger restricts the search to answers produced by the manifest that introduced the problem. If the cause was a data or semantic model issue rather than an agent release, replace this with a time window covering when the cause was live.

`array_contains` keeps answers that referenced the affected metric. The function name follows Spark SQL. Other engines use an equivalent such as `contains` or `ANY`.

The behavior filter excludes refusals and clarifications, which did not deliver a number.

The timestamp filter stops at the moment containment took effect, which is why the incident record needs precise times.

The output groups by tenant and user, with counts, the first and last time each user saw an affected answer, how many came from cache, and how many led to an action. That is the notification list, sorted by exposure.

Refine the blast radius in two passes. The first pass, like the query above, is deliberately broad: every answer that touched the affected area. The second pass recomputes each of those answers against its recorded snapshots with the correct logic and compares results. Some answers referenced the metric but were unaffected, for example because the bug only appeared with a particular dimension. Recomputation separates the truly affected answers from the merely nearby ones, so you notify the right people without alarming everyone.

For agents that take actions, run a separate query for actions. A wrong number that only sat in a chat window is one problem. A wrong number that opened 40 tickets, adjusted a forecast, or emailed a customer is another, and each action needs its own follow-up.

Iceberg makes the second pass cheap. Each recomputation is a pinned query against snapshots that still exist, and the engine can run them in bulk. For a few thousand affected answers, the full recomputation takes minutes, not days.

## Correct and Notify

A wrong-number incident is not over when the agent is fixed. It is over when the people who received the wrong number have the right one. This is the step teams skip most often, because it is uncomfortable, and it is the step that decides whether people keep trusting the agent.

Notify in order of exposure. Users who received the most affected answers, users whose answers led to actions, and users in roles that share numbers externally come first. The blast radius query already sorts them.

Each notification needs five things.

**What was wrong.** The specific question pattern and metric, in plain language. "Answers about net revenue by region between September 24 and October 3 included refunds incorrectly."

**The correct numbers.** Not a link to a dashboard, but the corrected values for the specific answers this user received, recomputed against the same snapshots the original answers used. Users want to fix their decks, and that requires the exact replacement figure for the exact question they asked.

**How large the error was.** The difference between what they saw and the correct value, as a number and a percentage. A 0.3 percent error and an 11 percent error call for different follow-up.

**What has been done.** The fix, the date it took effect, and what has been added to prevent recurrence.

**Who to contact.** A named owner for questions, usually the metric owner, not a generic support address.

Here is a short template that covers it.

> **Correction: net revenue by region (Sept 24 to Oct 3)**
> Between September 24 and October 3, the analytics assistant calculated net revenue by region without subtracting refunds. You received 3 answers affected by this. The corrected figures for your questions are below, computed on the same data your original answers used.
> Net revenue by region, Q3 (asked Sept 29). You saw EMEA at 4.82M. The correct figure is 4.34M, a difference of 0.48M (10.0 percent lower).
> The issue was fixed on October 3 at 14:20 UTC. We added a check that compares assistant answers to the certified finance numbers daily. Questions: the finance analytics team.

Keep the tone factual. Do not minimize, and do not dramatize. People respond well to a precise correction delivered quickly. They respond badly to vague notices and to discovering the problem themselves.

For SEV1 incidents, coordinate with the people who own external communication. If a wrong number reached a board, a customer, an investor, or a regulator, the correction to that audience goes through the same channel the original number traveled, and the people responsible for that channel decide how.

For actions the agent took, follow up action by action. Tickets get updated or closed. Forecasts get recalculated. Customers who received automated messages get a correction from a person. The telemetry record of each action, with its manifest ID and inputs, tells you exactly what to undo.

## Special Case: Data Exposed Across a Permission Boundary

One class of incident needs its own path. Sometimes the number is not wrong at all. It is correct, and the user should never have seen it. A regional manager receives revenue for every region. A customer of a multi-tenant product receives an answer that includes another customer's rows. An analyst without HR access gets a summary built from salary data.

Treat these as security incidents first and data incidents second. That changes three things about the response.

**Containment is broader and faster.** Block the agent's access path that leaked, immediately, even at the cost of refusing legitimate questions for a while. If the cause is unclear, narrow the agent principal's grants in the catalog to the minimum known-safe set. A temporarily less useful agent is acceptable. A continuing leak is not.

**The blast radius query changes.** You are no longer looking for answers that referenced a metric. You are looking for answers where the data read exceeded what the user was entitled to. Compare each answer's recorded tables and applied policies against the user's grants at that time. In an Apache Polaris catalog, grants are explicit, so "what was this principal allowed to read on that date" has a definite answer, especially if grant changes are themselves recorded in a table. Record them there before you need them, alongside the release ledger, so a grant change and an agent release can be lined up on one timeline.

**Notification goes to different people.** Users who received data they should not have seen are asked to delete it. The owners of the exposed data, and in multi-tenant products the affected customers, are told what was exposed and to whom. Legal and privacy teams decide on any regulatory notifications.

The root cause is almost always in one of three places: a grant that was broader than intended, a row filter or mask that did not apply on the agent's path, or a cache that reused a result across different policies. None of these belongs in a prompt fix. Grants get corrected in the catalog, filters get enforced in the engine or semantic layer, and cache keys get the policy fingerprint they were missing.

## Root Cause Categories

Once the immediate problem is contained and corrected, find the cause precisely. Wrong numbers from data agents come from a small number of categories, and each one points to a different fix.

**Semantic model error.** The governed metric definition itself was wrong, or a change to it was wrong. Dashboards using the same definition were wrong too, which is a useful tell. The fix belongs in the semantic model, through the metric owner, with a review of every golden question that depends on the metric.

**Metric selection error.** The definition was right, but the agent chose the wrong metric, such as gross revenue for net revenue, or the wrong dimension, such as calendar month for fiscal period. Look at retrieval results and the model's choice in the telemetry. Fixes include clearer metric descriptions and synonyms in the semantic model, fewer and more distinct retrieval candidates, and golden questions that test the distinction.

**Interpretation error.** The agent misread the question: wrong time window, missed a filter, ignored an exclusion such as "excluding the UK." Often a model or prompt issue. Fixes include clarifying-question behavior for ambiguous phrasings and resolving relative dates through the semantic layer's calendar rather than the model's assumptions.

**Query construction error.** The agent wrote SQL or a semantic query that fans out across a join, re-aggregates an average, or bypasses the governed metric by computing it by hand. The more freedom the agent has to write raw SQL, the more common this category is. Fixes include routing agents through a constrained semantic interface and validating that governed metrics are referenced rather than rebuilt.

**Data error.** The computation was right and the data was wrong: a late-arriving batch, a duplicated load, a broken upstream feed. The agent faithfully reported a wrong table. This is a data quality incident that surfaced through the agent. Fix it in the pipeline, and consider having the agent check data quality signals before answering on tables that recently failed checks.

**Cache error.** A cached result was served when it should not have been: stale after a commit, reused across different policies, or keyed without resolving relative dates. Fixes include snapshot-aware freshness checks, permission-aware keys, and sampled recomputation of cache hits.

**Permission error.** The agent returned data the user was not allowed to see, or omitted data they were allowed to see because a filter applied incorrectly. Always SEV1 when data was exposed. Fixes belong in the catalog grants and the engine's policy enforcement, never in prompt instructions.

**Engine or version change.** An engine upgrade changed rounding, null handling, or time zone behavior. Rare, and easy to miss without golden questions that run on every upgrade.

Expect some incidents to span two categories. A metric selection error often hides behind an ambiguous metric description, which is partly a semantic model issue. Record every contributing category, not only the first one you found.

## Prevent Recurrence

Every incident should leave the system harder to break in the same way. Four actions should follow every wrong-number postmortem.

**Add golden questions.** Write at least one golden question that reproduces the failure, with its expected answer computed against frozen data, and add paraphrases. If the incident involved a question pattern nobody anticipated, add several. The next release that reintroduces the problem fails before it ships.

**Add a detection check.** Ask which detection layer should have caught this and why it did not. Add a reconciliation question, a distribution check, or a sampled recomputation rule that flags the same failure within a day.

**Fix the source, not the symptom.** If the agent chose the wrong metric because two metric descriptions were ambiguous, fix the descriptions in the semantic model rather than adding a prompt rule. In an Apache Ossie model, that means clearer `description` and `ai_context` fields on the metrics involved. The fix then helps every model, every tool, and every human reading the model. Prompt patches are brittle and invisible to the people who own the metrics.

**Update the runbook.** If containment was slow because nobody knew how to block a metric for agent use, document it. If the blast radius query took hours because a telemetry field was missing, add the field.

Track these follow-ups to completion. A postmortem whose action items stay open is a postmortem for the next incident too.

## Writing the Postmortem

Wrong-number postmortems follow the usual blameless format, with a few additions specific to data agents.

**Timeline with data versions.** Alongside the usual timestamps, record which release manifest was live, which semantic model commit it pinned, and which table snapshots the affected answers read. Iceberg snapshot IDs make this timeline exact rather than approximate.

**Exposure summary.** The number of affected answers, users, and tenants, the number of answers that led to actions, and the largest error any user saw. Pull these straight from the blast radius queries, and keep the queries in the postmortem so anyone can rerun them.

**Detection gap.** How long the wrong number was live before detection, and which layer detected it. If a user found it, say so plainly. Time to detection is the metric that improves most when teams take wrong-answer incidents seriously.

**Correction record.** When each affected user was notified, and whether actions were reversed. An incident with a fixed agent and unnotified users is still open.

**Contributing categories.** Every root cause category that played a part, with evidence from the reproduction.

**Follow-up actions with owners.** Golden questions added, checks added, semantic model fixes, runbook changes. Each one with a named owner and a date.

Store postmortems where the people who own metrics will read them, not only where engineers do. A metric owner who learns that their metric's description caused three incidents this quarter will rewrite it. A metric owner who never hears about it will not.

## Failure Modes of the Response Process

Incident response itself fails in predictable ways. Watch for these.

**No telemetry, no blast radius.** The agent does not record canonical queries or snapshot IDs, so the only way to find affected users is to ask everyone. The warning sign is a postmortem that says "scope unknown." Fix the telemetry before the next incident.

**Expired snapshots.** Routine snapshot expiration removes the snapshots that answers referenced, so reproduction is approximate. The warning sign is reproductions that run against current data with a caveat. Keep snapshot retention longer than your typical detection delay, and tag snapshots at period close for governed metrics.

**Fixing without correcting.** The agent is fixed, the incident is closed, and nobody tells the people who received the wrong number. The warning sign is a closed incident with no notification record. Make the correction step a required field before closure.

**Over-notification.** The broad first-pass blast radius goes straight to notification, and hundreds of users get a correction for answers that were not affected. Trust drops further. The warning sign is users replying that their numbers were fine. Recompute before notifying.

**Prompt patches as root cause fixes.** The postmortem's main action is a new line in the system prompt. It hides the problem from metric owners and fails again when the prompt changes. The warning sign is a growing list of special-case rules in the prompt. Move fixes into the semantic model, the tools, or the catalog.

**Severity anchored on the first report.** One wrong answer is reported, it is classified SEV4, and nobody runs the blast radius query. The warning sign is a second report of the same pattern a week later. Run the blast radius query for every credible report, no matter how small it looks.

**Evidence destroyed during containment.** Someone flushes every cache and deletes the bad index to stop the bleeding, and the investigation loses its evidence. Contain by blocking and switching, not by deleting.

## Operational Guidance

Put these in place before the first serious incident.

**Instrument every answer.** The telemetry fields listed earlier, in an Iceberg table under the same catalog and grants as the source data. This is the single most important preparation.

**Set retention to match detection.** Keep answer telemetry for at least two reporting cycles, and keep source table snapshots long enough to reproduce any answer within that window. Tag period-close snapshots for governed metrics.

**Build the containment controls.** A way to block a metric or question pattern for agent use without touching dashboards. A way to invalidate caches by metric. A pinned release manifest that makes rollback one change. A banner mechanism.

**Write the blast radius queries in advance.** Parameterized queries for the common causes: by manifest, by metric, by cache entry, by time window. Keep them in the runbook and test them quarterly.

**Run a drill.** Introduce a deliberate, harmless error in a test environment, such as a metric description that encourages the wrong choice, and run the full process: detection, containment, reproduction, blast radius, notification, and postmortem. Time each step. The slowest step tells you what to fix first.

**Agree on severity and ownership with finance and legal.** Decide in advance who gets told about a SEV1, who approves external corrections, and who owns notification for each metric. Deciding this during an incident wastes the first hour.

**Report on wrong-answer incidents.** Count them, track time to detection and time to correction, and share the numbers with leadership alongside the agent's adoption numbers. An honest record of wrong answers, and of how quickly they get fixed, builds more trust than a claim that the agent is always right.

## Where This Is Heading

Three developments will make wrong-answer incident response faster and more precise.

Engines and catalogs are exposing lineage directly. More engines report exactly which table snapshots a query read, and catalogs such as Apache Polaris are building out event streams for commits and access. As that information becomes standard, the most important telemetry fields stop being something each team builds and become something the platform provides.

Semantic models are becoming shared and versioned. With Apache Ossie defining semantic models in an open format, metric definitions live in versioned files with clear history. When a definition change causes an incident, the diff that introduced it is one command away, and every tool using the model can pin to the corrected version.

Agents are learning to say what they computed. Answers that state the metric, the time window, the filters, and the data freshness alongside the number make wrong answers easier to spot at the moment they are given. A user who sees "net revenue, calendar Q3, as of 10:42" can catch a fiscal-quarter mix-up before it reaches a deck.

## Conclusion

Data agents will sometimes give wrong numbers. The question is whether you find out from your own checks or from a board member, and whether you can say exactly who received the wrong number and what the right one was.

That depends on preparation. Record every answer with its canonical query, its release manifest, and the Iceberg snapshot IDs it read. Detect wrong answers with user reports, sampled recomputation, reconciliation against certified numbers, and daily golden questions. Contain by blocking and switching, never by deleting. Reproduce the exact answer with time travel against the recorded snapshots. Find the blast radius with a query, then narrow it with recomputation. Correct every affected user with the exact replacement figures. And fix causes at their source, in the semantic model, the tools, or the catalog, so the same failure cannot ship again.

The open lakehouse is what makes this precise. Iceberg remembers every version of every table, so a three-week-old answer can be reproduced exactly. The telemetry lives in Iceberg tables governed by the same Polaris catalog as the data, so the record is complete and access-controlled. Ossie keeps metric definitions in versioned files, so the definition behind any answer is always recoverable. With those pieces, a wrong number becomes a bounded, fixable incident instead of a lingering doubt about every answer the agent has ever given.

## Keep Going

If this piece was useful, I have written a lot more on building trustworthy AI on top of open lakehouse data. *Apache Iceberg: The Definitive Guide* covers the snapshot, time travel, and tagging features this article relies on for exact reproduction. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
