---
title: "Small Language Models for Data Agents: Where They Win and Where They Fail"
description: "Where small language models win inside a data agent and where they fail, plus a routing architecture that escalates only when needed."
date: 2026-10-05T09:00:00Z
tags: ["small language models", "AI agents", "semantic layer", "LLM routing"]
canonical: https://iceberglakehouse.com/posts/small-language-models-data-agents/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/small-language-models-data-agents/).

Look at the bill for a data agent that has been running for a month. Most of the tokens did not go to hard reasoning. They went to routine work: deciding whether a message is a data question, matching "Q3" to a fiscal calendar, picking `net_revenue` from a list of 40 metrics, checking a result for personal data, and turning a six-row table into two sentences. Every one of those steps ran on the largest model available to the team, because that was the model the prototype used.

That default made sense during the prototype. When you do not yet know which parts of the problem are hard, you use the most capable model everywhere and find out. It makes less sense in production, where the same routine steps run thousands of times a day, add seconds of latency to every answer, and send company data to an external API for tasks a model one fiftieth the size handles well.

Small language models, roughly the open-weight models under about 15 billion parameters, have become good enough to take over a large share of that routine work. They are not good enough to take over all of it. The interesting question for a data team is not whether small models are good. It is which steps inside a data agent they handle reliably, what architecture keeps them inside those steps, and how you prove the split works before you rely on it.

This article answers those questions. It breaks a data agent into its component tasks, shows which ones suit small models, explains why a governed semantic layer changes the math in their favor, walks through constrained decoding and a routing design with code, and covers the failure modes to watch. It also makes the case that the open lakehouse is what makes this kind of model flexibility safe: when Apache Iceberg tables, an Apache Polaris catalog, and Apache Ossie metric definitions carry the data, permissions, and meaning, the model becomes a replaceable part.

A disclosure: I work at Dremio, which builds a semantic layer and an MCP server that agents use. Nothing here depends on any one vendor's product.

## How the Biggest Model Became the Default

Data agents grew out of chat. The first ones were a large model with a system prompt, a schema dump, and a tool that ran SQL. Everything happened inside one model call or a loop of them: understand the question, find the tables, write the query, read the result, explain it. Only a frontier model handled all of that in one pass, so the frontier model became the agent.

Three things have changed since.

**Agents became pipelines.** Production data agents now split work into stages, with separate steps for intent detection, retrieval of relevant metadata, query construction, validation, execution, and explanation. Each stage has a narrow job and a checkable output. Narrow jobs with checkable outputs are exactly where small models do well.

**The semantic layer moved in front of the data.** Teams learned, often painfully, that letting a model write free-form SQL against raw tables produces queries that run cleanly and return wrong numbers. Agents increasingly query a governed semantic layer instead, choosing metrics and dimensions by name. Choosing from a list is a much smaller task than writing SQL from scratch.

**Small models got much better.** The current generation of small open-weight models handles tool calling, structured output, and long context in ways the 7-billion-parameter models of two years ago did not. Families such as Google's Gemma 4, Alibaba's Qwen3 and Qwen3.5 small sizes, Microsoft's Phi-4, Mistral's Ministral 3, IBM's Granite 4.1, and NVIDIA's Nemotron 3 Nano all target agent workloads on modest hardware, and several ship under the Apache 2.0 license.

Put those together and the old default stops holding. A pipeline of narrow, checkable steps over a governed semantic layer is a workload where many steps no longer need the largest model.

## What "Small" Means in Practice

"Small" is a moving target, so it helps to define it by what you can run rather than by a fixed parameter count.

A practical definition: a small model is one you can serve on hardware you control, at the latency your users expect, at a cost low enough that you stop thinking about per-call pricing. In late 2026 that usually means open-weight models from under 1 billion up to about 15 billion parameters, plus mixture-of-experts models whose active parameters per token fall in that range even when their total size is larger.

