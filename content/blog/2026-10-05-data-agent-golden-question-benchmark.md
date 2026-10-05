---
title: "How to Build a Golden-Question Benchmark for Your Data Agents"
description: "Build a golden-question benchmark for data agents: frozen Iceberg tags, execution-based scoring with Arrow, and CI gates."
date: 2026-10-05T09:00:00Z
tags: ["evaluation", "AI agents", "Apache Iceberg", "benchmarks"]
canonical: https://iceberglakehouse.com/posts/data-agent-golden-question-benchmark/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/data-agent-golden-question-benchmark/).

A data agent passes its demo. It answers revenue by region, top customers by margin, and churn by cohort, and the numbers match the dashboard. Two weeks later someone changes the system prompt, upgrades the model, and renames a metric in the semantic layer. The agent still answers every question with confidence. Nobody knows whether the answers are still right, because nobody wrote down what right looked like.

That gap is the most common reason data agents stall between pilot and production. Teams test the model once, by hand, against a few questions they happen to remember. Then the system keeps changing underneath them. The model changes, the prompt changes, the tools change, the metric definitions change, and the data changes every hour.

The fix is old and unglamorous. You build a fixed set of questions with known correct answers, you run the agent against it every time anything changes, and you refuse to ship when the score drops. Software engineers call this a regression suite. In the data agent world it goes by golden questions, eval sets, or benchmarks. The name matters less than the discipline.

This article walks through how to build one that holds up: what each question needs to record, how to freeze the ground truth so it stops drifting, how to score answers fairly, how to store results so you can compare runs months apart, and how to gate changes in CI. The open lakehouse turns out to be a very good home for all of it. Apache Iceberg tags freeze the data, Apache Arrow makes result comparison exact, Apache Parquet stores the run history cheaply, and Apache Polaris gives the agent the same permissions in testing that it has in production.

A disclosure before going further: I work at Dremio, which builds a semantic layer and an MCP server that agents use. Everything in this article works with any engine that reads Iceberg tables.

## Why Public Text-to-SQL Benchmarks Will Not Tell You If Your Agent Works

Public benchmarks are the first thing teams reach for, and they are worth understanding. They also answer a different question from the one you have.

The Spider and BIRD benchmarks became the standard yardsticks for text-to-SQL. Each gives a model a natural language question and a database, then checks whether the generated SQL returns the right rows. By late 2024, leading systems scored 91.2 percent execution accuracy on Spider 1.0 and 73.0 percent on BIRD. Those numbers made text-to-SQL look nearly solved.

Spider 2.0 broke that impression. Its authors built 632 workflow problems from enterprise-style databases, with schemas that run past 3,000 columns, multiple SQL dialects such as BigQuery and Snowflake, and multi-step tasks. In the original paper, the strongest traditional text-to-SQL method solved only 5.7 percent of the Spider 2.0-lite questions. An agent framework built on o1-preview solved 17.1 percent of the full agentic tasks, and GPT-4o solved 10.1 percent. Agentic systems have climbed a long way since, with published results above 50 percent on the Snowflake variant, but the gap between academic and enterprise settings remains the headline.

The lesson from Spider 2.0 is useful. Scores collapse when schemas get large, when business meaning lives outside the column names, and when tasks need several steps. That is exactly the situation inside your company.

The limit is that a public benchmark measures a model on somebody else's data. Your agent is not a model. It is a system made of a model, a system prompt, a set of tools, a semantic layer, a catalog with permissions, and your actual tables. A model that ranks first on a leaderboard can still fail your questions, because your questions depend on your definition of active customer, your fiscal calendar, and your rule that refunds come out of net revenue.

So use public benchmarks to shortlist models. Use your own golden questions to decide whether the system works.

## What a Data Agent Evaluation Actually Measures

Before writing a single question, decide what you are grading. A data agent produces several kinds of output, and each needs its own check.

**The answer.** This is the number, table, or short narrative the user sees. It is the thing that matters most and the thing teams most often grade by eye.

**The query.** This is the SQL, the semantic layer request, or the sequence of tool calls the agent made. Two different queries can produce the same correct answer, so you rarely grade the query text directly. You inspect it to explain failures and to check rules, such as whether the agent used the governed metric or rebuilt it by hand.

