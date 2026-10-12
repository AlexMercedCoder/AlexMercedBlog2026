---
title: "Schema Pruning and Few-Shot SQL Selection for Data Agents Facing Thousands of Columns"
description: "How data agents prune enterprise schemas down to the columns that matter, ground filter values, and pick few-shot SQL examples with the right shape."
date: 2026-10-12T09:00:00Z
tags: ["data agents", "text-to-SQL", "context engineering", "Apache Iceberg", "retrieval"]
canonical: https://datalakehousehub.com/blog/schema-pruning-few-shot-sql-data-agents/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/schema-pruning-few-shot-sql-data-agents/).

A data agent works fine in the demo. The demo database has six tables and forty columns, and the agent writes correct SQL for nearly every question. Then the team points it at the real lakehouse: 340 tables, 9,000 columns, three different tables with a column called `status`, and a `cust_id` that means something different in the billing schema than in the CRM schema. Accuracy falls apart. Token bills climb. The agent starts joining tables that have nothing to do with each other.

The usual first fix is to paste more schema into the prompt. That makes things worse. The model now reads thousands of irrelevant columns for every question, and the few columns that matter get lost in the noise.

The fix that works is the opposite: give the model less. Retrieve the handful of tables a question needs, keep only the columns that matter, add the join keys that connect them, ground the filters in real values, and show the model two to four worked examples whose SQL has the right shape. This article walks through each of those steps, with working Python, and covers how they fail in production.