Memory is the first constraint. A model's weights take roughly its parameter count times the bytes per parameter. An 8-billion-parameter model in 16-bit precision needs about 16 GB just for weights. Quantized to 4 bits, the same model needs about 4 to 5 GB. On top of the weights, the server needs memory for the key-value cache that holds the context of in-flight requests, and that grows with context length and concurrency. A data agent that stuffs 20,000 tokens of metadata into every prompt needs far more cache memory than one that sends 2,000.

The second constraint is latency. Small models generate tokens quickly on a single GPU, and a well-served 4B to 8B model returns a short structured answer in well under a second. That speed matters more than it first appears. A data agent pipeline with five model calls in sequence adds up every one of them, and shaving each step from three seconds to half a second changes how the agent feels to use.

The third constraint is quality on your tasks, which is the only one you cannot read off a spec sheet. A model that scores well on general benchmarks can still mangle your fiscal calendar. That is why the measurement section later in this article matters more than any model list.

Serving has become straightforward. vLLM, llama.cpp, Ollama, and similar servers expose OpenAI-compatible APIs, so the agent code that calls a hosted frontier model can call a local small model by changing a base URL. Most of them also support constrained decoding, which turns out to be the key feature for data agents.

## The Work Inside a Data Agent, Split by Difficulty

The useful way to think about small models is task by task. Here is a typical data agent broken into its steps, with an honest read on which model tier each one needs.

| Step | What it does | Output shape | Small model fit |
|---|---|---|---|
| Intent routing | Decide if a message is a data question, a follow-up, a definition request, or out of scope | One label from a fixed set | Strong |
| Sensitive data screening | Flag personal or restricted data in questions and results | Labels and spans | Strong |
| Value and entity resolution | Map "EMEA," "Q3," or "Acme" to real dimension values | Values from a known list | Strong with lookups |
| Metric and dimension selection | Pick governed metrics, dimensions, filters for a semantic query | Structured object from a closed vocabulary | Good with constraints |
| Result narration | Turn a small result table into a short summary | Two to four sentences | Good |
| Query repair | Fix a semantic query after a typed error from the engine | Edited structured object | Fair |
| Multi-step planning | Break a vague business question into a sequence of queries | Plan with dependencies | Weak |
| Free-form SQL over raw tables | Write joins, windows, and subqueries from scratch | Arbitrary SQL | Weak |

Read the table as a gradient, not a verdict. The first five rows share a property: the output space is small and checkable. A label from a list of six, a value that must exist in a dimension table, a metric name that must exist in the semantic model, or a short summary of six rows. Small models do well when the answer has a narrow shape and something downstream verifies it.

The last two rows are different. Planning a multi-step analysis needs the model to hold the business context, anticipate what each intermediate result will show, and decide what to ask next. Writing free-form SQL over a large raw schema needs it to infer join paths, grain, and business rules that are not written down anywhere the model can see. Those are the tasks where research benchmarks show even frontier models struggling. Spider 2.0, a benchmark of enterprise-style text-to-SQL workflows, reported that the strongest traditional text-to-SQL method solved only 5.7 percent of its lite questions, against 91.2 percent on the original academic Spider. Agentic systems have improved those numbers considerably since, but the tasks remain hard. A small model will not close that gap on its own.

Two middle rows deserve a note.

**Value resolution** looks like a language task and is mostly a lookup. "EMEA" has to become the exact string in your region dimension. A small model that proposes candidates, combined with a lookup against distinct dimension values or a small embedding index over them, beats a large model guessing from memory. The model's job is to say which phrase in the question is a value and which dimension it belongs to. The catalog's job is to say what values exist.

**Query repair** depends on how good the errors are. When the semantic engine returns a typed error such as "ambiguous join path between orders and support," a small model can often pick the fix from a short list of options. When the engine returns a stack trace, the repair needs more reasoning than a small model reliably provides.

