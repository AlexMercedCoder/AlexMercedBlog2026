---
title: "Semantic Model Interchange Matrix, November 2026: Which Platforms Ingest LookML, MetricFlow, Semantic Views, Metric Views and Ossie"
description: "Which platforms ingest LookML, MetricFlow, Snowflake and Databricks semantic models and Ossie, with the losses each converter documents."
date: 2026-11-09T09:00:00Z
tags: ["semantic-layer", "ossie", "dbt", "lookml", "databricks"]
canonical: https://datalakehousehub.com/blog/semantic-model-interchange-matrix-november-2026/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/semantic-model-interchange-matrix-november-2026/).

No single semantic-model format has won, but platforms now import each other's. Google's Knowledge Catalog made expanded semantic model support generally available on October 29, 2026, ingesting Looker LookML, dbt MetricFlow, Snowflake Semantic Views, Databricks Metric Views and SAP Core Schema Notation (CSN). This matrix records which platform reads or writes which format, with a date and source for each cell, and what each translation drops.

Here is the problem this solves. A company defines "net revenue" in Looker. The finance team defines it again in dbt. The Snowflake team builds a Semantic View for Cortex Analyst, and the Databricks team builds a Metric View for Genie. Four definitions, four tools, and an AI agent that picks whichever one its connector reaches first. The agent's answer looks authoritative. It matches none of the finance reports.

Every vendor now agrees this is a real problem, which is progress. They disagree on the fix. Some platforms ingest everyone else's format into their own catalog. Others push a shared interchange format, Apache Ossie, that tools convert to and from. Both approaches shipped real changes in the last week of October.

A disclosure: I work at Dremio, now part of SAP. Dremio ships an AI Semantic Layer, and SAP's CSN appears in this matrix. I treat both like any other row.

## Why Interchange Matters for Agent Grounding

A semantic model is the layer that turns table columns into business meaning. It says that `revenue` is `SUM(amount)` over orders where `status != 'cancelled'`. It says that orders join to customers on `customer_id`, many to one. It says that "sales" and "bookings" are synonyms for the same metric. Without that layer, an agent writing SQL has to guess every one of those decisions from column names.

Google's announcement opens with exactly that failure: an agent that counted cancelled orders as revenue and read from an unvalidated staging table. The agent's SQL was valid. Its business logic was wrong. Google's internal benchmarks claim that grounding agents in Knowledge Catalog makes them nearly four times more accurate, with up to 33% lower latency and up to 75% fewer tokens. Those are vendor numbers from vendor tests, so treat them as a direction rather than a promise. The direction matches what every team building data agents reports: the semantic layer is where answer quality comes from.

Interchange matters because agents do not live inside one tool. A single assistant often queries BigQuery, a Snowflake warehouse and an Iceberg lakehouse in one conversation. If each source carries its own semantic format and none can read the others, the agent either picks one or reconciles them on the fly. Neither is safe.

There are two ways out. The **hub approach** puts one catalog in the middle and teaches it to ingest every format. Knowledge Catalog is the clearest example this week. The **interchange approach** defines a neutral file format and writes converters between it and each vendor's native format. Apache Ossie is that format. The two approaches can coexist, and the matrix shows where they already do.

## The Matrix: Platform by Format, as of November 3, 2026

Each row is a platform or tool. Each column is a semantic format. A cell says whether the platform **imports** (reads the format into its own model), **exports** (writes its model out in that format), or both. "Native" means the format is the platform's own.

| Platform | LookML | dbt MetricFlow | Snowflake Semantic Views | Databricks Metric Views | SAP CSN | Apache Ossie | Status and date | Source |
|---|---|---|---|---|---|---|---|---|
| Google Knowledge Catalog | Import (Live sync from Looker Core) | Import | Import (via Horizon Catalog) | Import (via Unity Catalog) | Import (via SAP BDC) | Not listed | GA, Oct 29, 2026 | Google Cloud blog |
| Databricks Metric Views | n/a | Via Ossie (dbt manifest to Ossie to Metric View) | n/a | Native | n/a | Import and export (Python and Java converters) | Relationships Beta, Oct 30, 2026 | Databricks release notes, apache/ossie |
| dbt MetricFlow | n/a | Native | n/a | n/a | n/a | Converter in apache/ossie | Merged | apache/ossie |
| Snowflake Semantic Views | n/a | n/a | Native | n/a | n/a | Reference converter in apache/ossie | Merged | apache/ossie |
| Lightdash | n/a | Native host (dbt schema.yml meta) | n/a | n/a | n/a | Import and export | Converter PR #253 | apache/ossie |
| Holistics AML | n/a | n/a | n/a | n/a | n/a | Import and export | Documented | Holistics docs |
| DuckDB (community extension) | n/a | n/a | n/a | n/a | n/a | Load, validate, execute, serve over MCP | Published | DuckDB community extensions |
| Apache Polaris | n/a | n/a | n/a | n/a | n/a | Catalog metadata converter | Merged | apache/ossie |

