---
title: "Your Data Agents Are CPU-Bound, and the Hardware Market Just Noticed"
description: "Analytics agents spend most of their time on CPU-bound tool calls, not the model. Size three planes separately and measure your ratio from traces."
date: 2026-10-21T09:00:00Z
tags: ["agentic analytics", "AI agents", "lakehouse", "capacity planning"]
canonical: https://datalakehousehub.com/blog/agentic-analytics-cpu-sizing/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/agentic-analytics-cpu-sizing/).

A data team gets budget for an agentic analytics pilot. The plan is simple. Give business users an agent that answers questions by querying the lakehouse, and buy enough GPU capacity, or enough model API credit, to keep the model fast. The pilot launches. Users like it. Then the complaints start: answers take 40 seconds, and the slow part is not the model.

Traces show the shape. The model takes a second or two to plan. Then the agent calls a tool to list tables, another to read a schema, another to run a SQL query, another to profile a column, and another to run a corrected query. Each tool call waits on a query engine, a catalog, a JSON parser, and a network round trip. The model sits idle between calls. The time goes to work that runs on general-purpose CPU cores, and nobody sized those cores for this.

On October 12, 2026, AMD announced Helion, an open rack blueprint built specifically for agentic AI. Its headline configuration has no GPUs at all. It is a CPU-only rack of 6th Gen EPYC processors supporting up to 32,768 cores, meant to run agent execution separately from model inference. When a GPU vendor publishes a reference design whose flagship holds zero GPUs, it is telling you where it thinks the next bottleneck is.

This article explains why agentic analytics workloads lean so heavily on CPU, where the cycles go in a lakehouse agent's loop, what Helion and recent research say about the shift, and how to size the CPU side of an agent deployment before users find the bottleneck for you.

## How AI Infrastructure Got GPU-Shaped

For most of the last decade, "AI infrastructure" meant training, and training is matrix multiplication. Large language model training and inference spend nearly all their time in dense linear algebra, which GPUs do far better than CPUs. So the budget conversation narrowed to one question: how many accelerators, and of which generation.

Chat-style inference kept that framing intact. A chatbot request is one model call. A prompt goes in, tokens come out, and the CPU's job is to receive the request, tokenize it, hand it to the GPU, and stream the result back. Host CPU work in that pattern is real but small, so infrastructure teams sized servers around GPU memory and GPU count and treated the host CPU as a fixed overhead.

Agents broke that pattern without anyone announcing it. An agent request is a loop. The model plans a step, the runtime executes a tool, the result goes back to the model, and the model plans the next step. Each iteration crosses the boundary between model inference and conventional software. The conventional software side runs on CPUs, and it now sits on the critical path of every request.

Researchers at Microsoft Azure and the University of Texas at Austin put numbers on this in an August 2026 paper drawn from Azure production telemetry. They described agentic execution as fragmented and heterogeneous, with each request expanding into a workflow of model inferences, tool invocations, and orchestration decisions that repeatedly crosses the CPU-GPU boundary. In one controlled workload using the CORAL framework, a single task expanded into 580 LLM calls interleaved with 552 tool invocations.

That ratio is the important number. Roughly one tool call per model call. If each tool call does real work, and in analytics it always does, the CPU side of the loop grows with the number of steps, and agents keep adding steps.

A second effect makes it worse. The same research found host CPU utilization stayed low for long stretches and then spiked during bursts of tool execution, while GPU utilization swung widely depending on the workflow. Average utilization looked fine. Peak demand on the CPU side set the latency users felt. Teams that sized hosts from average utilization dashboards were reading the wrong number.

## Where the Cycles Go in One Agent Task

To size anything, you need a model of the work. Here is the loop for a typical analytics agent answering "Which regions missed their Q3 revenue target, and why?"

The model plans. It reads the system prompt, the tool catalog, and the question, and it decides to discover what data exists. This step runs on the inference side, either a GPU you own or a hosted model API.