The practical upshot: in a well-built agent, most model calls fall in the top five rows. In many pipelines that is the large majority of calls, which is where the cost and latency savings come from.

## Why the Semantic Layer Changes the Math

The single biggest factor in whether a small model can run your data agent is not the model. It is what the model is asked to produce.

Ask a model to write SQL against 400 raw tables and it has to solve schema linking, join inference, grain management, business rule recall, and dialect syntax at once. Every one of those is a place to go wrong, and the errors compound. That task needs the most capable model you can afford, and even then it fails often.

Ask a model to fill in a semantic query and the task shrinks dramatically. The semantic layer already knows the join paths, the grain of each metric, and the business rules inside each definition. The model only has to choose which governed metrics, which dimensions, which filter values, and which time window. Its output is a small object where every field must come from a vocabulary the semantic model defines.

Apache Ossie, the open specification for semantic model interchange that grew out of the Open Semantic Interchange effort, makes this concrete. An Ossie model defines datasets, fields, relationships, and metrics in vendor-neutral YAML or JSON, and it carries an `ai_context` field for instructions and synonyms aimed at AI consumers. The Ossie community is also working out standard query interfaces, including a dimensional interface where a consumer names measures and dimensions and the engine handles every join. For a small model, that dimensional shape is close to ideal: a short, well-typed form to fill in, with a closed list of valid names.

The semantic layer also provides the other half of what small models need, which is a verifier. A dimensional query that names a metric that does not exist fails validation immediately. A query that asks for an impossible combination returns a typed error rather than a plausible wrong number. Small models make more mistakes than large ones, so the system around them has to catch mistakes cheaply. A semantic layer with strict validation and typed errors does exactly that.

There is a context benefit too. A model writing raw SQL needs the schema in its prompt, and a large schema eats tens of thousands of tokens. A model filling in a semantic query needs only the list of relevant metrics and dimensions with short descriptions, often a few hundred tokens after retrieval narrows it down. Shorter prompts mean less cache memory, faster responses, and better accuracy, because small models degrade faster than large ones as context grows.

The summary is simple. A semantic layer turns the hardest step in a data agent into a constrained selection task, and constrained selection is where small models are strongest.

## Constrained Decoding: Making a Small Model Speak Your Semantic Model

Small models fail in two broad ways on structured tasks. They choose the wrong thing, such as the wrong metric. And they produce the wrong shape, such as invalid JSON, a metric name that does not exist, or a misspelled dimension. The second kind of failure is entirely preventable.

Constrained decoding, also called structured output or guided generation, restricts what tokens the model is allowed to produce at each step so the output always matches a grammar or a JSON schema. If the schema says the `metrics` field is a list of strings drawn from an enumerated set, the model physically cannot emit a metric name outside that set. vLLM supports this through its OpenAI-compatible API, and llama.cpp supports it through grammars. Other servers offer similar features.

For a data agent, the trick is to build the JSON schema from the semantic model itself, at request time, after retrieval has narrowed the candidates. Here is an example that serves a small model with vLLM and asks it to fill in a dimensional semantic query.

First, serve the model. The command below starts vLLM's OpenAI-compatible server with tool calling enabled.

```bash
vllm serve Qwen/Qwen3-8B \
  --host 0.0.0.0 --port 8000 \
  --max-model-len 16384 \
  --enable-auto-tool-choice \
  --tool-call-parser hermes
```

`--max-model-len` caps the context window, which caps cache memory per request. A data agent that sends short, retrieved context does not need the model's full context length, and a lower cap lets the server handle more concurrent requests on the same GPU. The two tool flags let the model emit tool calls in a format vLLM parses. This example uses structured output rather than tool calls, but most agents need both.

Next, build the schema from the semantic model and call the server.