Read the "n/a" cells carefully. They do not mean a translation is impossible. They mean no vendor documents a direct path between those two formats. Most cross-vendor paths today go through either Knowledge Catalog, which only imports, or Ossie, which needs a converter on each side.

Four observations stand out.

**Knowledge Catalog imports everything and exports nothing.** That is a reasonable design for a hub. Definitions flow in, and agents query the hub. It does not help you move a LookML model into Databricks. It helps you see both models next to each other. Google says overlapping definitions are never silently overwritten. Both stay in the graph, labeled with their source, so a data steward can reconcile them. That is the correct behavior for a hub, and it is worth testing before you trust it.

**Knowledge Catalog does not list Ossie as a source.** Google ingests five vendor formats plus its own BigQuery Graph and measures. The interchange format that most of those same vendors helped write is not on the list. A tool that exports Ossie today does not reach Knowledge Catalog through that path.

**Databricks has the most complete Ossie story.** The apache/ossie repository holds both a Python and a Java converter for Metric Views, in both directions. The Java converter follows the conventions of the existing Polaris and Salesforce Java converters. Fixes have been ported between the Ossie repository and Databricks' own runtime, which tells you the converter is in active production use, not a demo.

**Ossie's own host is an execution engine you can run on a laptop.** The DuckDB community extension loads an Ossie model, validates it against the spec's JSON schema, answers metric queries against local tables and can publish the model to an agent over the Model Context Protocol (MCP). MCP is the open protocol that lets AI agents call external tools through a standard interface. The extension is an independent implementation, not an Apache Software Foundation product, but it is the fastest way to see what a portable metric looks like in practice.

## What Changed in the Last Week of October

Three dated events shaped the matrix.

**October 29: Knowledge Catalog expanded semantic support went GA.** The detail in Google's announcement is useful because it lists what each import carries, which is a direct hint about what survives translation.

- From LookML, it indexes models, explores, views and dashboards, capturing compiled metric SQL, fan-out-safe join conditions, mandatory filters and lineage to dashboards.
- From dbt MetricFlow, it links source objects to dbt models and metrics, alongside test results, filters, saved queries, freshness SLAs and exposures.
- From Snowflake Semantic Views through Horizon Catalog, it brings in dimensions, facts, metric formulas, relationships and synonyms, plus Data Metric Function quality scorecards and PII masking tags.
- From Databricks Metric Views through Unity Catalog, it ingests metric view definitions, measure formulas, scoping filters and join cardinalities, alongside certification badges and Lakehouse Monitoring profiles.
- From SAP CSN through SAP Business Data Cloud, it captures business labels, dimension and cube patterns, default aggregations, currency and unit bindings, join associations and data sensitivity flags.

Notice that each import pulls in governance and quality signals the source tool keeps outside the semantic model itself. That is the hub's real advantage. An interchange file carries the model. A hub carries the model plus the trust signals around it.

**October 30: Databricks put relationships between metric views in Beta.** A `RELATIONSHIP` records how a source metric view joins to a target metric view, including cardinality and the join condition, so AI assistants and BI tools choose the right join path. It requires Databricks Runtime 19 or above, or a SQL warehouse. This lands three weeks after window measures in metric views went GA on October 6.

Relationships matter for interchange because joins are where translations break most often. A format that records cardinality explicitly gives converters something exact to map. Ossie takes a different approach, covered below.

**November 2: Ossie gained a publisher outside the vendor converters.** A post to the Ossie dev list that day said the GASP metrics standard now publishes its metric definitions in Ossie format. I have not seen GASP's own announcement, so verify it at the source before you cite it. If it holds, it is the first case in this window of a metrics standard choosing Ossie as its distribution format rather than a vendor writing a converter to it.

## Translation-Loss Categories

Every converter drops something. The useful question is what, and whether it fails loudly or quietly. The apache/ossie repository, its GitHub discussions and the vendor converter docs are unusually candid about this. Here are the four categories that matter, with documented examples.

### Measure Semantics

This is the most dangerous category, because losses here produce wrong numbers instead of errors.