**The behavior.** Some questions should not get an answer. A question with no safe interpretation should get a clarifying question back. A question about data the user cannot see should get a refusal. A question the data cannot answer should get an honest "I can't answer that from this data." An agent that invents a number in any of these cases has failed, even if the invented number looks reasonable.

**The cost and latency.** An agent that gets the right answer after 14 tool calls and 90 seconds is worse than one that gets it in two calls and 6 seconds. You track tokens, tool calls, wall-clock time, and bytes scanned for every question, because those numbers move whenever you change the model or the prompt.

**The safety properties.** The agent must never read a table its principal cannot read, never write when the task is read-only, and never leak a value from a masked column. These are pass or fail. One violation fails the run.

Most teams start by grading only answers. That is fine for week one. By the time the agent reaches real users, you want all five, because the failures that hurt in production are usually behavioral. An agent that answers an ambiguous question confidently does more damage than one that sometimes gets a hard question wrong.

## Anatomy of a Golden Question

A golden question is more than a question and an answer. It is a small record that holds everything needed to grade the agent fairly a year from now, when the person who wrote it has moved teams.

Here is what each record should hold.

**An identifier and an owner.** Every question gets a stable ID and a named owner who can explain it. When a question starts failing, someone has to decide whether the agent broke or the question is stale.

**The question text, plus paraphrases.** Users never phrase things the same way twice. Store the canonical phrasing and two or three paraphrases. "Revenue by region last quarter," "How much did each region bring in during Q3," and "Q3 sales split by region" should all produce the same answer. An agent that passes the canonical wording and fails the paraphrases has memorized a prompt pattern, not learned the business.

**The expected behavior.** One of answer, clarify, refuse, or cannot answer. This field is what lets you grade the behavioral cases.

**The expected result.** For answer questions, the exact result: rows, columns, and values. Store it as data, not as prose. A Parquet file per question, or rows in an Iceberg table, works well.

**The comparison rules.** Whether row order matters, which columns are required, how much numeric tolerance is allowed, and whether extra columns are acceptable. "Top 5 products by revenue" needs ordering. "Revenue by region" does not.

**The data reference.** The exact table versions the expected result was computed against. This is the field most teams forget, and it is the one that makes the whole suite trustworthy. The next section covers it in detail.

**The metric references.** The governed metric names the question depends on, such as `net_revenue` or `active_customers`. When a metric definition changes, you know exactly which questions to review. If your semantic models are written in Apache Ossie, the open specification for semantic model interchange, these names point straight into the model file.

**The category and difficulty.** Tags such as single-table aggregation, multi-fact join, time comparison, ranking, ambiguous, out-of-scope, and permission boundary. Categories let you see where a regression happened. A score that holds at 88 percent overall while multi-fact joins drop from 80 to 40 percent is a real regression hiding inside a stable average.

**The rationale.** One or two sentences on why the expected answer is correct. "Net revenue excludes refunds processed in the same fiscal quarter" saves an hour of archaeology later.

Here is what a record looks like in YAML before it gets loaded into a table.

```yaml
id: GQ-0142
owner: finance-analytics
question: "What was net revenue by region in fiscal Q3 2026?"
paraphrases:
  - "How much net revenue did each region book in Q3 FY26?"
  - "Q3 FY2026 net revenue split by region"
expected_behavior: answer
expected_result: gq/GQ-0142.parquet
comparison:
  ordered: false
  required_columns: [region, net_revenue]
  numeric_tolerance: 0.005   # relative, half a percent
  allow_extra_columns: true
data_refs:
  - table: sales.orders
    tag: golden-2026-10
  - table: sales.refunds
    tag: golden-2026-10
metrics: [net_revenue]
category: multi_fact_join
difficulty: medium
rationale: >
  Net revenue subtracts refunds processed in the same fiscal quarter.
  Fiscal Q3 2026 runs July 1 through September 30.
```

Notice that the expected result lives in a separate Parquet file and the data references name a tag rather than a date. Both choices exist so the record never has to change when the underlying tables do.

## Freezing the Ground Truth With Iceberg Tags