```python
import json
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="unused")

def build_query_schema(metrics: list[dict], dimensions: list[dict]) -> dict:
    """JSON schema for a dimensional semantic query, limited to retrieved candidates."""
    metric_names = [m["name"] for m in metrics]
    dimension_names = [d["name"] for d in dimensions]
    return {
        "type": "object",
        "properties": {
            "metrics": {
                "type": "array",
                "items": {"type": "string", "enum": metric_names},
                "minItems": 1, "maxItems": 4,
            },
            "dimensions": {
                "type": "array",
                "items": {"type": "string", "enum": dimension_names},
                "maxItems": 4,
            },
            "filters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "dimension": {"type": "string", "enum": dimension_names},
                        "operator": {"type": "string", "enum": ["equals", "in", "between", "gte", "lte"]},
                        "values": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["dimension", "operator", "values"],
                },
            },
            "time_grain": {"type": "string", "enum": ["day", "week", "month", "quarter", "year", "none"]},
            "needs_clarification": {"type": "boolean"},
        },
        "required": ["metrics", "dimensions", "filters", "time_grain", "needs_clarification"],
    }

def describe(items: list[dict]) -> str:
    return "\n".join(f"- {i['name']}: {i['description']}" for i in items)

def fill_semantic_query(question: str, metrics: list[dict], dimensions: list[dict]) -> dict:
    schema = build_query_schema(metrics, dimensions)
    system = (
        "You translate business questions into semantic queries.\n"
        "Use only the metrics and dimensions listed. If the question is ambiguous "
        "or none of the metrics fit, set needs_clarification to true.\n\n"
        f"Metrics:\n{describe(metrics)}\n\nDimensions:\n{describe(dimensions)}"
    )
    response = client.chat.completions.create(
        model="Qwen/Qwen3-8B",
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": question}],
        temperature=0,
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "semantic_query", "schema": schema},
        },
    )
    return json.loads(response.choices[0].message.content)
```

Walk through the pieces.

`build_query_schema` turns the retrieved metric and dimension lists into enumerations. The `enum` constraints are what make the call safe. Even when the model misunderstands the question, every metric and dimension name it returns exists in the semantic model. The `maxItems` limits keep the model from listing every metric it was shown, a common small-model habit.

`filters` holds dimension, operator, and values. The dimension is constrained, and the operator comes from a short list. The values stay free text on purpose, because valid values change daily and enumerating them all in a schema does not scale. The next step resolves them against the catalog.

`needs_clarification` gives the model a sanctioned way to say "I am not sure." Without it, a small model asked an ambiguous question picks something plausible, because the schema forces it to produce a query. With it, the pipeline can route ambiguous questions to a clarifying reply or to a larger model.

`describe` formats each candidate with its description. Those descriptions come from the semantic model, and in an Ossie model they come from the `description` and `ai_context` fields the model authors wrote. The quality of these descriptions affects small-model accuracy more than almost any other factor, because a small model leans on them heavily to tell `gross_revenue` from `net_revenue`.

`temperature=0` makes output as repeatable as the server allows. For selection tasks, you want the same question to produce the same query.

`response_format` with a JSON schema tells the server to constrain decoding to that schema. The returned content is guaranteed to parse and to match the enumerations.

After this call, the pipeline resolves filter values against real dimension values, submits the query to the semantic layer, and handles any typed error. The model never writes SQL and never touches a join. It picks from lists, which is the job it is good at.

## A Routing Architecture: Small First, Escalate When Needed

The cleanest production pattern is a cascade. Every request starts with small models. Each step has a verifier. When a verifier fails, or a model signals uncertainty, the request escalates to a larger model for that step only.

The cascade for a typical question looks like this.

1. A small classifier labels the message: data question, follow-up, definition request, or out of scope. Out-of-scope messages get a polite reply without touching data.
2. Retrieval pulls candidate metrics and dimensions from the semantic model, using embeddings over names, descriptions, and synonyms.
3. A small model fills in the semantic query under constrained decoding.
4. Value resolution maps filter values to real dimension values.
5. The semantic layer validates and executes the query.
6. A small model narrates the result.