A practitioner from a MetricFlow and dbt-databricks shop posted a detailed round-trip review in the Ossie repository's discussions. Two findings stand out. First, MetricFlow's `agg_time_dimension` was silently dropped. Two MetricFlow metrics that share an expression but differ only in their time dimension became byte-identical Ossie metrics with different names. Ossie has no time-grain field, so nothing in the output tells you the two were ever different. Second, MetricFlow's layered metric types (a measure, a simple metric naming that measure, a derived metric referencing other metrics) have no direct Ossie equivalent, and cross-fact metrics that combine measures from several fact tables had no Ossie form at all.

Lightdash's converter documents the same gap from the other side: cross-dataset metrics are dropped on export to Lightdash. Holistics reports that window functions in Ossie metrics raise an error on import to AML.

The pattern is consistent. Simple aggregates over one dataset translate well. Metrics that depend on time grain, on other metrics, or on more than one fact table are where formats diverge. The DuckDB extension makes this explicit by refusing to answer metrics that aggregate at more than one grain or use a window function, rather than returning a plausible wrong number.

### Relationships and Joins

Formats disagree on how to describe a join, and the disagreement starts with cardinality.

Databricks' new relationships record cardinality as a declared fact. Ossie does not state cardinality at all. In Ossie, a relationship lists `from_columns` and `to_columns`, and cardinality is inferred by checking whether the join columns match the target dataset's `primary_key` or a `unique_keys` entry. The DuckDB extension documents this inference and uses it to detect fan-out joins, where a one-to-many join silently multiplies every aggregate.

That design choice has a consequence for converters. Going from Ossie to Databricks, a converter has to derive cardinality from keys. Going from Databricks to Ossie, a declared cardinality survives only if the matching key declarations exist on the target dataset. If they do not, the information is lost.

The Databricks Java converter documents a second gap. Joins whose condition uses something other than plain column equality (a different operator, a key wrapped in a SQL function, or an extra filter predicate) have no Ossie representation. An earlier version aborted the whole Metric View conversion on such a join. Condition-less cross joins are still rejected outright.

### Security and Governance

Ossie describes the semantic model only. Holistics says so plainly in its converter docs. Row filters, column masks, sensitivity tags and certification badges live outside the format.

This is where the hub approach and the interchange approach differ most. Knowledge Catalog pulls PII masking tags from Horizon, certification badges from Unity and sensitivity flags from SAP CSN, alongside the model. An Ossie file moving between two tools carries none of that. The receiving tool has to apply its own policies, or the definition arrives ungoverned.

The practical rule: never treat a converted semantic model as carrying its access policy with it. Rebuild policy on the target and test it.

### Descriptions, Labels and Synonyms

This category fails quietly but harmlessly, mostly. It affects agents more than humans, because agents rely on descriptions and synonyms to match a user's words to a metric.

Ossie's metric schema has an `ai_context` field that carries synonyms, and the Databricks converter maps Metric View synonyms into it. A measure's `display_name` had no home on the Ossie metric shape. The Databricks converters now stash it, along with filter, window, format, `rely` and materialization settings, in a `custom_extensions[DATABRICKS]` block. Import stashes those Metric View features, and export restores them, which keeps a Databricks to Ossie to Databricks round trip lossless.

That stash pattern is clever and also a warning. It preserves information for the original vendor. Any other tool reading the same Ossie file ignores the extension block. A Metric View that round-trips perfectly through Ossie and back to Databricks still loses its formatting and filter settings when it lands in Lightdash.

## Where Ossie Sits Relative to the Vendor Formats

Ossie is a document format, not a query engine. It describes datasets bound to physical tables, the fields on them, the relationships between them and the metrics computed over them. It does not execute queries, and it does not sit in the query path.

Two properties define its position.

**It carries expressions in multiple dialects.** A single Ossie metric can hold the same formula written in several SQL dialects. Converters select the dialect they need and fall back to `ANSI_SQL`. The project is also defining its own expression language, OSSIE_SQL_2026, which the DuckDB extension already accepts alongside ANSI SQL. A portable expression language is the piece that makes "define once, compute the same number everywhere" possible. Without it, each dialect copy can drift.

**It separates dataset-scoped and model-scoped metrics.** A dataset-scoped metric aggregates fields of one dataset and references them unqualified. A model-scoped metric spans datasets and references fields as `dataset.field`. This split is how Ossie handles cross-dataset metrics without a separate measure type, and it is also why converters for tools with layered metric types struggle.

The current spec version is `0.2.0.dev0`, using a flat document shape: one model per JSON or YAML document, with `name`, `datasets`, `relationships` and `metrics` at the root alongside `version`. Older documents that wrapped models in a `semantic_model` array must be migrated before conversion. If you wrote Ossie files over the summer, check which shape they use.