Here is the problem that quietly ruins most homegrown eval sets. Production tables change. A late-arriving order lands in September after you computed September revenue. A backfill corrects a currency conversion. A deduplication job removes 400 rows. The agent runs the same correct query it always ran, gets a different number, and fails. Your score drops, and nothing about the agent changed.

Teams usually respond in one of three ways, and two of them are bad.

The first bad option is to recompute expected answers on every run. That turns the benchmark into a comparison of the agent's query against your reference query on the same data. It catches some failures, but it hides a whole class of them, because a bug in the reference query and the same bug in the agent's query agree with each other.

The second bad option is to copy the data into a separate eval database. Copies go stale, cost storage, and drift from production schemas. Six months later the eval database has a column the production table dropped, and the agent learns habits that do not transfer.

The good option is to freeze the exact table versions the expected answers were computed against, and to have the agent query those versions during evaluation. Apache Iceberg makes this cheap, because every commit to an Iceberg table creates a snapshot, and a tag is a named, retained pointer to one snapshot.

In Spark SQL with the Iceberg extensions, creating the tags looks like this.

```sql
-- Freeze the current state of each table the golden set depends on.
ALTER TABLE sales.orders  CREATE TAG `golden-2026-10` RETAIN 400 DAYS;
ALTER TABLE sales.refunds CREATE TAG `golden-2026-10` RETAIN 400 DAYS;
ALTER TABLE sales.regions CREATE TAG `golden-2026-10` RETAIN 400 DAYS;

-- Compute an expected answer against the frozen versions.
SELECT r.region_name AS region,
       SUM(o.amount) - COALESCE(SUM(f.refund_amount), 0) AS net_revenue
FROM   sales.orders  VERSION AS OF 'golden-2026-10' o
JOIN   sales.regions VERSION AS OF 'golden-2026-10' r ON o.region_id = r.region_id
LEFT JOIN sales.refunds VERSION AS OF 'golden-2026-10' f ON f.order_id = o.order_id
WHERE  o.order_date BETWEEN DATE '2026-07-01' AND DATE '2026-09-30'
GROUP BY r.region_name;
```

Walk through what each piece does.

`CREATE TAG` adds a named reference to the table's current snapshot. Without an `AS OF VERSION` clause, it points at whatever snapshot is current when the statement runs. You run the three statements back to back so the tables line up in time.

`RETAIN 400 DAYS` sets how long the tag lives. Snapshot expiration jobs skip tagged snapshots until the tag ages out, so the frozen data survives your nightly maintenance. A tag created without `RETAIN` lives until someone drops it. Pick a retention that outlives the eval set's useful life, and plan to cut a new tag each quarter rather than keeping one forever.

`VERSION AS OF 'golden-2026-10'` reads the table as of the tagged snapshot. The query computing the expected answer and the agent's query both see exactly the same rows, today and next year.

The reference query above is deliberately naive about one thing so you can see it. Joining refunds to orders before summing inflates order amounts when an order has more than one refund. That is precisely the kind of mistake that hides when you recompute expected answers with a reference query. Compute expected answers carefully, have a second person check the hard ones, and record the reviewed query alongside the result. Once it is right, it stays right, because the data under it no longer moves.

Two practical details make this work smoothly.

**Point the agent at the tag during evaluation.** The cleanest way is to run the evaluation through the same semantic layer and tools the agent uses in production, with the eval runner injecting the tag as the read reference. Some engines take a session-level setting for this. Others need the tag in the table reference. Whatever your engine supports, the goal is that the agent's prompt and tools stay identical to production while the data under them stays frozen.

**Keep a branch for edge cases.** Some questions need data that real tables do not contain yet, such as a region with zero orders, a customer with a refund larger than the order, or a NULL foreign key. Create an Iceberg branch, insert the synthetic edge-case rows there, and tag that branch state for the eval set. Production never sees the synthetic rows, and the golden questions get the hard cases they need.

Because all of this happens in table metadata, none of it copies data files. A tag on a 4 TB table costs the storage of the snapshot it pins, which is already there, plus the data files that expiration skips while the tag holds them. That cost is real over a long retention window, so watch it, but it is far smaller than a copied eval database.

## Where Good Golden Questions Come From

The hardest part of building the suite is not the code. It is writing questions that represent what users will actually ask. A suite of 200 questions that all look like "total X by Y" will score well and tell you almost nothing.