The runtime calls a discovery tool. The agent framework parses the model's tool-call output, which arrives as JSON. It validates the arguments against the tool's schema, opens a connection to a catalog or semantic layer, and sends a request. The catalog looks up namespaces and tables and returns a list. The runtime serializes the result back into text for the model. Every step here is CPU work: JSON parsing, schema validation, TLS, authentication, catalog lookups, and string building.

The model plans again, now with the table list in context, and asks for a schema. Another round trip through the same CPU path.

The model writes a SQL query. The runtime sends it to a query engine. This is the heaviest CPU step in the loop. The engine parses and plans the query, reads table metadata, prunes files, reads columnar data from object storage, decompresses and decodes it, filters, joins, aggregates, and serializes the result. In a lakehouse, all of that runs on CPU cores in nearly every production engine.

The model reads the result and decides it needs a breakdown by product line to explain the miss. Another query. Then a check on whether the target table itself changed during the quarter. Another query. Then a final answer.

A task like this often makes eight to fifteen tool calls, and several of them are queries. The model calls are individually fast on modern hardware. The query calls are individually variable, ranging from milliseconds for a metadata lookup to many seconds for an unoptimized scan.

The academic profiling backs this up. A study by Ritik Raj and colleagues, "A CPU-Centric Perspective on Agentic AI," profiled five representative agent workloads, including a Haystack RAG pipeline, Toolformer, ChemCrow, a LangChain agent, and SWE-Agent. They found tool processing on CPUs accounted for up to 90.6 percent of total latency. Their point was that tools such as code execution and web search cannot run on GPUs, so they depend on CPU processing, and that prior efficiency work had focused almost entirely on GPU kernels and KV-cache scheduling.

A separate 2026 study by Wonmi Choi and colleagues analyzed retrieval-augmented question answering, web search, and coding agents and found something more uncomfortable: faster LLM responses or more CPU cores do not always speed up agents. Bottlenecks shift between CPU, disk I/O, and memory depending on the task. Their fix was task-aware CPU allocation, which improved latency of CPU-sensitive agent tasks by about 5.4 times and cut average latency across tasks by about 32 percent. The lesson for sizing is that core count alone is not the answer. Matching cores to the kind of tool work is.

## The Analytics Agent Is the Extreme Case

Coding agents and web agents spend their CPU time running tests and fetching pages. Analytics agents spend theirs running queries, and queries are some of the most CPU-intensive work in a data center. That makes the analytics agent the extreme case of the CPU-bound agent.

A note on where I stand: I work at Dremio, which builds a lakehouse query engine that runs on CPUs and uses Apache Arrow as its in-memory format. The analysis below applies to every CPU-based engine, and I will keep it general.

Start with what a lakehouse query does before it reads any data. For an Apache Iceberg table, the engine loads the table's metadata file, reads the manifest list for the current snapshot, reads the manifests that list data files, and evaluates partition values and column statistics to decide which files to skip. Each of those files is JSON or Avro that must be fetched and parsed. On a large table with many manifests, planning alone takes noticeable CPU time, and it happens on every query, including the small exploratory ones agents love.

Then the engine reads data. Apache Parquet files are compressed and encoded column by column. Reading them means decompressing pages, decoding dictionary and run-length encodings, and materializing values into memory. Engines that use Arrow decode into columnar batches and run vectorized operators over them. Vectorized execution is fast, and it is CPU work. SIMD instructions make each core do more per cycle, but the cycles are still CPU cycles.

Then the engine processes. Filters, joins, aggregations, and sorts all run on CPU cores. Spilling to disk when memory runs out adds I/O on top.

GPU-accelerated SQL engines exist, and some workloads benefit from them. But the default execution path for Iceberg and Parquet in the major open engines and commercial platforms is CPU-based, and that is what an analytics agent fleet hits.

Agents also change the query mix in ways that raise CPU demand per answer. A human analyst writes one careful query, checks it, and runs it. An agent explores. It lists tables, samples rows, checks distinct values, runs a draft query, reads an error, and tries again. Each of those is a separate query with its own planning cost. A question a human answers with two queries takes an agent ten.

