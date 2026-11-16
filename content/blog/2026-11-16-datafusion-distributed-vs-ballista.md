---
title: "datafusion-distributed vs Ballista: Embeddable vs Standalone Distributed Query Execution"
description: "Ballista is a standalone distributed engine. datafusion-distributed is a library for apps that embed DataFusion. Choose by who should own operations."
date: 2026-11-16T09:00:00Z
tags: ["Apache DataFusion", "Apache Iceberg", "Query Engines", "Distributed Systems", "Architecture"]
canonical: https://iceberglakehouse.com/posts/datafusion-distributed-vs-ballista/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/datafusion-distributed-vs-ballista/).

Apache DataFusion is voting to accept datafusion-distributed as a subproject alongside Ballista. Ballista is a standalone distributed engine with its own scheduler and executors. datafusion-distributed is a library that adds distributed execution to an existing DataFusion application, leaving workers, networking and deployment to you. Choose by who should own operations.

On November 12, 2026, Gabriel Musat opened a vote for the DataFusion Project Management Committee (PMC) to accept the datafusion-distributed codebase as a subproject in a new `apache/datafusion-distributed` repository ([vote thread](https://lists.apache.org/thread/ds3c6fgt5tb7lhprws8gs2ktonc0xmsb)). The vote drew several +1 votes on its first day, including one from Andrew Lamb, and stays open for at least seven days. Acceptance also depends on Apache Software Foundation intellectual property clearance, which the maintainers are preparing in parallel.

If the vote passes, DataFusion will host two distributed execution projects. That raises the question this article answers: which one fits your situation? This is a decision piece. For how DataFusion itself works and how it reads Apache Iceberg tables, see the [Apache DataFusion](https://iceberglakehouse.com/iceberg/apache-datafusion/) entry on IcebergLakehouse.com.

## Why DataFusion has two distributed stories

Apache DataFusion is an extensible query engine written in Rust that uses Apache Arrow as its in-memory format. It runs on one machine. It parses SQL or DataFrame operations, plans them, optimizes the plan, and executes it across all the cores on the host. A growing list of products embed it as their query core, because it is fast, modular, and easy to extend with custom functions, data sources, and optimizer rules.

One machine has limits. When data or compute needs outgrow a single host, a query has to run across several. That means splitting the plan into pieces, sending pieces to other machines, moving intermediate data between them, and assembling the result.

There are two broad ways to provide that.

**Build an engine.** Provide a scheduler that accepts queries, a fleet of executors that run work, and the operational tools to deploy and monitor them. Users submit queries to the engine. This is the Spark and Trino model, and it is Ballista's model.

**Build a library.** Provide the planning and data-exchange pieces as code that an application includes. The application decides how many workers exist, where they run, how they find each other, and how they are deployed. Users never see a separate engine. This is datafusion-distributed's model.

Neither is better in general. They serve different owners. The vote email states the split plainly: Ballista is "a customizable distributed engine with its own scheduler, executors, and operational tooling," while datafusion-distributed is "an embeddable distribution library for applications that manage their own workers, networking, and deployment."

## What distributed execution actually requires

Before comparing the two projects, it helps to list what any distributed query system has to do. Each item is a place where the two projects make different choices, and each is a place where problems show up in production.

**Split the plan.** A single-node plan is a tree of operators. A distributed plan cuts that tree at exchange points, the places where rows have to move between machines because the next operator needs them grouped differently. A hash join, for example, needs matching keys from both sides on the same machine. So the plan cuts before the join, and each side is repartitioned by the join key.

**Place the work.** Something decides which machine runs which piece. That decision weighs data locality, current load, and how many partitions each piece has. A central scheduler makes this decision for the whole cluster. A coordinator node makes it for one query.

**Move the data.** Repartitioned rows have to travel from producers to consumers. There are two broad styles. Materialized shuffle writes intermediate output to disk, and consumers fetch it when they are ready. Streaming exchange sends rows directly from producer to consumer while both run. Materialized shuffle survives the loss of a consumer and makes retries simple. Streaming exchange avoids disk writes and lets stages overlap, at the cost of more complex failure handling.

**Handle failures.** A worker dies halfway through a query. The system either retries the lost tasks, which requires that their inputs still exist somewhere, or fails the query and lets the client retry. Materialized shuffle makes task-level retries easier, since inputs sit on disk.

**Find the machines.** The system needs a current list of workers. Registration with a central service is one way. Reading from the application's own service discovery is another.

**Secure the channels.** Plan fragments and data move over the network. Something has to authenticate workers to each other and encrypt the traffic.

Ballista answers most of these with its own components: the scheduler places work, executors register themselves, and shuffle files materialize between stages. datafusion-distributed answers the planning and data movement questions and hands the rest to your application. That one difference drives every row of the decision matrix below.

## Ballista: the standalone engine

Ballista is the older of the two and already lives under the DataFusion project at Apache. Its [documentation](https://datafusion.apache.org/ballista/) covers architecture, deployment, and clients.

### How it works

Ballista has two kinds of processes.

**The scheduler** accepts jobs through a gRPC service and exposes a REST API for monitoring. Clients send it a logical plan, a Substrait plan, or a physical plan. The scheduler builds an execution graph that splits the plan into stages that can be scheduled independently.

**Executors** register with the scheduler and run tasks. A task is a physical plan fragment in protocol buffer format. By default the scheduler pushes tasks to executors, and executors can also poll for them. Executors run several partitions of the same stage in parallel and report progress back.

The scheduler cuts a query into stages wherever partitioning has to change, such as repartitioning data by key before a join or an aggregation. Each stage runs in parallel across executors. Dependent stages start when their inputs finish.

Between stages, data has to move. Ballista uses `ShuffleWriterExec` and `ShuffleReaderExec` operators for this. Each executor repartitions its stage output and materializes it to local storage. Executors in the next stage fetch that data from each other over Arrow Flight, Arrow's protocol for moving record batches over the network. According to the architecture docs, a downstream stage currently waits for its whole upstream stage to finish. The docs list pipelined execution as experimental.

### How you use it

Ballista ships deployment guides for Cargo installs, Docker, Docker Compose, and Kubernetes, plus pages for the scheduler and a history server. Clients include a SQL command-line tool, Python bindings, the Rust `ballista` crate, and Arrow Flight SQL.

From Rust, a client connects to a running scheduler and gets a session that looks like a normal DataFusion session:

```rust
use ballista::prelude::*;
use datafusion::prelude::*;

#[tokio::main]
async fn main() -> datafusion::error::Result<()> {
    // Connect to a Ballista scheduler instead of running locally.
    let ctx = SessionContext::remote("df://scheduler.internal:50050").await?;

    // Register data and query it exactly as you would with DataFusion.
    ctx.register_parquet("orders", "s3://lake/orders/", ParquetReadOptions::default())
        .await?;
    let df = ctx
        .sql("SELECT region, sum(amount) FROM orders GROUP BY region")
        .await?;
    df.show().await?;
    Ok(())
}
```

`SessionContext::remote` comes from the Ballista prelude and returns a session whose queries run on the cluster behind the scheduler address. Registration and SQL use the standard DataFusion API, so code written for local DataFusion moves to the cluster with a one-line change. The Parquet path is a placeholder for your storage location, and the object store has to be configured on the executors as well as the client.

The important point is the shape. The application is a client. Ballista is a service someone deploys and operates, with its own processes, ports, and lifecycle.

## datafusion-distributed: the embeddable library

datafusion-distributed lives today in the `datafusion-contrib` GitHub organization under the Apache 2.0 license. Its [README](https://github.com/datafusion-contrib/datafusion-distributed) describes it as "a toolkit that extends Apache DataFusion with distributed query execution" and says directly: a library, not an engine.

### How it works

A distributed plan in datafusion-distributed is a normal DataFusion physical plan with extra nodes that stream Arrow data between machines. The project stays close to native DataFusion on purpose. Planning, optimization, and execution operators are DataFusion's own. The library adds the pieces that cut a plan across machines and move data between them.

There is no coordinator and worker split. Any node can act as a coordinator for a query or as a worker for another node's query. Workers run gRPC servers to receive work and exchange data.

Going distributed takes three steps, per the README: enable the distributed planner on the session, tell it where the workers are, and run the worker gRPC servers. Everything around those steps belongs to the application. The project calls itself unopinionated about networking. The application decides how workers are discovered, how they authenticate, how they scale, and how they are deployed. The README notes sane defaults for the common case of file-based data sources, and the full documentation covers dynamic worker resolution.

### How you use it

You do not deploy datafusion-distributed. You build it into a program that already embeds DataFusion. If your product is a Rust service that runs DataFusion queries, you add the library, start a worker server inside each instance of your service, and give the planner a way to find the other instances. Your existing deployment system, whether Kubernetes, a service mesh, or something custom, decides how many instances run.

From the outside, nothing new appears. There is no scheduler to monitor and no executor fleet to size separately. Your service gets the ability to spread a query across its own replicas.

The maintainers, Gabriel Musat and Jayant Shrivastava, said in the vote email that they plan to keep contributing to and maintaining it within the DataFusion community.

## The decision matrix

The core question is who owns operations. The table below breaks that into the parts that matter in practice.

| Question | Ballista | datafusion-distributed |
| --- | --- | --- |
| What you run | A scheduler and an executor fleet | Nothing new. Your own application instances act as workers |
| Who schedules work | Ballista's scheduler | The node that receives the query acts as coordinator |
| Who discovers workers | Executors register with the scheduler | Your application tells the planner where workers are |
| Who owns networking and auth | Ballista's services, configured by you | Your application, entirely |
| How users submit queries | Client connects to the scheduler (Rust, Python, CLI, Flight SQL) | Through your application's own API |
| Operational tooling | Scheduler REST API, history server, deployment guides | Whatever your application already has |
| Shuffle model | Materialized to executor local storage, fetched over Arrow Flight | Plan nodes stream Arrow data between machines |
| Best fit | Teams that want a distributed SQL service to run | Products that already embed DataFusion and want to scale out |
| Project home today | Apache DataFusion subproject | datafusion-contrib, proposed as a subproject |

Read the table by row, not by column. If your answer to "who should own networking and auth" is "a separate service we operate," that points to Ballista. If it is "our product, the way it already does," that points to datafusion-distributed.

## Do you need distributed execution at all

The most useful question comes before choosing between these two projects. Many workloads that seem to need a cluster run fine on one large machine.

DataFusion is a vectorized engine that uses every core on its host. Cloud instances now offer well over a hundred cores and hundreds of gigabytes of memory. A query that scans a few hundred gigabytes of Parquet with good partition pruning often finishes on one such node in reasonable time. Add a cluster and you add network transfers, serialization, coordination, and failure modes that a single node never has.

Ask these questions first.

- **How much data does a typical query read after pruning?** Table size matters less than bytes scanned. Iceberg partition pruning and file-level statistics often cut a large table down to a small read.
- **Do your largest queries spill?** If aggregations and joins fit in memory on a large node, distribution buys little.
- **Is concurrency the real problem?** Many small queries from many users are often better served by several independent single-node instances behind a load balancer than by one distributed cluster.
- **Does latency matter more than throughput?** A distributed query pays startup and coordination costs. Short interactive queries feel those costs most.

If the answers point to a single node, run single-node DataFusion first and keep both distributed options in reserve. If your largest queries regularly exceed one machine's memory, or your scans run to terabytes after pruning, read on.

## Project health signals to check

Adopting either project means depending on its community. A few signals help you judge that dependency.

**Release cadence.** Look at how often each project ships and whether releases track DataFusion's major versions promptly. A distributed layer that lags the core by several versions blocks you from core improvements.

**Maintainer spread.** Count the active maintainers and the organizations they work for. A project maintained by one company carries the risk that its priorities change. Apache governance helps here, which is part of why the subproject vote matters for datafusion-distributed.

**Issue response.** Open a few issues and pull requests in each repository and read how quickly and how substantively maintainers respond. That predicts what happens when you hit a bug.

**Documentation of failure behavior.** Check whether each project documents what happens when a worker dies, a network partition occurs, or a shuffle file disappears. Projects that document failure behavior have usually tested it.

## When Ballista fits

Ballista fits when the distributed query engine is the product you want, not a feature of another product.

**You want a shared SQL service.** A platform team runs a cluster, and many users and tools send queries to it. The scheduler gives one place to submit, monitor, and manage jobs.

**You want clients in several languages.** Python bindings, a CLI, and Flight SQL let analysts and tools connect without writing Rust.

**You want standard deployment.** Docker and Kubernetes guides mean an operations team can stand it up the way it stands up other services.

**Your team does not build Rust services.** Ballista asks you to operate software. datafusion-distributed asks you to write it.

The trade-off is that Ballista is another system with its own failure modes. Schedulers fail. Executors run out of disk for shuffle files. Clusters need sizing. If your organization already runs Spark or Trino for this role, adding Ballista means a second engine to staff.

## When datafusion-distributed fits

datafusion-distributed fits when distributed execution is a capability your existing application needs, not a separate service.

**You already embed DataFusion.** Many products use DataFusion as their query core. When a customer's data outgrows one node, the product needs to scale a query across its own replicas, inside its own security model, without asking customers to deploy a second system.

**You already own the infrastructure.** If your service runs on Kubernetes with its own discovery, mTLS, and autoscaling, a library that uses those pieces is simpler than a separate engine with its own versions of them.

**You want to stay close to DataFusion.** Because distributed plans are DataFusion plans with extra nodes, custom functions, data sources, and optimizer rules you wrote for DataFusion keep working. A separate engine adds its own serialization boundary for plans and extensions.

The trade-off is that everything operational is yours. Worker discovery, failure handling, autoscaling, monitoring, and access control are application code. The library gives you distributed execution. It does not give you a cluster manager.

## Three organization shapes

Abstract criteria help less than concrete cases. Here are three common shapes and where each lands.

**A platform team serving analysts.** The team runs shared infrastructure for many internal users who write SQL in notebooks and BI tools. They want one endpoint, job monitoring, and standard deployment. The users never write Rust. This team wants an engine. Ballista is the DataFusion-native option, and it competes on their shortlist with whatever engine they already run.

**A software company with a DataFusion-based product.** The company sells an analytics or observability product with DataFusion inside. Customers deploy it in their own clusters. Some customers now have data volumes that one node cannot handle. Asking those customers to deploy a separate Ballista cluster beside the product adds a second system to every installation. Embedding datafusion-distributed lets the product's own replicas share query work, inside the security and deployment model the product already has. This company wants a library.

**A data team building an AI data service.** The team runs a Rust service that answers agent queries over Iceberg tables. Most queries are small and interactive. A few are large. The team owns its Kubernetes deployment and already has service discovery and mutual TLS. For the small queries, single-node DataFusion per replica is enough. For the large ones, a library that lets one replica pull in others fits the existing service better than routing those queries to a separate cluster. This team also wants a library, with the single-node path as the default.

## Where each fits next to Spark and Trino on Iceberg

Most teams reading this already run a distributed engine. Apache Spark handles large batch transformations and table maintenance on Iceberg. Trino handles interactive SQL across many sources. The DataFusion options fit beside them, not in place of them, for most organizations.

Ballista competes most directly with those engines for the "shared SQL cluster" role. Its appeal is a smaller, Rust-based, Arrow-native stack. Before adopting it for Iceberg workloads, check how it reads Iceberg tables. DataFusion's Iceberg support comes through the iceberg-rust project's DataFusion integration, which is moving into Apache DataFusion itself. Iceberg features such as deletion vectors and other v3 capabilities depend on that integration's progress, so confirm support for the table features you use.

datafusion-distributed does not compete for that role. It targets products built on DataFusion: query services, embedded analytics, observability backends, and AI data tools. For those products, the alternative is not "use Spark instead." It is "build our own distribution layer," which is much more work. Context on where engines sit in the broader ecosystem is in [The 2025 State of the Apache Iceberg Ecosystem Results](https://datalakehousehub.com/blog/2026-02-state-of-the-apache-iceberg-ecosystem/).

## Benchmarks and how to read them

The datafusion-distributed README publishes TPC-H and TPC-DS runs on a cluster of AWS instances reading Parquet from S3, compared against Ballista, Spark, and Trino. The benchmark code lives in a separate repository, `datafusion-distributed-dev-tools`.

Project-published benchmarks are a reasonable starting point and a poor final answer. Three reasons apply here.

**Configuration matters more than engines.** Shuffle settings, partition counts, memory limits, and file layouts change results across every engine. A benchmark tuned by one project's maintainers reflects that project's defaults and expertise.

**Standard benchmarks miss your workload.** TPC-H and TPC-DS measure joins and aggregations on synthetic schemas. Your queries hit your file sizes, your partitioning, and your concurrency. The DataFusion community recognized this too. A thread on November 11 called for real-world benchmarks.

**Operational cost is not in the numbers.** A faster query on a system your team cannot operate reliably is a slower query in practice.

Run your own comparison on a representative slice of your workload. Use the same storage, the same files, and the same instance types. Measure query latency, but also measure time to deploy, time to recover from a killed worker, and the effort to add your custom functions. CPU sizing for analytic workloads, including agent-driven ones, is covered in [Your Data Agents Are CPU-Bound, and the Hardware Market Just Noticed](https://datalakehousehub.com/blog/agentic-analytics-cpu-sizing/).

## A proof-of-concept plan

If you are choosing between the two, a two-week proof of concept answers more than any article. Here is a plan.

1. **Pick five queries** from real workloads: one large scan with a filter, one large aggregation, one join between two large tables, one join with a small dimension, and one query using a custom function you depend on.
2. **Fix the data.** Use the same Parquet or Iceberg tables in object storage for every run.
3. **Run single-node DataFusion first** as a baseline. Many teams find a large single node handles more than they expected.
4. **Stand up Ballista** with the Docker Compose or Kubernetes guide. Record the time and effort it takes.
5. **Embed datafusion-distributed** in a small service with the quick start. Record the code you had to write for discovery and networking.
6. **Run the five queries** at one, four, and eight workers on each.
7. **Kill a worker mid-query** on each system and record what happens.
8. **Add your custom function** to each and record the effort.

Steps 7 and 8 usually decide the outcome. Latency differences between well-configured engines tend to be smaller than differences in failure behavior and extensibility.

## Failure modes to plan for

**Shuffle disk exhaustion (Ballista).** Ballista materializes shuffle output to executor local storage. Large joins and aggregations write a lot of intermediate data. Size executor disks for your largest shuffles, and monitor free space.

**Stage barriers (Ballista).** A downstream stage waits for its entire upstream stage. One slow task holds the whole query. Watch for skewed partitions, where one key holds most of the data.

**Worker discovery drift (datafusion-distributed).** The application tells the planner where workers are. If that list goes stale, for example during autoscaling, queries get sent to workers that no longer exist. Tie the worker list to your service discovery, not to static configuration.

**Security gaps (datafusion-distributed).** Workers run gRPC servers that accept plan fragments and stream data. Because the library leaves networking to you, it is easy to expose those ports without authentication. Put workers on a private network and require mutual TLS between them.

**Version skew (both).** Distributed plans are serialized and sent between processes. Mixed versions of DataFusion across workers or between client and executors cause decode failures. Upgrade all nodes together.

**Maturity (both).** Ballista lists pipelined execution as experimental. datafusion-distributed is moving from a contrib repository to an Apache subproject. Track both projects' release notes closely and pin versions in production.

## What to watch next

The vote is the first milestone. If it passes and IP clearance completes, the repository moves to `apache/datafusion-distributed` and follows Apache release processes. That brings formal releases, release votes, and the governance structure enterprises often require before adopting open source.

The second milestone is how the two projects relate. The vote email says they will coexist, and the Ballista documentation already includes a page comparing itself with datafusion-distributed. Shared components, such as plan serialization and shuffle operators, are natural candidates for convergence over time. Watch the DataFusion dev list for discussions about shared code between the two.

The third is DataFusion itself. Release 56.0.0 went to a release candidate vote on November 13, alongside patch releases for 54 and 55. Both distributed projects track DataFusion's releases, so the core's pace sets theirs.

## Conclusion

Ballista and datafusion-distributed solve the same technical problem for different owners. Ballista is an engine. You deploy a scheduler and executors, and users connect to them. datafusion-distributed is a library. You build it into an application that already embeds DataFusion, and your application's own instances become the workers.

If you want a distributed SQL service to operate, start with Ballista. If you build a product on DataFusion and need it to scale out inside your own infrastructure, start with datafusion-distributed. In either case, run your own proof of concept, test failure behavior as hard as query speed, and pin versions while both projects mature.

## Keep Going

If this piece was useful, I have written a lot more on query engines and lakehouse architecture. My book *Architecting an Apache Iceberg Lakehouse* (Manning) covers how engines, catalogs, and storage fit together, and how to choose among engines for different workloads. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