Pull questions from five sources, and aim for a mix.

**Query logs and dashboard definitions.** Your BI tools already record the questions the business asks most. The SQL behind your top 30 dashboard tiles is a ready-made list of high-value questions with reviewed answers. Rewrite each as the sentence a person types, then compute the answer against your frozen tags.

**The metric catalog.** Every governed metric deserves at least two questions: one simple slice and one that combines it with something else. If you define `net_revenue`, `active_customers`, and `churn_rate`, you want questions that ask for each by itself and questions such as "net revenue per active customer by segment," which forces the agent to combine metrics at the right grain.

**Known failure patterns.** Fan-out joins, chasm traps between two fact tables, averages of averages, fiscal versus calendar periods, NULL handling in filters, and timezone boundaries all produce queries that run cleanly and return wrong numbers. Write at least one question that triggers each pattern. These are the questions most likely to catch a regression after a model upgrade.

**Real user transcripts.** Once the agent has users, their questions become your best source. Sample them weekly, especially the ones that got thumbs down, follow-up corrections, or long retry chains. Strip personal data, compute the right answer, and add them.

**Deliberately bad questions.** Add questions that should not get a number. "What will revenue be next year?" when the agent has no forecasting tool. "Show me salaries by employee" when the test principal cannot read the HR schema. "Revenue for the Pluto region" when no such region exists. "How are we doing?" with no metric named. Each has an expected behavior of refuse, cannot answer, or clarify.

How many questions do you need? Start with 50 good ones rather than 500 sloppy ones. Fifty questions spread across ten categories gives five per category, which is enough to see a category collapse but not enough to measure small changes. Grow toward 150 to 300 as the agent matures. Past that point, the cost of keeping expected answers correct starts to exceed the value of each new question.

Keep the mix roughly balanced. A reasonable starting split is 50 percent straightforward questions users ask daily, 25 percent harder multi-step or multi-fact questions, 15 percent ambiguous questions that should trigger clarification, and 10 percent out-of-scope or permission-boundary questions. Adjust the split to match what your users actually send.

One more rule: never let the agent's own output become an expected answer without human review. It is tempting to run the agent, eyeball the results, and save whatever looks right as the new golden answer. That process bakes the agent's mistakes into the benchmark, and the suite stops being able to catch them.

## Scoring Answers Fairly

Scoring is where most homegrown benchmarks quietly cheat. A string comparison of the agent's SQL against reference SQL fails correct answers written differently. A loose "does this look similar" check passes wrong answers that happen to share column names. You want execution-based scoring: run the agent's query, take its result set, and compare that result set to the expected one under the question's comparison rules.

This is the approach the research benchmarks settled on. Spider 2.0 counts a SQL answer correct when it returns the same multiset of rows as the reference. A multiset comparison ignores row order but respects duplicates, which matches how SQL results behave without an `ORDER BY`.

Real questions need a few more rules on top of that.

**Column matching.** Agents name columns freely. One writes `net_revenue`, another writes `revenue_net`, a third writes `total`. Match columns by position after required-column alignment, or by value where names differ, rather than requiring exact names.

**Numeric tolerance.** Floating point sums differ in the last digits across engines and execution plans. A relative tolerance of 0.1 to 0.5 percent absorbs that without letting real errors through. Exact match on integers and strings stays strict.

**Ordering.** When the question asks for a ranking or a top N, row order is part of the answer. Compare in order. Otherwise sort both sides before comparing.

**Extra columns and rows.** An agent that returns `region`, `net_revenue`, and `order_count` when you asked for net revenue by region has added helpful context, not an error. Allow extra columns when the question permits. Extra rows are almost always an error.

Apache Arrow is a good fit for this step. Most engines can return results as Arrow tables, through Arrow Flight, ADBC, or their Python clients, which means the expected result loaded from Parquet and the agent's result arrive in the same in-memory columnar format. No CSV round trip, no type guessing, no float formatting differences.

Here is a compact comparator built on PyArrow.