Many of those exploratory queries repeat. Agents ask for the same schema, the same distinct values, and the same aggregates across sessions and users. That repetition is the most useful fact in this whole article for cost control, and I come back to it in the operational section.

The last piece is the glue. MCP servers, tool runtimes, agent frameworks, and API gateways all parse JSON, validate schemas, and manage connections. Each piece is light alone. Across thousands of tool calls per minute, the glue becomes a fleet of its own.

## What AMD Helion Tells Us About the Market

Helion is worth reading closely, because it is a hardware vendor's answer to the same problem.

AMD announced it at the Open Compute Project Global Summit in San Jose on October 12, 2026. It is a rack-level reference design, not a chip. It follows an OCP specification, AMD plans to contribute the Helion spec to OCP, and AMD expects partner configurations in November 2026. Partners include Supermicro and Wiwynn.

The design comes in two example shapes.

The first is a CPU-only rack for hyperscalers, neoclouds, and sovereign AI operators. It uses 6th Gen EPYC "Venice" processors and supports up to 32,768 cores. At 256 cores per socket, that works out to 128 processors in one rack. AMD's diagrams pair this rack with a separate Helios GPU rack for inference. The CPU rack runs the agents. The GPU rack runs the models. The two scale independently. Reporting on the launch also describes three CPU node types matched to different classes of agents, which lines up with the research finding that tool work varies by task.

The second is an all-in-one rack for enterprises. It combines EPYC CPU nodes, general-purpose compute, and Instinct MI350P GPU nodes, with up to 16 GPUs in two eight-GPU servers. It includes a token router that sends agents' model calls either to frontier models in the cloud or to open models running in the rack.

Dan McNamara, who runs AMD's compute and enterprise AI business, framed the launch around one line: agentic AI is not a single workload. That sentence is the whole sizing argument in five words.

Three things in this design matter for data teams, whatever hardware you buy.

The disaggregation is the point. Separating the agent execution tier from the inference tier means you size each for its own bottleneck. You stop buying GPU servers with whatever host CPU happens to come with them and hoping it is enough.

The ratio is configurable. Partners tailor the CPU and GPU mix to each deployment's performance, power, and cost requirements. AMD is not claiming a correct ratio. It is claiming the ratio is workload-specific, which means you have to measure yours.

The token router puts model choice inside the infrastructure. Routing simple calls to a smaller local model and hard calls to a frontier model is a cost and latency lever. It also shifts more inference toward hardware you own, which changes your GPU math and leaves the CPU math where it was.

Helion is a hyperscale and enterprise design, and most data teams will never buy a rack of 32,768 cores. That is fine. The design is a public statement of the architecture every agent deployment ends up with at any scale: an inference plane, an execution plane, and the data plane the agents query.

## Three Planes, Sized Separately

The most useful mental model I have for agent infrastructure splits the work into three planes. Each has its own bottleneck, its own scaling unit, and its own failure modes.

| Plane | What runs there | Main bottleneck | Scales with |
|---|---|---|---|
| Inference plane | Model calls, either self-hosted on GPUs or via a hosted API | GPU memory and throughput, or API rate limits and spend | Model calls per second and tokens per call |
| Agent execution plane | Agent runtime, orchestration, MCP servers, tool code, JSON parsing, auth | CPU cores and memory per concurrent agent | Concurrent agent sessions and tool calls per second |
| Data plane | Query engines, catalogs, semantic layer, object storage reads | CPU cores, memory bandwidth, and storage I/O | Queries per second and bytes scanned per query |

The inference plane is the one most teams already size, because it has the most visible bill. If you use a hosted model, this plane is someone else's hardware and your constraint is rate limits and cost. If you self-host, it is GPUs.

