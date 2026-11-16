---
title: "Relationship Cardinality and Join Types in Semantic Models: Why Engines Guess Differently, and What Apache Ossie Is Settling"
description: "Semantic model relationships hide join type and cardinality, so engines guess differently and totals drift. What Apache Ossie is settling and how to test it."
date: 2026-11-16T09:00:00Z
tags: ["Apache Ossie", "Semantic Layer", "Data Modeling", "AI Agents", "SQL"]
canonical: https://datalakehousehub.com/blog/semantic-model-relationship-cardinality-join-types-ossie/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/semantic-model-relationship-cardinality-join-types-ossie/).

Semantic models declare relationships between datasets, but a relationship definition often doesn't say whether a join is inner or left, or which side can fan out. Engines fill the gap differently, so the same model can return different totals. Apache Ossie's dev list is now settling cardinality names, declaration direction and join type.

The failure this produces has a specific shape: valid SQL, a plausible number, and no error. A sales total comes back lower in one tool than in another, and both tools read the same model. Nobody changed the data or the metric. One tool joined facts to a dimension with an inner join and dropped the rows that matched nothing. The other kept them.

This article is a supporting piece on one category of translation loss, relationship semantics. For which platforms ingest which semantic model formats, see the primary page on this topic, the [Semantic Model Interchange Matrix, November 2026](https://datalakehousehub.com/blog/semantic-model-interchange-matrix-november-2026/). Here I focus on the threads that moved on the Apache Ossie dev list between November 3 and 16, 2026, what they reveal about how engines interpret relationships, and how to test your own stack. A disclosure: I work at Dremio, which ships an AI Semantic Layer. The point of this article is the open standard and how consumers of it behave.

## Two ways one relationship goes wrong

A relationship in a semantic model says that rows in one dataset relate to rows in another through matching columns. Orders relate to customers through `customer_id`. That sentence leaves out two facts every query engine needs.

**How many rows match on each side?** That is cardinality. If each order has at most one customer, joining orders to customers keeps one row per order. If the relationship actually runs the other way, and one customer row matches many order rows, joining from customers to orders multiplies customer rows. Any customer-level measure, such as credit limit, gets summed once per order. That is fan-out, and it inflates totals.

**What happens to rows that match nothing?** That is the join type. An order whose `customer_id` has no row in the customers table is an orphan. An inner join drops it. A left outer join keeps it with null customer columns. If the engine drops it, every order measure grouped by any customer attribute comes out lower. That is row loss, and it deflates totals.

Fan-out makes numbers too high. Row loss makes them too low. Both come from information a relationship did not carry, and both produce numbers that look reasonable.

Referential integrity problems are common in real lakehouses. Late-arriving dimensions, deleted customers, test records, and IDs from a system that never synced all create orphan facts. Iceberg tables do not enforce foreign keys, and the primary keys arriving with Iceberg v4 start out unenforced. A semantic layer that assumes clean joins is assuming something the storage layer does not promise.

## What Ossie says today

Apache Ossie is the incubating Apache project for a vendor-neutral semantic model specification. It grew out of the Open Semantic Interchange effort. For background on its structure and the debate about its query interface, see [How Apache Ossie Is Deciding What Agents and BI Tools Can Ask a Semantic Layer](https://iceberglakehouse.com/posts/ossie-semantic-query-interface-agents/) on IcebergLakehouse.com.

The spec is organized in layers. Two matter here.

**Layer 2, relational semantics,** describes datasets, measures, and relationships as metadata over tables. Consumers, such as BI tools that generate their own SQL, write queries against it.

**Layer 3, wide table semantics,** defines declarative queries. A consumer asks for dimensions, measures, filters, and sort order, and the spec defines how that request compiles to SQL.

In the core spec, a relationship equates its `from_columns` with its `to_columns`. By convention, `from` is the many side and `to` is the one side. The illustrative example in the wide table spec is a relationship named `orders_to_customers` with `from: orders` and `to: customers`. There is no separate cardinality field today. The many-to-one direction is implied by which dataset sits in `from`.

The Layer 3 spec is precise about joins. Its Paths section says only many-to-one steps are supported. A step crosses a relationship from `from` to `to`, matching at most one `to` row per `from` row if the data meets the declared cardinality. If two or more paths lead between the same datasets, the engine must raise `E_AMBIGUOUS_PATH`. And the lowering to SQL uses `LEFT JOIN`, so the result is the same whether or not the data meets the declared cardinality.

So Ossie already answers the join-type question for Layer 3 queries: left join, keep the facts. The gap shows up everywhere else. A converter that translates an Ossie model into another tool's native model format has to choose a join type for that tool, and the relationship gives it nothing to choose with.

## The questions Julian Hyde put on the table

A GitHub discussion titled "How Should Semantic Engines Interpret Ossie Relationship Definitions?" (discussion #671) was mirrored to the dev list in early November. On November 3, Julian Hyde posted four questions that frame the whole problem.

1. **How do relationships relate to joins?** Are they suggested joins, or unenforced foreign keys? Does defining a relationship inside a model give different results than joining two single-source models in a query?
2. **Does cardinality matter?** If two models differ only in one relationship's cardinality, is there a query that returns different results?
3. **Do joins matter?** Does a model with four related tables give the same answers as a model over one flattened table built from the same four-way join, including when referential integrity fails?
4. **Do filters move across relationships?** In DAX, the formula language of Power BI, filters flow from the one side to the many side. Do other tools do this?

He added that it is fine if products answer differently, as long as they can declare their behavior or users can override it, the way `ORDER BY ... NULLS FIRST` overrides a database's null sorting. Products agreeing is better, because then the community can standardize.

Chris Eubank answered on November 4 by splitting the answers by layer. At Layer 2, relationships are descriptive. Engines can use them for optimization, but queries can ignore them, and they do not assert referential integrity. A wrong cardinality there leads to a wrong optimization but does not change query semantics. At Layer 3, relationships define valid join paths and filter propagation, and changing cardinality can change results. On the flattening question, his answer was no. Relationships preserve the separate grains of the underlying tables. A flattened table commits to one join shape, which duplicates rows or drops unmatched records. On filters, he described how tools differ: Power BI uses explicit filter-direction settings and cardinality, while Tableau treats cardinality mainly as an optimization hint and uses graph structure to pick join paths.

That exchange is the best short description I have seen of why semantic models are not just saved joins. It also shows why interchange is hard. Each tool has its own answers to Julian's four questions, and an interchange format has to carry enough for every tool to apply its own rules correctly.

## Cardinality: making the implicit explicit

Matthew Mullins of Coginiti has a proposal to add explicit cardinality to Ossie relationships. By the thread on November 15 and 16, the debate had narrowed to three questions.

**Which values?** Matthew agreed with Jean-Baptiste Onofré to drop `OneToMany` and keep the existing from/to convention, based on JB's argument about backward compatibility and the risk of silent fan-out. He proposed `ManyToOne` and `OneToOne` as the initial values, in PascalCase to match other Ossie enumerations ([thread](https://lists.apache.org/thread/3ypy533w9sdk2xk2bxj2gtxo9ny50tng)). Chris Eubank disagreed later that evening. He favored supporting `OneToMany` too, since a breaking change is already on the table and "A ManyToOne B" and "B OneToMany A" describe the same relationship. He suggested keeping `ManyToMany` as a separate change because it raises different semantic questions.

**Which word?** The ontology part of the spec uses "multiplicity." Matthew argued for "cardinality" in the core spec. He cited a September point from Mario DeFelipe: at the ontology layer, cardinality expresses a business rule about concepts, and at the dataset layer, it describes the structure of the data and drives join planning and aggregation safety. The two can disagree, and the disagreement is useful information. He also noted that cardinality is the standard term in relational modeling, BI semantic layers, and ontology standards such as OWL 2 and SHACL. Chris agreed on "cardinality."

**What happens to paths?** Chris asked Matthew to update the Layer 3 Paths section in the same PR. He proposed generalizing traversal to any step that matches at most one destination row per starting row: from `from` to `to` for `ManyToOne` or `OneToOne`, and from `to` to `from` for `OneToMany` or `OneToOne`. That keeps the rule that paths never cross an edge toward higher cardinality.

The substance is agreed. Cardinality becomes an explicit field. The open items are naming and whether the reverse direction is allowed.

## Join type: the gap no field covers

On November 16, Damian Waldron opened a new thread, "Join type is not carried by a relationship, and consumers are guessing differently" ([thread](https://lists.apache.org/thread/1dhvf2yoxqhgd7h4k9o7wh6cqmzmfy54)). He works on the ThoughtSpot converter for Ossie, and his report is the clearest real-world example of this problem so far.

ThoughtSpot requires a join type on every join. An Ossie relationship has no join type field. So the converter had to invent one for any Ossie document it did not write itself, and it chose `INNER` silently. A fact row whose foreign key matches nothing on the dimension side then disappeared, and every measure computed over it came out lower. In his words: valid output, wrong number, no error.

The team changed the converter to keep the many side and to report the assumption. That report goes into their own issue log, so the person using the model never sees it.

He then showed why it is not just one tool's problem. According to his post, Databricks metric views offer no join type on a join, because the semantics are fixed: the fact source joins every dimension with a left outer join. A model that starts in Databricks, round-trips through Ossie, and lands in a consumer that defaults to inner joins loses rows the source kept. Nothing in the Ossie document is wrong. The information was never in it.

He asked three narrow questions:

1. Is the omission deliberate? If join type is meant to be the consumer's choice, the spec should say so, so converter authors know they are making a decision rather than missing one.
2. If not, is an optional `join_type` on relationships worth a proposal? He suggested four values, backward compatible, with absence meaning whatever consumers do today.
3. Either way, should a compliance case cover it? A fixture with an unmatched fact row shows immediately which consumers keep it.

### Why cardinality and join type are linked

In his reply on the cardinality thread the same morning, Damian made a point that ties the two proposals together. "Keep the many side" is the only safe default for a join. But which side is the many side? Only the convention says it is `from`. If a relationship actually runs one-to-many, keeping `from` keeps the one side and null-extends measures instead. That is the same wrong-number failure, inverted.

So the converter now picks the join type from the cardinality:

```text
MANY_TO_ONE  -> LEFT_OUTER   (keep the many side, which is `from`)
ONE_TO_ONE   -> LEFT_OUTER   (nothing duplicates either way)
ONE_TO_MANY  -> RIGHT_OUTER  (keep the many side, which is `to`)
```

Each line maps a cardinality to the join that preserves the fact rows. The rule only works when cardinality is known. Under today's implicit many-to-one convention, it is a guess, and a relationship that really runs one-to-many gets the wrong join with no warning.

His summary of why this belongs with the cardinality proposal is sharp. The consumer is not choosing a filter propagation policy. It is choosing which rows survive a join, and it cannot choose correctly without knowing the multiplicity. Making cardinality explicit does not prescribe query behavior. It supplies the one fact the choice depends on.

## A test model you can run yourself

You can see both failure modes with two tiny tables. The numbers below are toy data chosen to make the effect obvious.

```sql
CREATE TABLE customers (customer_id INT, region VARCHAR, credit_limit DECIMAL(10,2));
CREATE TABLE orders (order_id INT, customer_id INT, amount DECIMAL(10,2));

INSERT INTO customers VALUES
  (1, 'EMEA', 1000.00),
  (2, 'AMER', 2000.00);

INSERT INTO orders VALUES
  (10, 1, 100.00),
  (11, 1, 150.00),
  (12, 2, 200.00),
  (13, 999, 50.00);  -- orphan: customer 999 does not exist

-- Row loss: total order amount, inner versus left join.
SELECT SUM(o.amount) FROM orders o
JOIN customers c ON o.customer_id = c.customer_id;        -- 450.00

SELECT SUM(o.amount) FROM orders o
LEFT JOIN customers c ON o.customer_id = c.customer_id;   -- 500.00

-- Fan-out: total credit limit, joined from the wrong direction.
SELECT SUM(c.credit_limit) FROM customers c;              -- 3000.00

SELECT SUM(c.credit_limit) FROM customers c
JOIN orders o ON o.customer_id = c.customer_id;           -- 4000.00
```

The first pair shows row loss. Order 13 references customer 999, which does not exist. The inner join drops it, so total sales read 450. The left join keeps it, so they read 500. Both queries are valid, and the gap equals the orphan's amount.

The second pair shows fan-out. Customer 1 has two orders. Joining customers to orders produces customer 1's row twice, so its credit limit of 1,000 is counted twice, and the total reads 4,000 instead of 3,000.

To test a semantic tool, model these two tables with one relationship, `orders_to_customers`, from orders to customers on `customer_id`. Then ask the tool for total amount by nothing, total amount by region, and total credit limit by nothing. Record what each tool returns. A tool that keeps the orphan reports 500 in total and shows 50 under a null region. A tool that drops it reports 450. A tool that fans out reports a credit limit of 4,000. This is the compliance fixture Damian proposed, built by hand.

## Filter propagation: the third hidden decision

Cardinality and join type decide which rows a join produces. A third decision decides which rows a filter reaches, and it is the least portable of the three.

Julian Hyde's fourth question named it. In DAX, a filter on a dimension flows across a relationship from the one side to the many side. Filter customers to EMEA, and orders are filtered to EMEA customers automatically. Power BI lets modelers set the direction per relationship, including bidirectional filtering, which also lets a filter on orders restrict which customers appear.

Other tools behave differently. Some apply filters only to the tables a query touches. Some propagate along the join path the query uses and nowhere else. Some treat a filter on a dimension as a filter on the joined result, which gives the same effect as one-way propagation for simple queries and different results for queries that touch several fact tables.

Here is a case where the difference shows. A model has two fact tables, orders and returns, both related to customers. A user asks for total orders and total returns, filtered to customers in EMEA. A tool that propagates the customer filter to both fact tables returns EMEA orders and EMEA returns. A tool that applies the filter only along one join path returns EMEA orders and all returns. Both queries are valid SQL.

Matthew's cardinality proposal deliberately keeps filter propagation out of scope, and Damian's join type argument respects that line. Both are right to. Filter propagation is a query semantics decision, and Ossie places query semantics in Layer 3. The practical consequence for anyone moving models between tools is that propagation behavior does not travel with the model today. If a dashboard depends on bidirectional filtering in its source tool, expect it to behave differently after conversion, and test multi-fact queries specifically.

## What converter authors should do now

Converters are where these gaps turn into wrong numbers, because a converter has to produce a complete native model from an incomplete interchange document. Damian's posts amount to a working policy for converter authors, and I recommend it as written.

**Never choose silently.** When the target format requires a value the Ossie document does not carry, such as a join type, choose the safe default and say so in the output. A warning that only reaches the converter's own logs is not enough. Put it where the model owner sees it, such as a description field on the converted relationship.

**Keep the many side by default.** When the join type must be invented, pick the join that preserves fact rows. Under the from/to convention, that means a left outer join from `from` to `to`. It never drops measure rows, and it matches the Layer 3 lowering.

**Use cardinality when it exists.** If the document records cardinality in an extension today, or in the official field once it lands, derive the join type from it. The mapping Damian published, left outer for many-to-one and one-to-one, right outer for one-to-many, is a good starting point.

**Refuse what you cannot guarantee.** If an expression's meaning depends on the target tool's query-time behavior, carry it only in the vendor dialect and leave the portable expression empty. A missing expression is visible. A wrong one is not.

**Contribute a fixture.** Every converter author who hits a semantic gap holds a test case the community needs. The compliance tests under construction turn those cases into shared checks that every consumer runs.

## How agents raise the stakes

BI tools have lived with these differences for years. Analysts learned which tool did what, and dashboard reviewers caught suspicious totals. Agents change three things.

**Agents switch tools freely.** An agent answering a question picks a tool by capability, not habit. The same metric can be served through different engines on different days. If those engines interpret relationships differently, the agent's answers drift.

**Agents trust the model.** An agent that reads a semantic model treats relationships as facts about the data. It has no experience telling it that this tool drops orphans. It writes SQL from the model and reports the number with confidence.

**Agents write SQL themselves.** An agent working at Layer 2 generates joins directly. If the relationship carries no join type, the agent picks one, and language models tend to write `JOIN`, which means inner join, unless told otherwise. That is the ThoughtSpot converter's original mistake, made by a model instead of a converter.

The defense is to put the facts in the model. An explicit cardinality tells the agent which side is the many side. An explicit join type, or a spec statement that consumers must keep the many side, tells it which rows survive. The layered approach, where agents use Layer 3 declarative queries that compile to left joins, avoids the problem entirely for agents that stay inside it. Why that layering matters for agent architectures is covered in [Anatomy of an Agentic Lakehouse](https://datalakehousehub.com/blog/anatomy-agentic-lakehouse-four-layers/).

## Modeling guidance until the spec settles

You do not need to wait for a vote to protect your numbers. These steps work with today's spec and today's tools.

1. **Declare every relationship with the many side in `from`.** Follow the convention strictly, since every converter relies on it. If a relationship genuinely runs one-to-many from your natural starting point, flip it.
2. **Record cardinality in an extension until the field exists.** Some converters already preserve cardinality through custom extensions. A recorded value beats an implied one, and it makes migration to the official field trivial.
3. **Measure orphan rates.** For every relationship, count fact rows whose keys match nothing. If the count is zero and stays zero, join type does not matter for that relationship. If it is not zero, every consumer's join choice matters.
4. **Add an "unknown" dimension member.** Many teams load a placeholder row, such as customer ID -1 with region "Unknown," and map orphan keys to it during ingestion. Inner and left joins then return the same totals.
5. **Run the fixture in every consumer.** Build the two-table test above in your lakehouse and query it through each BI tool, semantic layer, and agent you support. Record which ones drop the orphan.
6. **Document consumer behavior per relationship.** Where a tool's join choice cannot be controlled, write it down next to the model. Julian's point stands: declared behavior beats hidden behavior.
7. **Test a multi-fact query too.** Add a second fact table, such as returns, related to the same customers table. Ask each tool for total orders and total returns filtered to one region. This catches differences in filter propagation that the single-fact fixture misses.
8. **Pin semantic model versions.** When you change a relationship's direction or record a new cardinality, version the model and note which tools have picked up the change. A relationship fix that reaches one consumer and not another creates exactly the drift this article describes, only on purpose.

## Where this is heading

Several threads are converging. Matthew's cardinality PR is close on substance, with naming and the reverse direction still open. Damian's join type question is new, and he framed it as compatible with the cardinality work rather than competing with it. The compliance test framework is taking shape. Chris Eubank noted that existing test cases and Julian Hyde's testing framework will make new cases easier to add, and the project approved DuckDB as a test dependency for its compliance tests in a PPMC vote that closed on November 14.

A related thread on November 16, also from Damian, showed a deeper version of the same issue. Some vendor expressions, such as moving-window formulas, take their grain from the query's dimensions at run time. The same stored formula partitions by category in one query and by brand in another. His team decided to stop emitting portable SQL for those constructs and to carry only the vendor dialect, rather than emit an expression that computes a different number elsewhere. That rule, never emit an expression you cannot guarantee, is the right posture for every converter author working with Ossie today. More on how semantic layers turn requests into SQL is in [The Semantic Layer as a Translation Engine](https://datalakehousehub.com/blog/semantic-layer-translation-engine/).

## Conclusion

A relationship between two datasets hides two decisions: which side can repeat, and which rows survive when keys do not match. Get the first wrong and totals inflate. Get the second wrong and they shrink. Ossie's Layer 3 already answers both for its own declarative queries, with many-to-one paths and left joins. The gaps appear when models move into tools that need an explicit join type and find none.

The November threads are filling those gaps from both sides. Explicit cardinality tells every consumer which side is the many side. An explicit join type, or a spec statement about keeping the many side, tells them what to do with orphans. Until both land, follow the from/to convention strictly, measure orphan rates, and run the two-table fixture through every tool that serves your metrics.

## Keep Going

If this piece was useful, I have written a lot more on semantic layers and how agents use them. My books cover lakehouse architecture, semantic modeling, and governed agent access to data through open standards such as Apache Iceberg and Apache Ossie. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