The project entered the Apache Incubator in June 2026. Its mentors include Jean-Baptiste Onofré, Russell Spitzer and Holden Karau, who also guided Apache Iceberg and Apache Polaris. Ossie is still a 0.x podling. The format is stable enough to build converters on and young enough that the shape of a document changed this year.

The vendor formats sit on both sides of it. LookML, MetricFlow, Semantic Views and Metric Views are each tied to an execution engine. They are rich, because each one can assume its engine's features. Ossie is thinner, because it has to describe only what every engine can compute. That thinness is the source of every loss in the previous section. It is also the reason a metric defined in Ossie can reach an engine its author never planned for.

## A Repeatable Round-Trip Test with One Reference Model

Vendor claims about conversion fidelity are easy to make and hard to check. The reliable approach is to keep one small reference model and push it through every path you depend on. Any loss shows up as a different number.

Start with a model that exercises the risky categories: a join with a declared key, a simple aggregate, a filtered aggregate and a cross-dataset metric. Here it is in the flat Ossie `0.2.0.dev0` shape:

```yaml
version: 0.2.0.dev0
name: sales_reference
datasets:
  - name: orders
    source: memory.main.orders
    fields:
      - name: customer_id
        expression:
          dialects:
            - dialect: ANSI_SQL
              expression: customer_id
      - name: amount
        expression:
          dialects:
            - dialect: ANSI_SQL
              expression: amount
      - name: status
        expression:
          dialects:
            - dialect: ANSI_SQL
              expression: status
  - name: customers
    source: memory.main.customers
    primary_key: [customer_id]
    fields:
      - name: customer_id
        expression:
          dialects:
            - dialect: ANSI_SQL
              expression: customer_id
      - name: country
        expression:
          dialects:
            - dialect: ANSI_SQL
              expression: country
relationships:
  - name: orders_to_customers
    from: orders
    to: customers
    from_columns: [customer_id]
    to_columns: [customer_id]
metrics:
  - name: gross_revenue
    expression:
      dialects:
        - dialect: ANSI_SQL
          expression: SUM(orders.amount)
  - name: net_revenue
    description: Revenue excluding cancelled orders
    ai_context:
      synonyms: [bookings, net sales]
    expression:
      dialects:
        - dialect: ANSI_SQL
          expression: SUM(CASE WHEN orders.status <> 'cancelled' THEN orders.amount END)
```

Each part has a job. The `primary_key` on `customers` is what lets a reader infer that the relationship is many-to-one, since Ossie does not declare cardinality directly. The `gross_revenue` metric is the control case that every converter handles. The `net_revenue` metric carries a conditional aggregate, a description and synonyms, which tests both measure semantics and the agent-facing metadata.

Next, compute the ground truth. The DuckDB extension gives you an executor with no infrastructure:

```sql
INSTALL ossie FROM community;
LOAD ossie;

CREATE TABLE orders(order_id INTEGER, customer_id INTEGER,
                    amount DECIMAL(10,2), status VARCHAR);
CREATE TABLE customers(customer_id INTEGER, country VARCHAR);
INSERT INTO orders VALUES
  (1, 1, 100.00, 'complete'),
  (2, 1, 250.00, 'cancelled'),
  (3, 2,  75.00, 'complete');
INSERT INTO customers VALUES (1, 'US'), (2, 'DE');

CALL ossie_load('sales_reference.yaml', validate_sources => true);

-- Confirm the vocabulary survived loading
SELECT name, description, synonyms FROM ossie_metrics();
SELECT name, from_dataset, to_dataset, cardinality FROM ossie_relationships();

-- Ground truth by country
SELECT * FROM ossie_query(['gross_revenue', 'net_revenue'],
                          ['customers.country']);

-- Keep the compiled SQL for comparison with each target engine
SELECT ossie_compile(['net_revenue'], ['customers.country'], []);
```

The `validate_sources` argument makes the load fail if any dataset's table is missing, so a typo in `source` cannot hide. The `ossie_relationships()` call shows the inferred cardinality. If it does not report many-to-one, your key declarations are wrong, and every downstream converter will inherit the mistake. The `ossie_query` call produces the reference numbers: US gross revenue of 350.00 and net revenue of 100.00, DE gross and net of 75.00. The `ossie_compile` call returns the SQL text, which you keep to compare against what each target engine generates.