The agent execution plane is the one most teams forget. It is often a handful of containers running an agent framework and a few MCP servers, deployed with default resource requests. Under load, each concurrent session holds memory for its context and state, and each tool call burns CPU on parsing, validation, and connection handling. This plane is where Helion's CPU-only rack lives.

The data plane is where an analytics agent's heaviest work lands. In a lakehouse it is the query engine cluster, the catalog, and the semantic layer. It is also usually shared with human users, dashboards, and scheduled jobs. That sharing is what makes agent rollouts dangerous. An agent fleet that issues ten queries per question lands on the same engine your executive dashboard depends on.

The planes interact through latency. A slow data plane holds agent sessions open longer, which raises concurrency on the execution plane, which raises memory pressure there. A slow execution plane leaves inference capacity idle while the model waits on tools. The Azure and UT Austin paper described exactly this: either processor becomes a transient bottleneck on the workflow's critical path, which makes static provisioning inefficient.

The practical consequence is that you size the data plane and execution plane from agent behavior, not from model throughput. Model throughput tells you how fast the agent thinks. Tool behavior tells you how much work each thought creates.

### Hosted models do not move the CPU work

A common objection is that the team uses a hosted model API, so infrastructure sizing is someone else's problem. That is true for the inference plane only. The model provider runs the GPUs. Your organization still runs the agent runtime, the MCP servers, the catalog, the semantic layer, and the query engines. Every tool call the hosted model requests lands on your hardware.

Hosted inference makes the imbalance sharper. Your GPU bill becomes an API bill that scales with tokens, and your CPU bill scales with tool calls. Because the two grow at different rates, a deployment that looks cheap at pilot scale shifts toward the data plane as usage grows. A model that writes better SQL on the first try lowers both bills. A model that explores more thoroughly raises the CPU bill even as answer quality improves.

The network adds its own CPU cost. Every tool result that goes back to a hosted model is serialized, compressed, encrypted, and sent over TLS, and every model response is received, decrypted, and parsed. Large tool results, such as a query that returns thousands of rows, make this visible. Capping result sizes in your tools protects both the token bill and the execution plane.

## Measuring Your Own Ratio and Sizing From It

No published number tells you your CPU-to-GPU ratio. The research gives ranges, and Helion gives a configurable blueprint, but the only reliable input is your own traces. Here is a two-part method: measure where the time goes, then turn the measurements into core counts.

### Part one: find where the time goes

Most agent frameworks now emit OpenTelemetry spans, and the OpenTelemetry generative AI semantic conventions tag each span with an operation name, such as `chat` for a model call or `execute_tool` for a tool call, plus the tool's name. Land those spans in an Iceberg table like any other telemetry, and you can ask the lakehouse how your agents spend their time. This Spark SQL query summarizes a week of spans.

```sql
WITH spans AS (
  SELECT
    trace_id,
    attributes['gen_ai.operation.name']                AS operation,
    coalesce(attributes['gen_ai.tool.name'], 'model')  AS tool_name,
    unix_millis(end_time) - unix_millis(start_time)    AS duration_ms
  FROM observability.agent_spans
  WHERE start_time >= current_timestamp() - INTERVAL 7 DAYS
    AND attributes['gen_ai.operation.name'] IN ('chat', 'execute_tool')
),
tasks AS (
  SELECT count(DISTINCT trace_id) AS task_count FROM spans
)
SELECT
  s.operation,
  s.tool_name,
  count(*)                                    AS calls,
  round(count(*) / max(t.task_count), 2)      AS calls_per_task,
  percentile_approx(s.duration_ms, 0.5)       AS p50_ms,
  percentile_approx(s.duration_ms, 0.95)      AS p95_ms,
  round(sum(s.duration_ms) * 100.0
        / sum(sum(s.duration_ms)) OVER (), 1) AS pct_of_wall_time
FROM spans s
CROSS JOIN tasks t
GROUP BY s.operation, s.tool_name
ORDER BY pct_of_wall_time DESC
```

The `spans` common table expression pulls the two operation types that matter, model calls and tool calls, from a week of data. Model calls have no tool name, so `coalesce` labels them `model`. Duration comes from the span timestamps in milliseconds.