```python
import math
import pyarrow as pa
import pyarrow.compute as pc

def normalize(table: pa.Table, columns: list[str]) -> list[tuple]:
    """Keep the required columns, round floats to a stable precision, return rows."""
    table = table.select(columns)
    rows = []
    for row in table.to_pylist():
        rows.append(tuple(
            round(v, 6) if isinstance(v, float) else v
            for v in (row[c] for c in columns)
        ))
    return rows

def values_match(a, b, rel_tol: float) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return math.isclose(float(a), float(b), rel_tol=rel_tol, abs_tol=1e-9)
    return a == b

def align_columns(actual: pa.Table, expected: pa.Table, required: list[str]) -> pa.Table:
    """Rename actual columns to expected names when names differ but types line up."""
    if all(c in actual.column_names for c in required):
        return actual
    renamed = {}
    remaining = [c for c in actual.column_names]
    for col in required:
        target_type = expected.schema.field(col).type
        match = next((c for c in remaining
                      if actual.schema.field(c).type == target_type), None)
        if match is None:
            raise ValueError(f"no column in result matches required column {col}")
        renamed[match] = col
        remaining.remove(match)
    return actual.rename_columns([renamed.get(c, c) for c in actual.column_names])

def compare(actual: pa.Table, expected: pa.Table, rules: dict) -> tuple[bool, str]:
    required = rules["required_columns"]
    try:
        actual = align_columns(actual, expected, required)
    except ValueError as err:
        return False, str(err)

    if not rules.get("allow_extra_columns", True) and actual.num_columns != len(required):
        return False, "unexpected extra columns"
    if actual.num_rows != expected.num_rows:
        return False, f"row count {actual.num_rows} != expected {expected.num_rows}"

    got = normalize(actual, required)
    want = normalize(expected, required)
    if not rules.get("ordered", False):
        key = lambda r: tuple("" if v is None else str(v) for v in r)
        got, want = sorted(got, key=key), sorted(want, key=key)

    tol = rules.get("numeric_tolerance", 0.0)
    for i, (g, w) in enumerate(zip(got, want)):
        if not all(values_match(x, y, tol) for x, y in zip(g, w)):
            return False, f"row {i} differs: got {g}, expected {w}"
    return True, "match"
```

Walk through the pieces.

`normalize` keeps only the columns the question requires, converts each row to a tuple, and rounds floats to six decimal places so that tiny representation differences do not break the sort order. Comparing tuples of Python values is slower than a pure Arrow kernel, but golden-question results are small, usually a few dozen rows, so clarity wins.

`values_match` applies the relative tolerance to numbers and exact equality to everything else. The `abs_tol` term keeps comparisons against zero from failing on floating point noise.

`align_columns` handles agents that name columns differently. If all required names exist, nothing happens. Otherwise, it maps each required column to the first unused result column of the same Arrow type. This is a heuristic, so it errs strict: when no column of the right type exists, the question fails with a clear reason.

`compare` checks row counts first, because a wrong row count is the most common and cheapest failure to detect. Then it sorts both sides unless order matters, and walks rows pairwise. The returned message is the part you will read most, because it tells you exactly how the answer went wrong.

**Behavioral questions get a different grader.** For clarify, refuse, and cannot-answer cases, there is no result set to compare. Grade on what the agent did. Did it return a clarifying question instead of a number? Did the tool layer record a permission denial? Did the agent decline to fabricate? A small classifier works here, and so does a language model used as a judge with a strict rubric, as long as you validate the judge.

**Use language model judges narrowly.** A judge model is useful for grading the narrative part of an answer, such as whether a summary states the right trend, or for classifying behavior. It is a poor grader of numbers, because it will accept a plausible figure that is off by 12 percent. Keep numeric grading deterministic. When you do use a judge, write the rubric as specific yes or no checks, hand-label 50 graded examples, and confirm the judge agrees with your labels at least nine times out of ten before trusting it.

**Score with partial credit, report without it.** It helps to record why a question failed: wrong row count, wrong value, wrong order, wrong behavior, error, or timeout. For the headline number, keep it binary. A question passes or it fails. Averages of partial credit make regressions look smaller than they are.

## Running the Suite and Keeping the History

The runner itself is simple. It loads the golden questions, points the agent at the frozen data, asks every question and paraphrase, scores the results, and writes everything down. The part that pays off over time is the writing down.

Store every run in an Iceberg table. Each row is one question attempt, with the run's full configuration attached. Six months from now, someone will ask whether the new model is better than the one you used in March. With the history in a table, that question is a SQL query.