Now run the round trips you care about. For each path, convert the reference model into the target format with that vendor's converter, load it, run the same two metrics by country on the same three rows, and compare. Then convert back to Ossie and diff the file against the original.

Record three things per path. Whether the numbers match. Which fields disappeared from the round-tripped file, especially `description`, `ai_context` and `primary_key`. And whether anything new appeared inside `custom_extensions`, which tells you what the target tool has no native field for.

Run this test on every converter upgrade. Converters in a 0.x project change often, and a silent regression in measure semantics is the failure you most want to catch before an agent does.

## Operational Guidance

A few practices follow from the matrix and the loss categories.

**Pick a system of record for each metric, not for the whole model.** In most companies, finance owns revenue definitions and product owns engagement definitions, and they live in different tools. Record which tool owns each metric. Every other copy, whether in a hub or an Ossie file, is a derived artifact.

**Use the hub for visibility and the interchange format for movement.** Knowledge Catalog shows you conflicting definitions side by side with provenance. That is the right tool for finding drift. Ossie converters move a definition into a tool that needs to execute it. That is the right tool for deployment. Do not expect either one to do the other's job.

**Keep metrics simple where portability matters.** Single-dataset aggregates and conditional aggregates translate cleanly across every converter documented today. Time-grain-dependent metrics, derived metrics and window functions do not. If a metric has to reach five engines, write it in the portable subset and accept a less clever definition.

**Declare keys everywhere.** Ossie infers cardinality from keys. Databricks now records it explicitly. Declared keys are the cheapest way to make join semantics survive any translation, and they let tools like the DuckDB extension refuse fan-out joins instead of inflating totals.

**Rebuild governance on every target.** No interchange format in this matrix carries row filters or masking rules. Treat every converted model as ungoverned until the target platform applies its own policy.

**Pin converter versions next to model versions.** A semantic model file is only half of a reproducible result. The converter that translated it is the other half. Store the converter package name and version in the same commit as the model, and record both in your round-trip test output. When a number changes after an upgrade, you want to know in one look whether the model changed or the converter did.

**Watch the size of every `custom_extensions` block.** An extension block is a list of things the interchange format has no field for. A small block is normal. A block that grows release after release means the source tool keeps adding features the shared format cannot carry, and every other reader of that file is seeing less of the model over time. Treat a growing extension block as a signal to raise the gap on the Ossie dev list, where spec changes get discussed in public.

**Re-test on a schedule.** The matrix will change month to month. Keep the reference model and the test in a repository, and run it whenever a converter or platform release lands.

## Where Interchange Is Heading

Three trends are visible.

Hubs and interchange formats will meet in the catalog. Ossie's roadmap includes integration with Apache Polaris so semantic models can be discovered through the same catalog that serves tables. An agent that loads a table definition from an Iceberg REST catalog and receives the governed metric definitions alongside it is the end state most of the industry is building toward. Google's hub, Snowflake's Horizon context features and Databricks' Unity Catalog business semantics are each a vendor version of that idea. Ossie in Polaris is the open version.

The expression language is the next real fight. Formats today carry expressions as dialect-tagged SQL strings. OSSIE_SQL_2026 aims to pin down a shared expression language so a metric returns the same number on every engine. That work includes details as small as how `ROUND` breaks ties and whether `/` performs true division, which sound pedantic until two dashboards disagree by a rounding cent across a million rows.

Refusal will become a feature buyers ask for. The DuckDB extension's design principle, that an agent cannot check the number it receives so a plausible wrong answer is worse than an error, is the right standard for every semantic layer serving agents. Expect vendors to compete on how clearly their layers refuse ambiguous requests, not just on how many formats they ingest.

## Conclusion

The semantic layer is where agent accuracy comes from, and this week made it much easier to bring existing definitions together. Knowledge Catalog now ingests five vendor formats into one graph and keeps conflicting definitions side by side. Databricks added explicit relationships between metric views. Ossie gained converters across Databricks, dbt, Snowflake, Lightdash, Holistics and Polaris, plus a standalone executor in DuckDB.

None of that removes translation loss. Time grain, layered metrics, non-equality joins and governance policy all drop somewhere in the current matrix. The fix is discipline: keep metrics in the portable subset where they need to travel, declare keys, rebuild policy on every target, and run one reference model through every path you depend on. I will refresh this matrix with a dated changelog as converters and platforms change.

## Keep Going

If this piece was useful, I have written a lot more on semantic layers, open catalogs and AI-ready lakehouse design. *Architecting an Apache Iceberg Lakehouse* (Manning) covers how catalogs, semantic layers and engines fit together in a lakehouse that agents can trust. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