The `tasks` expression counts distinct traces, where one trace is one agent task from question to answer. Dividing call counts by that total gives `calls_per_task` for each tool, which is the first input to the sizing model below.

The percentiles show typical and tail latency per tool. Tail latency is what users feel, because one slow query holds the whole task open.

The last column uses a window over the aggregate, `sum(sum(...)) OVER ()`, to show each operation's share of total wall time across all tasks. If `execute_tool` rows for your SQL tool hold most of that share, your agents are bound by the data plane, not the model.

Two cautions. Span duration is wall time, not CPU time. A query that waits on object storage shows long wall time with modest CPU. And nested spans overlap, so restrict the query to the leaf operations you care about, as the filter does. For CPU time, use the query engine's own job profiles. Most engines record CPU time per query, and joining those records to spans by query ID gives you the true CPU cost per tool call.

### Part two: turn measurements into cores

With calls per task and CPU seconds per call in hand, the arithmetic is short. CPU-seconds of demand per second of wall time equals the number of cores kept busy. Divide by a target utilization to leave headroom for bursts. For memory on the execution plane, Little's Law gives concurrent sessions: arrival rate times mean task duration.

```python
from dataclasses import dataclass, field


@dataclass
class ToolProfile:
    name: str
    plane: str                  # "execution" or "data"
    calls_per_task: float       # from your traces
    cpu_seconds_per_call: float  # CPU time, not wall time


@dataclass
class Workload:
    peak_tasks_per_minute: float
    mean_task_seconds: float     # wall time from first model call to answer
    memory_gb_per_session: float  # agent context, tool buffers, runtime state
    target_utilization: float = 0.6  # leave headroom for tool bursts
    tools: list[ToolProfile] = field(default_factory=list)


def size(w: Workload) -> dict:
    tasks_per_second = w.peak_tasks_per_minute / 60
    busy_cores = {}
    for t in w.tools:
        load = tasks_per_second * t.calls_per_task * t.cpu_seconds_per_call
        busy_cores[t.plane] = busy_cores.get(t.plane, 0.0) + load
    cores = {plane: round(c / w.target_utilization, 1) for plane, c in busy_cores.items()}
    concurrent_sessions = tasks_per_second * w.mean_task_seconds  # Little's Law
    return {
        "cores_by_plane": cores,
        "concurrent_sessions": round(concurrent_sessions, 1),
        "execution_plane_memory_gb": round(concurrent_sessions * w.memory_gb_per_session, 1),
    }


# Illustrative placeholder inputs. Replace every number with your own measurements.
pilot = Workload(
    peak_tasks_per_minute=120,
    mean_task_seconds=35,
    memory_gb_per_session=0.5,
    tools=[
        ToolProfile("tool_call_overhead", "execution", calls_per_task=10, cpu_seconds_per_call=0.02),
        ToolProfile("catalog_and_schema", "data", calls_per_task=4, cpu_seconds_per_call=0.05),
        ToolProfile("sql_query", "data", calls_per_task=5, cpu_seconds_per_call=2.5),
    ],
)

print(size(pilot))
```

Running this prints:

```text
{'cores_by_plane': {'execution': 0.7, 'data': 42.3}, 'concurrent_sessions': 70.0, 'execution_plane_memory_gb': 35.0}
```

The numbers in `pilot` are illustrative placeholders, not measurements. They exist to show the shape of the result, and you replace every one with values from your own traces and query profiles.

`ToolProfile` describes one kind of tool call: which plane it runs on, how many times an average task calls it, and how much CPU time each call costs. The split between planes matters because they are separate clusters with separate budgets.

`Workload` holds the arrival rate at peak, the mean task duration, the memory each live session holds, and the target utilization. A target of 0.6 means you plan to run cores at 60 percent busy at peak, which leaves room for the bursty tool spikes the Azure research described.