Escalation triggers sit between the steps. The small model set `needs_clarification`. Value resolution found no match, or several equally good matches. The semantic layer returned a typed error the repair step failed to fix in one attempt. The classifier labeled the message as a multi-step analysis. Each trigger sends that step, with the same context, to a frontier model.

Here is the routing logic in compact form.

```python
from dataclasses import dataclass

@dataclass
class StepResult:
    output: dict | None
    ok: bool
    reason: str = ""

def answer(question: str, user, small, large, semantic, catalog) -> dict:
    intent = small.classify(question, labels=["data", "follow_up", "definition", "multi_step", "out_of_scope"])
    if intent == "out_of_scope":
        return {"kind": "reply", "text": "I can answer questions about the governed data models."}
    if intent == "multi_step":
        return large.plan_and_run(question, user=user, semantic=semantic)

    metrics, dims = semantic.retrieve_candidates(question, user=user, k=12)

    query = small.fill_semantic_query(question, metrics, dims)
    if query["needs_clarification"]:
        query = large.fill_semantic_query(question, metrics, dims)
        if query["needs_clarification"]:
            return {"kind": "clarify", "text": large.clarifying_question(question, metrics, dims)}

    resolved = catalog.resolve_filter_values(query["filters"], user=user)
    if not resolved.ok:
        return {"kind": "clarify", "text": f"Which one did you mean: {resolved.reason}?"}
    query["filters"] = resolved.output

    result = semantic.execute(query, user=user)
    if not result.ok:
        repaired = small.repair(query, error=result.reason)
        result = semantic.execute(repaired, user=user) if repaired else result
        if not result.ok:
            repaired = large.repair(query, error=result.reason)
            result = semantic.execute(repaired, user=user)
    if not result.ok:
        return {"kind": "cannot_answer", "text": f"No safe answer for that question: {result.reason}"}

    return {"kind": "answer", "table": result.output, "summary": small.narrate(question, result.output)}
```

Walk through the decisions this encodes.

The classifier runs on the small model, and the only route that skips straight to the large model is the multi-step label. That keeps the expensive path for the questions that need it.

`retrieve_candidates` takes the user, because the candidates should already respect what the user is allowed to see. A metric built on a table the user cannot read should not appear in the list at all.

The small model gets the first attempt at filling the query. If it signals uncertainty, the large model gets the same inputs. If the large model is also uncertain, the agent asks the user rather than guessing. That last rule matters more than any model choice.

Value resolution is a catalog lookup, not a model call. When it finds no match or several close matches, the agent asks.

Repair follows the same cascade: one small-model attempt, then one large-model attempt, then an honest "cannot answer" with the engine's reason attached. The agent never loops indefinitely and never falls back to raw SQL to force an answer.

Narration goes to the small model because the input is a small, already-correct table. The numbers in the summary come from the table, not from the model's memory, so a small model's weaker world knowledge does not matter here. A cheap check that every number in the summary appears in the result table catches the rare case where it invents one.

In this design, a typical question costs four or five small-model calls and zero large-model calls. The large model shows up only on the questions that are genuinely hard, ambiguous, or broken, which is where its cost is justified.

## A Worked Example, End to End

Here is one question traced through the cascade, to make the moving parts concrete.

A sales director types: "How did net revenue in EMEA compare month by month this quarter?"

The small classifier labels it a data question, not a multi-step analysis. One metric over one time grain with one filter is a single semantic query.

Retrieval searches the semantic model's metric and dimension descriptions and returns twelve candidates. Among them are `net_revenue`, `gross_revenue`, and `bookings` as metrics, and `sales_region`, `billing_country`, and `order_month` as dimensions. The candidate list already excludes metrics built on tables the director cannot read, because retrieval runs as the director's principal.