Here is a trimmed runner using PyIceberg against an Apache Polaris REST catalog.

```python
import hashlib
import time
import uuid
from datetime import datetime, timezone

import pyarrow as pa
import pyarrow.parquet as pq
from pyiceberg.catalog import load_catalog

catalog = load_catalog(
    "polaris",
    **{
        "type": "rest",
        "uri": "https://polaris.example.com/api/catalog",
        "warehouse": "analytics",
        "credential": "eval-runner-client-id:eval-runner-secret",
        "scope": "PRINCIPAL_ROLE:eval_runner",
    },
)
runs = catalog.load_table("evals.agent_runs")

def run_suite(agent, questions, config: dict) -> pa.Table:
    run_id = str(uuid.uuid4())
    prompt_hash = hashlib.sha256(config["system_prompt"].encode()).hexdigest()[:16]
    records = []

    for q in questions:
        expected = pq.read_table(q["expected_result"]) if q["expected_behavior"] == "answer" else None
        for phrasing in [q["question"], *q.get("paraphrases", [])]:
            started = time.monotonic()
            response = agent.ask(phrasing, data_tag=config["data_tag"])
            elapsed_ms = int((time.monotonic() - started) * 1000)

            if q["expected_behavior"] == "answer":
                if response.result is None:
                    passed, reason = False, f"no result, behavior={response.behavior}"
                else:
                    passed, reason = compare(response.result, expected, q["comparison"])
            else:
                passed = response.behavior == q["expected_behavior"]
                reason = f"behavior={response.behavior}"

            records.append({
                "run_id": run_id,
                "run_at": datetime.now(timezone.utc),
                "question_id": q["id"],
                "phrasing": phrasing,
                "category": q["category"],
                "passed": passed,
                "reason": reason,
                "model": config["model"],
                "prompt_hash": prompt_hash,
                "semantic_model_version": config["semantic_model_version"],
                "data_tag": config["data_tag"],
                "generated_query": response.query_text,
                "tool_calls": response.tool_calls,
                "input_tokens": response.input_tokens,
                "output_tokens": response.output_tokens,
                "latency_ms": elapsed_ms,
            })

    batch = pa.Table.from_pylist(records, schema=runs.schema().as_arrow())
    runs.append(batch)
    return batch
```

Walk through it.

The catalog block connects PyIceberg to a Polaris REST catalog. The `credential` field holds a client ID and secret for a dedicated principal, and `scope` requests the principal role the runner should act under. Give the eval runner its own principal with read access to the tagged tables and write access to the `evals` namespace, and nothing more. That way, permission-boundary questions test the same rules the agent faces in production.

`prompt_hash` turns the system prompt into a short fingerprint. Prompts are long and change often, so you store the hash on every row and keep the full prompt text in version control. When scores move, the hash tells you which prompt version produced each result.

The inner loop asks the canonical question and every paraphrase. Each phrasing becomes its own row, so you can see whether the agent understands the question or only the wording.

`agent.ask` is whatever interface your agent exposes. The important argument is `data_tag`, which tells your tool layer to read the frozen table versions instead of the current ones. The response object carries the result as an Arrow table, the observed behavior, the generated query, and usage counters.

Answer questions go through the comparator from the previous section. Behavioral questions compare the observed behavior to the expected one.

The final two lines convert the records to an Arrow table with the target table's schema and append them as a single Iceberg commit. One commit per run keeps the table's snapshot history readable: each snapshot is one evaluation run.

The `evals.agent_runs` table needs a schema that matches the record fields. Partition it by day of `run_at`, and it stays fast to query for years. With history in place, questions like these become one query each:

```sql
-- Pass rate by category for the last two runs of each model.
SELECT model, category,
       AVG(CASE WHEN passed THEN 1.0 ELSE 0.0 END) AS pass_rate,
       COUNT(*) AS attempts
FROM evals.agent_runs
WHERE run_at >= current_date - INTERVAL '30' DAY
GROUP BY model, category
ORDER BY category, pass_rate DESC;
```

Because the table is Iceberg, any engine you already run can read it: Spark, Trino, DuckDB, Dremio, or a notebook with PyIceberg. The eval history is not locked inside an observability vendor or a spreadsheet. It sits next to the data the agent queries, under the same catalog and the same access controls.