`size` multiplies tasks per second by calls per task by CPU seconds per call to get busy cores per plane, then divides by the utilization target. It applies Little's Law for concurrent sessions and multiplies by per-session memory to size the execution plane's RAM.

Look at what the placeholder output says, because the shape generalizes. The data plane needs about 42 cores. The execution plane needs less than one core of CPU but 35 GB of memory for 70 concurrent sessions. For analytics agents, the CPU problem lives mostly in the query engines, and the execution plane is a memory and concurrency problem more than a compute problem.

That has a direct consequence. The cheapest CPU you will ever buy for an agent fleet is the CPU you do not spend on repeated queries. In the same placeholder model, serving 40 percent of SQL calls from cached results at 0.1 CPU seconds each drops the effective cost per SQL call from 2.5 to about 1.54 CPU seconds. Data plane demand falls from about 42 cores to about 26. No hardware change produces a 38 percent reduction that cheaply.

Scale is linear in this model, which makes growth planning simple. Ten times the users at the same behavior means ten times the cores. The model also makes the levers visible: fewer calls per task, cheaper calls, or fewer repeated calls.

## Failure Modes When the CPU Side Is Undersized

When the CPU planes run short, agent deployments fail in recognizable ways. Each has a warning sign you can watch for before users complain.

Tool latency rises while model latency stays flat. This is the signature of a CPU-bound fleet. Your model dashboards look healthy, your tokens per second are fine, and task completion time keeps climbing. Check the `pct_of_wall_time` breakdown. If tool calls are growing as a share of wall time, the bottleneck has moved off the model.

Agents starve human users on a shared engine. An agent fleet issues many small queries, and it does so at machine speed. On an engine shared with dashboards and analysts, those queries fill the queue. The warning sign is a rise in queued time for dashboard queries that coincides with agent traffic. The fix is workload isolation: a separate engine or a separate queue with its own resource limits for agent traffic.

Retry storms amplify load. When a query times out, many agent frameworks retry it, and the model often rewrites the query slightly and runs it again. Each retry is full price. Under load, a slow engine produces timeouts, timeouts produce retries, and retries make the engine slower. Watch the ratio of failed to successful tool calls per task. A rising ratio during peak hours is the early warning.

Metadata planning becomes the hidden cost. Agents favor small exploratory queries, and on large Iceberg tables with many manifests, planning time can dominate execution time for those queries. The warning sign is query profiles where planning takes longer than execution. The fixes are table maintenance (compacting manifests and expiring old snapshots) and caching of table metadata in the engine.

Execution plane memory runs out before CPU does. As the sizing model shows, the execution plane is usually memory-bound. Long tasks hold large contexts and tool results in memory. When concurrency spikes, containers hit memory limits and get killed, which kills in-flight tasks. The warning sign is out-of-memory restarts on agent runtime pods, often with low CPU utilization at the same moment.

Average utilization hides peak saturation. The research is explicit that average utilization misleads for agent workloads. CPU sits idle, then spikes during tool bursts. A capacity plan built on average utilization undersizes for the peaks that set latency. Use p95 and p99 utilization over short windows, one minute or less, when you plan.

The wrong cores get added. The Choi study's finding that more cores do not always help is a warning against reflexive scaling. If the bottleneck is disk I/O on a tool container or memory bandwidth on a query node, adding cores to the agent runtime changes nothing. Profile before you scale, and scale the plane that is actually saturated.

Cost attribution blurs. When agents and humans share one engine, nobody knows what the agent fleet costs. Finance sees the model API bill and treats it as the cost of AI. The query engine bill grows quietly under a different budget line, and the agent program looks cheaper than it is. The warning sign is an engine bill that rises month over month with no new dashboards or pipelines to explain it. Tag every agent query with a workload label or a dedicated service identity, so engine profiles split agent CPU from human CPU. That split is also the number you need to judge whether a caching or semantic layer investment paid off, because the savings show up on the data plane, not the model bill.

## Operational Guidance: Cutting CPU Demand Before Buying It