The small model fills in the semantic query under the JSON schema. It returns `net_revenue` as the metric, `order_month` as the dimension, a filter on `sales_region` equals "EMEA," a filter on the order date for the current fiscal quarter, a time grain of month, and `needs_clarification` set to false. Every name in that object came from the enumerations, so none of them can be invented.

Value resolution looks up "EMEA" among the distinct values of `sales_region` and finds an exact match. "This quarter" resolves through the fiscal calendar the semantic model defines, not through the model's guess about calendars. If the company's fiscal year started in February, the date range reflects that, because the rule lives in the semantic layer.

The semantic layer validates the query, plans the joins it already knows about, and executes against the Iceberg tables through the engine. The engine reads only the files the catalog allowed for this principal. Three rows come back as an Arrow table, one per month.

The small model narrates: net revenue in EMEA rose in the second month and dipped slightly in the third, with the three monthly figures stated. A check confirms that every number in the summary appears in the result table.

Total: four small-model calls, one catalog lookup, one query, no large-model calls, and an answer in a couple of seconds. Now change the question to "Why did EMEA dip in the third month?" The classifier labels that a multi-step analysis, because answering it means breaking the dip down by product, customer segment, and deal size and comparing them. The cascade hands it to the frontier model, which plans those queries against the same semantic layer and the same permissions. Same agent, same data plane, different model for a different kind of work.

## Why the Data Plane Matters More Than the Model

Routing between models is only safe if nothing important depends on which model ran. That is a property of the data platform, not the model, and it is where the open lakehouse earns its keep.

**Permissions live in the catalog, not the prompt.** When an agent queries Iceberg tables through an Apache Polaris catalog, the catalog decides what each principal can read, and it vends storage credentials scoped to that decision. A small model that misunderstands a question cannot widen its own access, and neither can a large one. The model chooses what to ask for. The catalog decides what it gets. Swapping models changes nothing about who sees what.

**Meaning lives in the semantic model, not the weights.** Metric definitions written in Apache Ossie sit in version control and in the catalog, readable by every engine and every model. When you replace a model, it reads the same definitions, the same descriptions, and the same `ai_context` instructions. Nothing about "net revenue" has to be re-taught, because the model was never the place it was stored.

**Data stays in place.** Iceberg tables in object storage, in Apache Parquet files, can be read by any engine that speaks the format. A small model running on a GPU in your own network can drive queries against the same tables your BI tools use, through the same semantic layer, without copying data into a vendor's environment. For regulated industries and air-gapped deployments, that is often the deciding factor. A small model plus an open lakehouse runs entirely inside your boundary.

**Results move in columnar form.** Apache Arrow carries query results from the engine to the agent without serialization overhead, through Arrow Flight or ADBC drivers. For narration and verification steps that run on a small model next to the engine, results arrive fast and typed, and checks such as "does every number in the summary appear in the result" run directly against Arrow arrays.

Put together, these properties make the model a replaceable component. That is the real argument for small models in data agents. A small model saves money and latency, and that matters. More important, an architecture designed so a small model can do the job is an architecture where no model holds your permissions, your definitions, or your data hostage. When next quarter's small model is better, you swap it in and run your tests.

## Measure Before You Switch

Everything above is a hypothesis until you test it on your own questions. General leaderboards rank models on general tasks. Your tasks are picking the right metric from your semantic model, resolving your region names, and summarizing your results. The only way to know whether a small model handles them is to run it against a fixed set of questions with known answers and compare the scores to your current model.