This piece is a narrow, practical companion to [Context Engineering for Data Agents](https://datalakehousehub.com/blog/context-engineering-for-data-agents/), which explains why text-to-SQL accuracy collapses on enterprise schemas and what kinds of context agents need. Here the focus is the mechanics of pruning a schema and choosing examples.

A disclosure: I work at Dremio, which builds an AI Semantic Layer that agents use for business context. The techniques below are engine-neutral and work over any catalog that exposes table and column metadata.

## Why Full-Schema Prompts Fail

There are three separate reasons, and they compound.

### The schema does not fit, or barely fits

Enterprise schemas are large. The Spider 2.0 benchmark, published at ICLR 2025, built 632 text-to-SQL problems from real enterprise database use cases, and its databases often exceed 1,000 columns. Even when a schema technically fits in a model's context window, sending all of it with every question costs real money. A column described in 30 tokens times 9,000 columns is 270,000 tokens before the question even appears.

### Models read long contexts unevenly

Language models do not use every part of a long prompt equally. Research by Liu and colleagues, published as "Lost in the Middle," showed that models find relevant information more reliably at the start or end of a long context than in the middle. A full schema dump puts the three columns that matter somewhere in the middle of thousands that do not.

### Irrelevant columns act as distractors

The worst problem is not missing information. It is confusing information. When a prompt contains `orders.status`, `shipments.status`, and `tickets.status`, the model has to pick one. When it contains `revenue`, `net_revenue`, `recognized_revenue`, and `revenue_usd`, it has to guess which one the business means. Every irrelevant but plausible column is a chance to pick wrong.

The Spider 2.0 results make the cost concrete. The best setup in the paper, an o1-preview based agent, solved 21.3% of the tasks. The same family of approaches scores 91.2% on the original Spider benchmark and 73.0% on BIRD, both of which use far smaller schemas. The authors identified schema linking, the step of finding the right tables and columns, as a major source of errors on large schemas.

Pruning attacks all three problems. The CHESS system from Stanford researchers, which targets large real-world databases, tested its schema selection stage on a database with over 4,000 columns. Pruning the schema improved accuracy by about 2 percentage points while cutting the tokens sent to the model by roughly five times. Five times fewer tokens with better accuracy is the trade every team building a data agent wants.

## The Pipeline at a Glance

Schema pruning and example selection fit into a pipeline with an offline half and an online half.

The offline half builds indexes. It harvests table and column metadata from your catalog, including names, types, descriptions, and a few sample values for categorical columns. It embeds a text description of each column into vectors. It records join relationships between tables. It collects a library of verified question and SQL pairs to use as examples. This work runs on a schedule and whenever schemas change.

The online half runs for every question:

1. **Retrieve candidate tables.** Score every column against the question and roll the scores up to tables. Keep the top few tables.
2. **Expand join paths.** If the chosen tables do not connect directly, add the bridge tables that connect them, along with the join keys.
3. **Prune columns.** Within each kept table, keep only the columns that score well against the question, plus every join key.
4. **Ground values.** For filter terms in the question, such as "EMEA" or "enterprise tier," look up the actual values stored in the relevant columns.
5. **Select examples.** Find two to four verified examples whose questions resemble this one in intent and whose SQL has different shapes.
6. **Assemble and generate.** Build a compact prompt from the pruned schema, join keys, grounded values, and examples, and ask the model for SQL.
7. **Validate.** Parse the SQL, check that every referenced table and column exists in the pruned schema, and run it with limits.

Each step narrows the context. The result is a prompt of a few thousand tokens that contains almost everything the model needs and almost nothing it does not.

## Building the Schema Index

The quality of retrieval depends on what you index. A column name alone is a poor search target. `amt_2` tells a retriever nothing. A column with a description, a type, and example values tells it a lot.

### What to put in each column document

Build one text document per column with these parts:

- **Qualified name.** The namespace, table, and column, such as `sales.orders.order_total`. Table names carry meaning that column names lack.
- **Type.** `decimal(12,2)` and `timestamp` help the model and the retriever separate measures from dimensions and dates.
- **Description.** The column's documentation, written for humans. This is the single most valuable field.
- **Table description.** A short summary of what the table holds, since a column inherits meaning from its table.
- **Sample values for categorical columns.** Five or so distinct values for low-cardinality string columns. "EMEA, APAC, NA" makes a `region` column findable for a question that mentions "Europe."

Skip sample values for high-cardinality or sensitive columns. You do not want customer emails in an embedding index, and they do not help retrieval anyway.

### Where descriptions come from

Apache Iceberg stores an optional `doc` string on every schema field, and table comments live in the table's `comment` property. Engines expose these when you write `COMMENT` clauses in DDL. If your team never filled them in, start now. Documentation is the cheapest accuracy improvement available for a data agent.

Semantic layers are the other major source. A semantic layer describes business entities, metrics, and relationships in terms people use. Apache Ossie, an incubating Apache project, is defining an open format for semantic models, and catalogs such as Apache Polaris now store semantic models with their own access privileges. Dremio's AI Semantic Layer exposes wikis and labels on datasets for the same purpose. Whatever tool holds your business definitions, pull its descriptions into the index.

### Harvesting from an Iceberg catalog

Here is a harvesting function that uses PyIceberg to read column names, types, and docs from every table in a catalog. It works with any catalog PyIceberg supports, including REST catalogs such as Polaris.

```python
from dataclasses import dataclass, field


@dataclass
class ColumnDoc:
    table: str
    name: str
    type: str
    doc: str = ""
    sample_values: list = field(default_factory=list)

    def text(self) -> str:
        values = ", ".join(map(str, self.sample_values[:5]))
        return f"{self.table}.{self.name} ({self.type}): {self.doc} Examples: {values}"


def harvest_iceberg_schema(catalog) -> list[ColumnDoc]:
    """Pull column names, types, and docs from every table in a PyIceberg catalog."""
    columns = []
    for namespace in catalog.list_namespaces():
        for identifier in catalog.list_tables(namespace):
            table = catalog.load_table(identifier)
            table_name = ".".join(identifier)
            table_comment = table.properties.get("comment", "")
            for f in table.schema().fields:
                doc = f.doc or ""
                if table_comment:
                    doc = f"{doc} Table: {table_comment}".strip()
                columns.append(ColumnDoc(table_name, f.name, str(f.field_type), doc))
    return columns
```

The `ColumnDoc` class holds everything the index needs about one column, and its `text()` method produces the document that gets embedded. The harvester walks namespaces, lists tables in each, loads each table, and reads its current schema. `f.doc` is the Iceberg field documentation, and the table's `comment` property gets appended so every column carries its table's context. This version reads top-level fields only. Tables with deeply nested structs need a recursive walk, with dotted paths as column names.

Sample values come from a separate step. For each string column, run a query such as `SELECT DISTINCT region FROM crm.customers LIMIT 20` and keep the column only if the distinct count stays small. Run this step through an account with read access limited to what agents are allowed to see.

### Nested structs and Variant columns

Lakehouse tables often hold nested data. An Iceberg `struct` column can contain dozens of fields, and a format version 3 `variant` column can hold JSON with fields that differ from row to row. Both break the simple one-document-per-column model.

For structs, flatten the field tree into dotted paths, such as `events.payload.device.os`, and index each leaf field as its own document with its own description. The model then sees exactly the leaf it needs, written the way SQL references it. Keep the parent struct's description in each child document so context carries down.

Variant columns have no fixed schema to harvest. Sample them instead. Pull a few thousand rows, extract the field paths that appear frequently, and index those paths with their observed types. Mark these documents as sampled, since a field present in the sample can be missing in other rows. If your engine shreds frequent Variant fields into typed columns, those fields are also the ones worth indexing first, because queries on them run fastest.

### Granularity and freshness

Index at the column level, not the table level. A wide table with 300 columns embedded as one document blurs into a vague average. Column-level documents let the retriever find the one column that matters inside a wide table, and table scores come from rolling up column scores.

Rebuild the index when schemas change. Iceberg schema evolution means columns get added, renamed, and dropped without rewriting data. An index built last month points the agent at columns that no longer exist. Trigger a rebuild from catalog events where your catalog emits them, and on a nightly schedule as a backstop.

## Retrieving Tables and Columns

With an index in place, retrieval turns a question into a short list of tables and columns. The goal at this stage is recall. Missing a needed column is fatal, because the model cannot use what it never sees. Including a few extra columns costs only a few tokens.

### Hybrid scoring

Pure embedding search misses exact matches. A question that mentions `sku` should find the column named `sku`, even if the embedding model places "SKU" closer to "product" in its vector space. Pure keyword search misses meaning. A question about "churned customers" should find a column described as "date the account was cancelled," which shares no keywords with the question.

Combine both. Score each column with a weighted sum of cosine similarity between the question and column embeddings, and the fraction of question words that appear in the column document. A split of roughly 70% semantic and 30% lexical works as a starting point. Tune it against your own evaluation set, since the right balance depends on how your columns are named and documented.

### Rolling columns up to tables

Score tables by their best column, not their average column. A wide table with one highly relevant column and 200 irrelevant ones should rank high for a question about that one column. Averaging buries it.

Then keep the top K tables. K depends on your schema and your questions. Most analytical questions touch one to four tables. Start with K of 5 to 8, measure how often the tables in your verified SQL fall inside the top K, and adjust. If recall at K is below about 95% on your evaluation set, raise K or improve your descriptions before doing anything else.

### The three-stage approach from CHESS

CHESS splits schema selection into three stages, and the structure is worth borrowing even if you do not adopt the whole system. First, it filters individual columns, discarding ones that clearly do not relate to the question. Second, it selects tables from what remains. Third, it selects columns within those tables to produce what the authors call a minimally sufficient schema. CHESS uses a language model for these stages and adapts how aggressively it prunes based on the question's complexity and the model's context size.

The lesson is that pruning works best in passes, with cheap filters first and expensive judgment last. In practice, many teams run embedding and keyword scoring as the cheap first pass, then ask a small, fast model to confirm the shortlist of tables and columns before handing it to the main model. The confirmation step catches cases where a column looks relevant by vocabulary but answers a different question.

### Follow-up questions

Agents rarely answer one question in isolation. A user asks for revenue by region, then says "now break that down by month," then "just EMEA." The second and third questions make no sense on their own, and retrieval run on "just EMEA" alone returns the wrong tables.

Carry the pruned schema forward. When a question is a follow-up, start from the previous turn's selected tables and columns, then retrieve additional ones from the new question and merge them. Ask a small model to rewrite the follow-up into a standalone question first, such as "total order revenue by region and month for EMEA," and run retrieval on the rewrite. Log both the original and the rewrite, since rewrite errors are a common hidden cause of wrong answers in multi-turn sessions.

### Keeping join keys

Column pruning has one hard rule: never prune a join key. If the question needs `orders` and `customers`, the prompt must include `orders.customer_id` and `customers.customer_id` even though neither scores well against a question about revenue by region. Add join keys after column pruning, from the join graph, so they survive whatever the scores say.

## Join Paths and Value Grounding

Retrieval finds the tables a question mentions. It does not find the tables needed to connect them. That takes a join graph.

### Building the join graph

A join graph has one node per table and one edge per valid join, labeled with the columns on each side. Good sources, in order of reliability:

1. **Relationships declared in a semantic layer.** These carry business intent, including cardinality, and someone reviewed them.
2. **Joins mined from verified SQL.** Your library of known-good queries shows which joins people actually use.
3. **Declared keys and naming conventions.** A column called `customer_id` in two tables is a candidate join, but only a candidate.

Avoid inferring joins from names alone in production. Two columns called `id` almost never join. Two columns called `account_id` sometimes refer to different account systems. Treat name-based joins as suggestions that need review.

### Expanding to connect selected tables

When retrieval returns `orders` and `regions` but the only path between them goes through `customers`, the prompt needs `customers` too. A breadth-first search over the join graph from the already-kept tables finds the shortest path to each new table, and every table along that path gets added. The join conditions along the path go into the prompt explicitly, so the model does not guess how to connect them.

Shortest paths are a reasonable default. They are not always correct. Some schemas have two paths between the same tables with different business meaning, such as orders joined to customers through the billing account versus through the shipping account. When that happens, encode the right path for each business concept in the semantic layer and let the agent use those definitions, rather than relying on graph search.

### Grounding filter values

Questions contain values: "in EMEA," "for enterprise customers," "with high severity." The model needs to know how those values are actually stored. The column holds `EMEA` in one system, `emea` in another, `Europe/Middle East/Africa` in a third, and a numeric code in a fourth. A model that guesses `WHERE region = 'Europe'` returns zero rows and a confident wrong answer.

CHESS addresses this with a retrieval step over database values, using locality-sensitive hashing to find stored values similar to terms in the question. A simpler version works for most teams. Keep an index of distinct values for categorical columns. For each noun phrase in the question, search that index, and add the top matches to the prompt as "known values" next to their columns. When the user writes "Europe" and the column stores `EMEA`, the prompt says so.

Value grounding also needs a security boundary. A value index built from a table leaks those values to anyone who can query the agent. Build value indexes only for columns where every agent user is allowed to see the distinct values, and apply the same access rules to the index that apply to the table.

## Selecting Few-Shot Examples

Pruning tells the model what exists. Examples show it how to use what exists. A good example demonstrates the SQL pattern a question needs: a join through a bridge table, a time-bounded aggregate, a filter on a grounded value, a window function for ranking.

### Why similar questions are not enough

The naive approach retrieves the examples whose questions look most like the new question. That works poorly, because surface similarity is dominated by domain nouns. "What was revenue by region in Q3?" and "What was revenue by product in Q3?" look nearly identical. Their SQL differs in joins and grouping. Meanwhile, "How many tickets were opened per week last month?" looks different from "What was order volume per week in September?" even though the SQL shape is the same.

The DAIL-SQL work, from Gao and colleagues, tested this directly. Its example selection masks domain-specific words in questions before comparing them, so similarity reflects intent rather than vocabulary. It also compares the shape of the SQL, called the skeleton, by stripping out table names, column names, and literal values. The paper's finding was that models learn from the mapping between a question's intent and the SQL skeleton, and that considering both masked question similarity and query similarity selects better examples. DAIL-SQL also dropped the full database schema from each example to save tokens, presenting only question and SQL pairs. With GPT-4 and self-consistency, it reached 86.6% execution accuracy on Spider at the time.

### Masking and skeletons in practice

Masking replaces schema words and literal values in a question with placeholders. "What was total order revenue by region in September?" becomes "What was total order revenue by `<mask>` in September?" when `region` is a schema term. Numbers and quoted strings become `<value>`. Two questions with the same intent and different entities now look alike.

A skeleton strips a SQL query to its structure. Parsing with a real SQL parser beats regular expressions, because SQL has too many edge cases for patterns. The `sqlglot` library parses many dialects into a tree that you can transform:

```python
import sqlglot
from sqlglot import exp


def sql_skeleton(sql: str, dialect: str = "trino") -> str:
    """Strip literals, columns, and tables so only the query's shape remains."""
    tree = sqlglot.parse_one(sql, read=dialect)

    def strip(node):
        if isinstance(node, exp.Literal):
            return exp.Placeholder()
        if isinstance(node, exp.Column):
            return exp.column("_c")
        if isinstance(node, exp.Table):
            return exp.to_table("_t")
        return node

    return tree.transform(strip).sql(dialect=dialect)
```

Running it on a revenue-by-region query produces this:

```text
SELECT _c, SUM(_c) FROM _t JOIN _t ON _c = _c WHERE _c >= CAST(? AS DATE) GROUP BY _c
```

That string captures everything the model needs to learn from the example: a two-table join, a sum, a date lower bound, and a grouping. Two queries with the same skeleton teach the same lesson.

### Diversity beats redundancy

Once you can compute skeletons, use them to avoid redundant examples. If the three most similar examples all share one skeleton, showing all three wastes tokens and teaches one pattern three times. Pick the most similar example for each distinct skeleton until you reach your budget. The model sees several relevant patterns and picks the one that fits.

Two to four examples is a good budget for most questions. More examples help less than better examples, and each one costs tokens on every call.

### Where the examples come from

The example library is a governed asset. Every entry needs a question, verified SQL, and a record of who verified it and against which schema version. The best source is a golden-question benchmark, the set of questions with known-correct answers that you already use to evaluate the agent. Building one is its own discipline, covered in [How to Build a Golden-Question Benchmark for Your Data Agents](https://datalakehousehub.com/blog/data-agent-golden-question-benchmark/).

Keep the evaluation set and the example library separate. If a test question also lives in the example library, the agent copies its own answer key, and your accuracy numbers stop meaning anything. Split the verified pairs into two pools, and never let an evaluation question retrieve itself.

### Ordering for prompt caching

Several model providers discount repeated prompt prefixes through prompt caching. Put the parts of the prompt that never change at the front: system instructions, SQL dialect rules, and output format. Put the per-question parts, the pruned schema, join keys, grounded values, and examples, after them. Pruning changes the schema section for every question, so it cannot be cached, but the stable instructions can.

## Putting It Together in Python

Here is a complete, minimal implementation of the online half of the pipeline. It takes an embedding function as a parameter, so you can plug in whatever embedding model your platform uses. It depends only on `numpy` and `sqlglot`, plus the `ColumnDoc` class and `sql_skeleton` function shown earlier.

```python
import re
from collections import deque

import numpy as np


def tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


class SchemaIndex:
    def __init__(self, columns, embed):
        self.columns = columns
        self.embed = embed
        vectors = embed([c.text() for c in columns])
        self.vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
        self.column_tokens = [tokens(c.text()) for c in columns]

    def score_columns(self, question: str, lexical_weight: float = 0.3) -> np.ndarray:
        q = self.embed([question])[0]
        q = q / np.linalg.norm(q)
        semantic = self.vectors @ q
        q_tokens = tokens(question)
        lexical = np.array([
            len(q_tokens & ct) / max(len(q_tokens), 1) for ct in self.column_tokens
        ])
        return (1 - lexical_weight) * semantic + lexical_weight * lexical

    def top_tables(self, question: str, k_tables: int = 5) -> list[str]:
        scores = self.score_columns(question)
        best = {}
        for col, s in zip(self.columns, scores):
            best[col.table] = max(best.get(col.table, -1.0), float(s))
        return sorted(best, key=best.get, reverse=True)[:k_tables]

    def top_columns(self, question: str, tables: set[str], per_table: int = 8) -> dict:
        scores = self.score_columns(question)
        picked = {t: [] for t in tables}
        ranked = sorted(zip(self.columns, scores), key=lambda x: -x[1])
        for col, s in ranked:
            if col.table in picked and len(picked[col.table]) < per_table:
                picked[col.table].append(col)
        return picked


def expand_join_paths(tables, joins):
    """Connect selected tables through the join graph using shortest paths.

    joins maps a table to (neighbor, left_column, right_column) edges.
    """
    if not tables:
        return set(), []
    keep, conditions = {tables[0]}, []
    for target in tables[1:]:
        if target in keep:
            continue
        prev = {t: None for t in keep}
        queue = deque(keep)
        while queue:
            node = queue.popleft()
            if node == target:
                break
            for neighbor, left_col, right_col in joins.get(node, []):
                if neighbor not in prev:
                    prev[neighbor] = (node, left_col, right_col)
                    queue.append(neighbor)
        if target not in prev:
            continue
        node = target
        while prev[node] is not None:
            parent, left_col, right_col = prev[node]
            keep.add(node)
            conditions.append(f"{parent}.{left_col} = {node}.{right_col}")
            node = parent
    return keep, conditions


def mask_question(question: str, schema_terms: set[str]) -> str:
    masked = re.sub(r"'[^']*'|\b\d+(\.\d+)?\b", "<value>", question)
    words = []
    for w in masked.split():
        core = re.sub(r"[^a-z0-9_]", "", w.lower())
        words.append("<mask>" if core in schema_terms else w)
    return " ".join(words)


def select_examples(question, library, embed, schema_terms, k=4):
    """Pick few-shot examples by masked-question similarity, one per SQL skeleton."""
    masked_q = mask_question(question, schema_terms)
    texts = [mask_question(ex["question"], schema_terms) for ex in library]
    vectors = embed([masked_q] + texts)
    vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    sims = vectors[1:] @ vectors[0]
    chosen, seen_shapes = [], set()
    for i in np.argsort(-sims):
        shape = sql_skeleton(library[i]["sql"])
        if shape in seen_shapes:
            continue
        seen_shapes.add(shape)
        chosen.append(library[i])
        if len(chosen) == k:
            break
    return chosen


def build_prompt(question, picked_columns, join_conditions, examples):
    lines = ["You write Trino SQL. Use only the tables and columns listed below.", ""]
    for table, cols in picked_columns.items():
        lines.append(f"TABLE {table}")
        for c in cols:
            lines.append(f"  {c.name} {c.type} -- {c.doc}")
    if join_conditions:
        lines.append("")
        lines.append("JOIN KEYS")
        lines.extend(f"  {j}" for j in join_conditions)
    lines.append("")
    lines.append("EXAMPLES")
    for ex in examples:
        lines.append(f"Q: {ex['question']}")
        lines.append(f"SQL: {ex['sql']}")
    lines.append("")
    lines.append(f"Q: {question}")
    lines.append("SQL:")
    return "\n".join(lines)
```

Here is what each piece does and why it is built that way.

`SchemaIndex` embeds every column document once, at construction, and normalizes the vectors so a dot product equals cosine similarity. `score_columns` blends that semantic score with a simple lexical overlap score. The lexical part is deliberately crude. In production, swap it for BM25 from a search library, but keep the blend.

`top_tables` scores each table by its best column, for the reason covered earlier: averaging hides the one relevant column in a wide table. `top_columns` then keeps the best few columns per selected table. It never looks at tables outside the selection, which keeps the prompt bounded no matter how large the catalog grows.

`expand_join_paths` runs a breadth-first search from the tables already kept to each new table and records the join conditions along the shortest path. Bridge tables get added automatically. If no path exists, the table stays out and the conditions list stays empty for it, which is a signal to log, since it usually means a missing relationship in the join graph.

`mask_question` and `select_examples` implement the masked-similarity and skeleton-diversity approach. The schema terms set should include every table name, column name, and namespace in your catalog, so domain nouns disappear before comparison.

`build_prompt` assembles the final context. Join keys appear in their own section so the model treats them as rules rather than suggestions.

### A worked run

Consider a toy catalog of eight columns across four tables: `sales.orders`, `crm.customers`, `hr.employees`, and `ops.tickets`. Ask it "What was total order revenue by region in September?" with a top-two table limit.

Retrieval returns `sales.orders` and `crm.customers`. The join expansion finds the direct edge and produces `sales.orders.customer_id = crm.customers.customer_id`. The HR and support ticket tables never reach the prompt. The example library holds three entries: revenue by region last quarter, revenue by region in March, and a ticket count. The first two share a skeleton, so the selector takes the closer of the two and skips the other, then fills the second slot with the ticket example, which has a different shape.

That last choice shows the trade-off in skeleton diversity. On a toy library of three, the second example is not useful. On a real library of hundreds, the diversity rule fills the second slot with a different pattern that is also relevant, such as a time-bucketed aggregate. Add a minimum similarity threshold so the selector stops when the remaining candidates are too far from the question.

### Validating before execution

Never run generated SQL without checking it first. Parse it with `sqlglot`, collect every table and column it references, and confirm each one appears in the pruned schema. A reference outside the pruned schema means the model invented a name or reached for something retrieval did not provide. Either way, reject the query, feed the error back to the model once, and log the case for review.

Then execute with limits: a row cap, a timeout, and a scan budget where your engine supports one. Pruning reduces the chance of a runaway cross join. It does not eliminate it.

## Failure Modes and Warning Signs

Pruning trades one class of errors for another. Here are the failures to watch for.

### Recall misses

The symptom is SQL that answers a slightly different question, because the right column never reached the prompt. A question about "net revenue" gets answered with gross revenue because `net_revenue` scored just below the cutoff. Measure recall directly: for every question in your golden set, check whether the columns in the verified SQL appear in the pruned schema. Track that number separately from end-to-end accuracy. When recall drops, the fix is in retrieval or documentation, not in the model.

### Over-pruning join keys

The symptom is a query that joins on the wrong columns or uses a subquery to fake a join. The cause is a join key that got pruned, or a missing edge in the join graph. Enforce the rule that join keys always survive pruning, and alert when `expand_join_paths` finds no path between selected tables.

### Stale indexes after schema evolution

The symptom is SQL referencing columns that no longer exist, or ignoring new columns that answer the question better. Iceberg schema evolution makes column changes cheap and frequent, which is good for data teams and hard on agents with stale indexes. Rebuild the column index on schema change events and track the age of the index as a health metric.

### Example contamination

The symptom is a pattern of wrong answers that all share one structure. The cause is a wrong example in the library, which the selector keeps retrieving because it looks similar to many questions. One bad example spreads its mistake to every question it gets selected for. Version the library, record who verified each entry, and re-verify examples when the tables they touch change.

### Value drift

The symptom is filters that return zero rows. The business renamed a category, and the value index still lists the old one. Refresh value indexes on the same schedule as the data they describe, and treat an empty result on a filtered query as a signal to check the grounded values.

### Confusing pruning with authorization

This one is a design error, not a runtime symptom. Pruning decides what the model sees. It does not decide what the user is allowed to query. A clever prompt or a retrieval miss can still lead the model to reference a table outside the pruned set, and a bug can let a query slip past the validator. Enforce access control in the engine and the catalog, with the agent running under the user's identity or a scoped service identity. Treat pruning as a relevance tool only.

For a catalog of how syntactically valid queries still return wrong numbers, see [Twelve Queries That Pass Every Schema Check and Still Return the Wrong Number](https://datalakehousehub.com/blog/semantic-failure-catalog-ai-agent-queries/).

## Measuring and Operating the Pipeline

Treat the pruning pipeline like any other production system, with metrics, budgets, and alerts.

**Retrieval recall at K.** For each golden question, the fraction of tables and columns in the verified SQL that appear in the pruned schema. This is the most important pipeline metric, because everything downstream depends on it. Aim for 95% or better at the table level.

**Prompt size.** Tokens per question, broken into stable prefix, schema, examples, and question. Watch the schema section most closely. A sudden jump means retrieval started pulling too many columns.

**Execution accuracy.** The fraction of golden questions whose generated SQL returns the same result as the verified SQL. Run it on every change to the index, the example library, the prompt template, or the model.

**Validation rejection rate.** How often generated SQL references something outside the pruned schema. A rising rate points at recall problems or a model that ignores the instruction to stay within the listed columns.

**Index freshness.** Time since the last rebuild, per catalog. Alert when it exceeds your schema change cadence.

### Adaptive budgets

A fixed K and a fixed column count per table waste tokens on easy questions and starve hard ones. "How many orders shipped yesterday?" needs one table and three columns. "Compare retention for customers acquired through paid search against organic signups, by cohort month" needs four or five tables and a dozen columns. CHESS adapts its pruning to question complexity and to the model's context size for this reason.

A simple version works well. Classify each question into a complexity tier, using a small model or rules based on the number of entities and operations mentioned. Give each tier its own budget for tables, columns per table, and examples. Then track recall and accuracy per tier, not only overall. When the hard tier's recall lags, raise its budget without touching the easy tier, and your average prompt size barely moves.

Tune in this order. Fix documentation first, since better descriptions improve retrieval for every question. Then tune K and the lexical weight against recall. Then curate the example library. Change the model last, and only after the earlier steps stop improving your numbers. Teams often reach for a larger model first, and it is the most expensive lever with the least predictable effect.

When you change any of these pieces, ship the change like any other software release, with an evaluation run before and after. The practice of versioning prompts, tools, and examples together is covered in [Release Management for Data Agents](https://datalakehousehub.com/blog/release-management-data-agents/).

## Where This Is Heading

Context windows keep growing. That does not make pruning obsolete. Larger windows raise the ceiling on what fits, but they do not change the cost of sending tokens or the distraction effect of irrelevant columns. Pruning stays useful as long as schemas grow faster than windows, and in most enterprises they do.

What changes is where the context comes from. The strongest signal for retrieval is not a column name. It is a business definition written by someone who knows what the data means. Semantic layers capture those definitions, and open standards are forming around them. Apache Ossie is working through how agents and BI tools query a semantic model, including a debate on the October dev list over whether a standard query tool contract belongs in the specification. Apache Polaris already stores semantic models with dedicated privileges. As those pieces mature, the schema index described here becomes a semantic index: metrics, entities, and relationships with verified definitions, retrieved the same way.

Agents will also increasingly reach data through the Model Context Protocol (MCP), an open protocol for connecting models to tools and data sources. An MCP server that exposes a data catalog can implement the retrieval steps in this article behind a single tool call, so every agent that connects gets pruned, grounded context without reimplementing the pipeline.

## Conclusion

Data agents fail on enterprise schemas because they see too much, not too little. A full schema buries the relevant columns, invites wrong choices among similar names, and costs tokens on every question.

The fix is a pipeline that narrows context step by step. Index columns with real descriptions and sample values. Retrieve tables by their best column with hybrid scoring. Expand join paths from a reviewed join graph and never prune join keys. Ground filter values against stored data. Pick a few examples by masked question similarity with one example per SQL skeleton. Validate every query against the pruned schema before it runs.

Then measure each stage on its own, especially retrieval recall, so you know which part to fix when accuracy moves. Pruning is not a trick you set once. It is an indexed, versioned, monitored system, and it pays back that effort in accuracy and cost on every question your agent answers.

## Keep Going

If this piece was useful, I have written a lot more on AI agents and the open lakehouse. My books on lakehouse architecture and AI cover semantic layers, catalogs, and how agents get governed access to Iceberg data, the foundation that makes schema pruning work. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