The sizing model has three levers: calls per task, CPU per call, and how many calls repeat. Hardware is the last lever, not the first. Work through them in this order.

### Instrument first

Turn on OpenTelemetry tracing in the agent framework and the MCP servers before the pilot starts, not after the first slowdown. Land spans in the lakehouse. Make sure every tool call that hits a query engine carries the engine's query ID as a span attribute, so you can join wall time from the trace to CPU time from the engine's profile. Without that join, you are sizing from guesses.

### Cut calls per task

Most of the extra calls an agent makes are discovery. It lists tables, reads schemas, and samples values because it does not know the data. Give it that knowledge up front. A governed semantic layer that exposes business metrics, dimensions, and definitions as tools replaces several discovery calls with one. A well-written tool description that names the right tables replaces another few. Fewer, better tools beat a long tool catalog, because each extra tool adds tokens to every model call and increases the odds of a wasted exploratory call.

Watch the `calls_per_task` column over time. When it drops after a semantic layer change, the CPU savings show up directly in the sizing model.

### Cut CPU per call

Make each query cheaper. On Iceberg tables, that means the usual maintenance: compact small files, rewrite manifests, expire snapshots, and sort or cluster data on the columns agents filter by. Agents filter on dates, regions, and product lines the same way humans do, so the layout that helps dashboards helps agents.

Put row limits and timeouts on every query tool. An agent that runs `SELECT *` against a billion-row table to "look at the data" burns real CPU for no benefit. A tool that caps results at a few hundred rows and enforces a scan limit protects the data plane from the agent's worst instincts.

Prefer pre-aggregated data for common questions. Aggregation tables and materialized views answer metric questions with a fraction of the CPU of a raw scan.

### Cut repeated calls

This is the largest lever for analytics agents. Agent query streams repeat far more than human query streams, because every session rediscovers the same schemas and asks for the same core metrics. Three caching layers apply.

Metadata caching in the engine and catalog cuts repeated planning cost on Iceberg tables. Result caching for identical queries cuts exact repeats. Query acceleration, through materializations that the engine substitutes automatically when a query matches, cuts the near-repeats that differ only in a filter or a grouping. In Dremio, that last layer is Autonomous Reflections, which builds and maintains materializations from observed query patterns. Other engines offer materialized views with automatic rewrite. The mechanism matters less than measuring the hit rate and feeding it back into the sizing model.

Cache correctness matters more for agents than for dashboards, because an agent presents a stale number as a confident answer. Tie cache invalidation to table snapshots, so a new Iceberg commit invalidates results built on the old one.

### Isolate the data plane

Give agent traffic its own engine cluster or its own workload queue, with resource limits. This protects human users from agent bursts and makes agent CPU cost visible as its own line item. Isolation also lets you tune the agent cluster for many short queries rather than a few long ones.

### Size the execution plane for memory and concurrency

Use Little's Law from the sizing model to set memory requests on agent runtime pods. Set concurrency limits per pod so a burst queues rather than crashes. Autoscale on session count or memory, not CPU utilization, since CPU is rarely what runs out first on this plane.

### Plan capacity on peaks, then review monthly

Use p95 tasks per minute in your sizing inputs, not averages. Re-run the trace query and the sizing model monthly. Agent behavior drifts as prompts, tools, and models change, and a model upgrade that makes the agent more thorough also makes it issue more queries.

## A Pre-Production Checklist

Before an analytics agent fleet goes from pilot to production, run through this list. Each item maps to a failure mode above or a lever in the sizing model.

Traces flow end to end. Every agent task produces a trace with model spans and tool spans, and every query tool span carries the engine's query ID. You have run the trace summary query at least once against real pilot traffic.

You know your ratio. You have a measured `calls_per_task` for each tool and a measured CPU cost per query from engine profiles, at p50 and p95. Your sizing model uses those numbers, not placeholders.

Agent traffic is isolated. Agents query a dedicated engine cluster or a dedicated workload queue with its own limits. Dashboard queue time does not move when agent traffic spikes.