That fixed set is a golden-question benchmark: questions written from real usage, each with an expected answer computed against frozen table versions, an expected behavior for questions that should get a clarification or refusal instead of a number, and a category tag so you see results by task type. I cover how to build one, including freezing the data with Iceberg tags and scoring results with Arrow, in [How to Build a Golden-Question Benchmark for Your Data Agents](https://datalakehousehub.com/blog/data-agent-golden-question-benchmark/).

For a model routing decision, run the benchmark in three configurations: everything on the frontier model, everything on the small model, and the cascade. Then compare four numbers per category.

**Pass rate.** The share of questions answered correctly or handled with the right behavior. The cascade should match the frontier configuration within a few points on every category. If one category drops sharply, that step needs a larger model or a better verifier.

**Escalation rate.** The share of questions where the cascade called the large model at least once. This tells you what the cascade actually saves. A cascade that escalates 70 percent of questions saves little and adds latency.

**Cost per question.** Tokens and compute per question, for each configuration. Count the small model's serving cost honestly, including the GPU running idle overnight.

**Latency.** Median and 95th percentile time to answer. Cascades usually lower the median and raise the tail, because escalated questions pay for two attempts.

Measure step-level accuracy too, not only end-to-end results. Score the classifier's labels, the metric selection, and the value resolution separately against hand labels. When the end-to-end score drops, step-level scores tell you which step to fix.

Two habits keep these comparisons honest. Run each configuration several times and use the median, because model output varies between runs even at low temperature. And keep a blind subset of questions that nobody tunes prompts against. Small models are easy to overfit with prompt tweaks, and a blind set shows whether improvements generalize.

## Failure Modes and Warning Signs

Small models in data agents fail in recognizable ways. Most of them trace back to giving the model a task wider than it handles, or to missing a verifier.

**Plausible wrong selection.** The small model picks `gross_revenue` when the user meant net revenue, or `order_date` when the question was about ship date. The output is valid, the query runs, and the answer is wrong. The warning sign is a cluster of benchmark failures where the generated query is well-formed but uses a sibling metric. The fixes, in order of impact: better metric descriptions and synonyms in the semantic model, fewer and more distinct candidates from retrieval, and few-shot examples showing the distinction.

**Overconfidence on ambiguous questions.** Small models rarely set the uncertainty flag on their own. They pick an interpretation and commit. The warning sign is a low clarification rate on questions your benchmark marks as ambiguous. Add explicit ambiguous examples to the prompt, and add a cheap ambiguity check: when retrieval returns two metrics with very similar scores, treat the question as ambiguous regardless of what the model says.

**Context overload.** Retrieval returns 60 candidate metrics because the threshold is loose, and the small model's accuracy falls off. Small models degrade faster than large ones as prompts grow. The warning sign is accuracy that drops as the semantic model grows, with no change to the model or prompt. Cap candidates at around 10 to 15, and tune retrieval before tuning the model.

**Narration drift.** The small model adds a number to its summary that is not in the result, often a percentage it computed incorrectly or a figure from the question. The warning sign is user corrections on summaries rather than tables. Check every number in the narration against the result table and regenerate, or drop the summary, when the check fails.

**Escalation creep.** Over months, the escalation rate climbs from 10 percent to 50 percent as the question mix shifts, and nobody notices because answers stay correct. Cost and latency rise back toward the frontier-only baseline. Track escalation rate per category as a first-class metric, with an alert threshold.

**Silent model updates.** A new quantization or a new point release of the small model goes into serving without a benchmark run. Quantization in particular changes behavior on edge cases. Treat any change to the model artifact, quantization level, or serving parameters as a release that must pass the benchmark.

**Falling back to raw SQL.** Someone wires a fallback that lets the large model write SQL against raw tables when the semantic query fails, to "answer more questions." It does answer more questions. Some of the answers are wrong in ways the semantic layer existed to prevent. The warning sign is generated SQL against physical tables in your query logs. Answer "cannot answer safely" instead, and add the missing metric or relationship to the semantic model.

**Tokenizer and language gaps.** Some small models handle non-English questions, unusual product names, or code-heavy identifiers much worse than frontier models. The warning sign is accuracy that varies by region or business unit. Add questions in every language and naming style your users actually use to the benchmark, and check per-segment scores.

## Operational Guidance

Here is how to introduce small models into an existing data agent without breaking it.

**Start with the safest steps.** Intent classification and result narration are the easiest wins. Their outputs are short, their errors are visible, and they run on every question, so they account for a large share of calls. Move them first, measure, and leave query construction on the frontier model until those two are stable.

**Move query construction second, behind constraints.** Switch metric and dimension selection to a small model only after the semantic layer, constrained decoding, and the escalation path are in place. Run the cascade in shadow mode for a week first: the small model fills in a query for every question, the frontier model still answers, and you compare the two offline.

**Size the hardware for concurrency, not for one request.** A single GPU serving a 4B to 8B model handles many concurrent agent sessions when prompts stay short. Measure your real prompt lengths and peak concurrency, then size cache memory accordingly. Set the maximum context length to what your prompts need rather than what the model supports.

**Pin everything.** Record the model name, the exact weights revision, the quantization, and the serving parameters with every benchmark run and every production deployment. Small-model ecosystems release often, and an unpinned dependency changes behavior without telling you.

**Check the license.** Open-weight models ship under different licenses, from permissive Apache 2.0 to custom terms with usage restrictions. Read the license for the exact model and size you deploy. Your legal team will ask, and the answer differs between families and sometimes between sizes in the same family.

**Keep the frontier model in the loop deliberately.** The goal is not to remove large models. It is to reserve them for planning, ambiguous questions, and repair, where they are worth the cost. Budget for that escalation share explicitly, and treat a sudden rise as a signal that something upstream changed.

**Invest in the semantic model.** Every improvement to metric descriptions, synonyms, and `ai_context` instructions in your semantic model helps small models more than large ones. If your semantic models are in Apache Ossie, those improvements also carry across every engine and tool that reads the format. It is the cheapest accuracy gain available, and it outlives any model you deploy.

## Where This Is Heading

Three trends point in the same direction.

Small models keep improving at agent-shaped tasks. The current families explicitly target tool calling and structured output on constrained hardware, and each generation closes more of the gap on narrow tasks. The steps that need a frontier model today will shrink over the next year, especially for selection and repair.

The semantic layer is becoming a standard interface. Apache Ossie's community is defining how consumers query semantic models, including a dimensional interface where the consumer names measures and dimensions and the engine owns every join, with typed errors when no safe answer exists. A standard, constrained query interface with clear errors is close to the ideal target for a small model, and it means the same small-model pipeline works against any engine that implements it.

Data platforms are becoming the place where agent context lives. Catalogs such as Apache Polaris already govern access to Iceberg tables across engines. As semantic models, verified queries, and agent instructions move into the same open catalogs, more of the knowledge an agent needs sits in the platform rather than in the model's weights. The less knowledge the model has to carry, the smaller the model can be.

## Conclusion

Most of the work inside a production data agent is routine: classifying intent, screening for sensitive data, resolving values, selecting metrics, and summarizing small results. Small open-weight models now handle that work well, at a fraction of the latency and cost of frontier models, and on hardware you control. They still struggle with multi-step planning and free-form SQL over large raw schemas, and nothing in this article changes that.

The architecture is what makes the split work. Put a governed semantic layer in front of the data so the model selects from a closed vocabulary instead of writing SQL. Use constrained decoding so outputs always match that vocabulary. Run a cascade that starts small, verifies every step, and escalates only when a verifier fails or the model signals doubt. And measure the whole thing against your own golden questions before and after every change.

The open lakehouse makes this safe. When Iceberg holds the data, Polaris enforces the permissions, Ossie carries the meaning, and Arrow moves the results, the model becomes a component you can swap. That freedom is worth more than any single model choice, because the best small model for your agent next year has not been released yet.

## Keep Going

If this piece was useful, I have written a lot more on building AI agents on top of open lakehouse data. *Evaluating AI Systems: Testing LLMs, RAG, and Agents* covers how to test model choices like the ones in this article before they reach users. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