## Gating Changes in CI

A benchmark that runs only when someone remembers to run it catches nothing. Wire it into the same pipeline that ships agent changes, and make it block merges.

Four kinds of change should trigger a run: a new model or model version, any edit to the system prompt or tool descriptions, any change to the semantic model, and any change to the tool layer's code. Data changes do not trigger a run, because the suite reads frozen tags. That is the point of the tags.

Set three gates, not one.

**An overall floor.** The pass rate across all questions must not drop below a fixed threshold, for example 85 percent. This catches broad breakage.

**Per-category regression limits.** No category is allowed to drop more than a set amount compared to the last accepted run, for example 10 percentage points. This catches the quiet failure where one category collapses while the average holds.

**Zero tolerance on safety.** Any permission violation, any write during a read-only task, and any unmasked value from a masked column fails the build, whatever the overall score.

Language models produce different output across runs, even at low temperature, so a single run is noisy. Run the suite three times per change and gate on the median pass rate. Track flakiness per question: a question that passes in two of three runs is telling you the agent is unsure, which is worth knowing even when the median looks fine. Questions that flip often are good candidates for prompt work, better metric descriptions, or a clarifying question in the agent's behavior.

Budget the cost. A suite of 200 questions with three paraphrases each, run three times, is 2,400 agent conversations per change. At a few thousand tokens per conversation, that adds up fast with a frontier model. Two habits keep it under control. Run a 40-question smoke subset on every pull request and the full suite before release. And record token counts per run, so you see cost regressions the same way you see accuracy regressions. An agent that holds its score but doubles its tokens per question has still regressed.

When a gate fails, the run history tells you where to look. Filter the latest run to failed rows, group by `reason`, and compare `generated_query` against the last passing run for the same question. Most regressions explain themselves within a few rows.

## Failure Modes and Warning Signs

Golden-question suites fail in predictable ways. Watch for these.

**Moving ground truth.** The suite reads live tables instead of tags, or the tags expired. The warning sign is a score that drifts between runs when nothing about the agent changed. Check that every data reference resolves to a tag, and alert when a tag is within 30 days of its retention limit.

**Benchmark overfitting.** People tune the prompt against the golden questions until the score climbs, and the agent gets worse at everything else. The warning sign is a rising suite score while user satisfaction or production correction rates stay flat. Hold back 20 percent of questions as a blind set that prompt authors never see, and report both scores. When the visible set improves and the blind set does not, you are overfitting.

**Stale expected answers.** A metric definition changes on purpose, for example net revenue starts excluding a new refund type, and the golden answers still reflect the old rule. The agent follows the new definition correctly and fails. The warning sign is a cluster of failures that all reference the same metric right after a semantic model change. This is why each question records its metric references. When a metric changes, recompute and re-review exactly those questions.

**A suite that is too easy.** Everything passes, so the suite never blocks anything, so nobody trusts it. If your pass rate sits above 97 percent for a month, add harder questions from recent user transcripts and from known failure patterns.

**Graders that agree with the agent.** A judge model that shares the agent's blind spots passes the same wrong answers the agent produces. The warning sign is a judge pass rate far above your deterministic pass rate on similar questions. Validate judges against hand labels, and keep numeric grading out of their hands.

**Tests that pass through the wrong path.** The agent gets the right number by bypassing the semantic layer and writing raw SQL against physical tables. The answer is correct today and breaks the next time the metric definition changes. The warning sign is generated queries that aggregate columns the semantic model defines as governed metrics. Add a rule check alongside the answer check, and fail the question when the agent rebuilt a governed metric by hand.

**Silent permission drift.** The eval runner's principal gets broader access than the production agent, usually because someone granted it extra rights to debug something. Permission-boundary questions start passing for the wrong reason. Manage the eval principal's grants in code next to the production principal's grants, and diff them in CI.

**Paraphrase blindness.** The canonical phrasing passes and the paraphrases fail. The agent has latched onto surface wording, often because examples in the prompt look too much like the golden questions. The warning sign is a large gap between canonical and paraphrase pass rates. Report them separately.

## Operational Guidance