Every query tool has guardrails. Result row caps, scan limits, and timeouts are set and tested. A runaway query fails fast with a clear error the model reads, rather than holding a session open.

Retries are bounded. The agent framework caps retries per tool call and per task. A failing query does not turn into ten failing queries.

Caching is measured and safe. You track cache hit rates for metadata, results, and materializations, and invalidation is tied to table snapshots so agents never read a result built on data that has since changed.

Tables are maintained. The Iceberg tables agents query most have scheduled compaction, manifest rewrites, and snapshot expiration, and their layout matches the filters agents use.

The execution plane has memory headroom. Agent runtime pods have memory requests sized from Little's Law at p95 arrival rate, concurrency limits per pod, and autoscaling on sessions or memory.

Peak, not average, drives capacity. Utilization alerts use short windows and high percentiles, so tool bursts show up before users feel them.

There is a monthly review. Someone owns re-running the trace query and the sizing model each month, and model or prompt changes trigger an extra run.

## Where This Is Heading

The hardware market is reorganizing around the agent loop. Helion is the clearest example so far, and it will not be the last. The Azure and UT Austin researchers proposed a server design they call Agora that pools host cores by role, harvests idle CPU for other work, and protects agent tail latency against tool spikes. In their evaluation it raised host CPU utilization by about 30 percent, freed roughly a third of GPUs through consolidation, raised generation throughput by 82 percent, and cut tail latency by 2.5 times. Expect cloud providers to offer instance shapes and schedulers built on the same ideas.

Three shifts matter most for data teams.

Agent execution becomes its own tier. The disaggregated pattern in Helion, a CPU tier for agents next to a GPU tier for models, maps cleanly onto cloud deployments. Teams that already separate their agent runtime from their inference endpoint are ahead. Teams that run everything on GPU nodes with leftover host CPU will feel the squeeze first.

The data plane becomes the agent's real cost center. As models get cheaper per token, the share of agent cost that comes from query execution grows. That pushes investment toward the things that make queries cheap for machines: semantic layers that reduce exploration, open table formats with good metadata for fast planning, columnar execution on Arrow, and caching that recognizes repeated agent patterns. The open lakehouse stack, Iceberg for tables, Parquet for files, Arrow for in-memory execution, and Polaris for the catalog, is where most of that efficiency work happens, and its gains apply to every engine that reads the same tables.

Routing becomes part of infrastructure. The token router in Helion's enterprise rack is a hardware vendor building model routing into the rack. Routing simple calls to small local models cuts inference cost, and it also shortens each model step, which makes tool latency an even larger share of each task. Faster models make the CPU side matter more, not less.

## Conclusion

Agentic analytics changed the shape of AI workloads. A chatbot makes one model call. An analytics agent makes a loop of model calls and tool calls, roughly one for one, and in a lakehouse the tool calls are queries that run on CPU cores. Research from production telemetry and controlled studies shows tool work taking the majority of end-to-end latency in many agent workloads, and AMD's Helion design, with a CPU-only rack as its flagship, shows hardware vendors reorganizing around that fact.

Keep buying the GPUs you need, and size three planes separately. The inference plane for model calls. The execution plane for agent runtimes, which is mostly a memory and concurrency problem. And the data plane for queries, which is where an analytics agent's CPU demand concentrates. Measure your own ratio from traces, turn it into core counts with simple arithmetic, and pull the cheap levers before the expensive one: fewer calls per task through a semantic layer, cheaper calls through table maintenance and query limits, and fewer repeated calls through caching tied to table snapshots.

Teams that do this ship agents that stay fast under load and keep their dashboards fast too. Teams that size only the model find the bottleneck in production.

## Keep Going

If this piece was useful, I have written a lot more on lakehouse architecture and the data plane that agents depend on. *Architecting an Apache Iceberg Lakehouse* (Manning) covers how to design the table, catalog, and query layers that make analytical queries cheap and fast. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