Here is a practical path from nothing to a suite that blocks bad releases.

**Week one: 50 questions and one tag.** Pick the ten metrics that matter most. Write five questions per metric across the categories above. Tag the tables those questions touch. Compute and review every expected answer. Run the agent once and record the results in an Iceberg table. You now have a baseline, which is more than most teams have.

**Weeks two to four: wire it into CI.** Add the smoke subset to pull requests and the full run to releases. Set the three gates. Start recording cost and latency per question.

**Month two: add behavior and safety.** Add clarify, refuse, and cannot-answer questions. Create a dedicated eval principal in Polaris with production-equivalent grants, and add permission-boundary questions that test them. Add the governed-metric rule check.

**Every quarter: refresh the ground truth.** Cut a new tag, recompute expected answers, and have owners review the diffs. Retire questions nobody can explain. Add questions from the quarter's user transcripts. Drop the old tag after the new baseline is accepted, so the old snapshots can expire.

**Ownership.** Assign each question category to a team that owns the underlying metrics. The data team owns the suite's mechanics. The metric owners own the answers. When a question fails because the business changed, the owner fixes the question. When it fails because the agent changed, the agent's maintainers fix the agent.

**Sizing.** The run history table grows by one row per question attempt. Two hundred questions, three paraphrases, three runs per change, and ten changes a week is about 18,000 rows a week. That is trivial for Iceberg. Run compaction on it monthly with the rest of your tables and it stays fast for years.

**Reuse the suite for model selection.** When a new model comes out, run the full suite against it before anyone argues about leaderboards. The question "is this model better for us" stops being an opinion and becomes a row in a table. This is especially useful when you are weighing a smaller, cheaper model for part of the agent's work, because the per-category breakdown shows exactly which tasks the smaller model handles and which it does not. I walk through that decision, step by step, in [Small Language Models for Data Agents: Where They Win and Where They Fail](https://datalakehousehub.com/blog/small-language-models-data-agents/).

## Where This Is Heading

Three developments are pushing golden-question practice from a team habit toward shared infrastructure.

The first is the semantic layer standard. Apache Ossie defines semantic models in a vendor-neutral YAML and JSON format, and its community roadmap includes AI-oriented additions such as standard `ai_context` metadata and verified queries as spec-level constructs. Its working groups are also building compliance suites that pin down how a semantic query should behave across implementations. When verified questions and expected behaviors live inside the same open model file as the metric definitions, golden questions stop being a side project and travel with the semantics they test.

The second is that benchmarks are moving toward the shape of real agent work. Spider 2.0 already evaluates multi-step workflows, and newer variants test AI functions inside SQL. That is a sign the research community has accepted what production teams learned the hard way: the unit of evaluation is the workflow, not the single query.

The third is the convergence of evaluation data and lakehouse data. Agent runs, telemetry, prompts, and expected answers are all just tables. Keeping them in Iceberg, governed by the same catalog as the business data, means the people who own the metrics can see how agents use them, and the people who own the agents can see what the metrics mean. No separate eval platform has to keep those two worlds in sync.

## Conclusion

A data agent is a system that changes constantly, and the only way to know it still works is to ask it the same questions with known answers every time something moves. Public benchmarks such as Spider 2.0 show why this matters: accuracy that looks solved on academic datasets drops sharply on enterprise-shaped work. They cannot tell you whether your agent understands your business. Your own golden questions can.

Build each question as a full record, with paraphrases, an expected behavior, comparison rules, metric references, and a pointer to frozen data. Freeze the data with Iceberg tags so the ground truth never drifts. Score with execution-based comparison over Arrow results, and keep language model judges away from numbers. Store every run in an Iceberg table so any engine can answer "did this change make things better." Then gate every model, prompt, and semantic model change on the results.

None of this needs new infrastructure. If you run an open lakehouse, you already have the pieces: tables that remember their history, a catalog that enforces the same permissions in testing as in production, and a columnar format that makes comparing results exact. The work is writing good questions and refusing to ship when they fail.

## Keep Going

If this piece was useful, I have written a lot more on making AI systems trustworthy on top of lakehouse data. *Evaluating AI Systems: Testing LLMs, RAG, and Agents* goes further into test design, judge validation, and evaluation pipelines for agents. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
