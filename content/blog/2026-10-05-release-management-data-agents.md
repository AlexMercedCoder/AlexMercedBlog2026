---
title: "Release Management for Data Agents: Shipping Prompts, Tools, Models, and Metrics Without Breaking Answers"
description: "Ship prompts, tools, models, and metric changes without breaking answers: agent manifests, shadow mode, canaries, and rollback."
date: 2026-10-05T09:00:00Z
tags: ["release management", "AI agents", "evaluation", "semantic layer"]
canonical: https://iceberglakehouse.com/posts/release-management-data-agents/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/release-management-data-agents/).

A data agent that worked on Friday gives a different answer on Monday. Nobody deployed anything. The model provider updated the model behind the same name over the weekend. Or a data engineer merged a small change to a metric description, and the agent's retrieval now prefers a sibling metric. Or someone rebuilt the metadata index with a newer embedding model, and the neighbors shifted. The agent's code did not change. Its behavior did.

Traditional software has release management because code changes break things. A data agent has more moving parts than most applications, and most of them are not code. The system prompt, the tool descriptions, the model, the embedding model, the metadata index, the example bank, and the semantic model each change on their own schedule, often owned by different people. Each one changes the answers the agent gives. Treating only the agent's code as a release is how teams end up debugging behavior that nobody shipped on purpose.

This article lays out a release discipline built for data agents. It defines a release unit that captures every component that shapes answers, explains how to pin the components you do not control, walks through a pipeline from change to production with shadow and canary stages, and shows how to make rollback a pointer switch instead of a scramble. It also argues that semantic model changes are agent releases and deserve the same gates. Throughout, the open lakehouse does the bookkeeping: Apache Iceberg tables hold the release ledger and the comparison data, Iceberg tags freeze evaluation data, and Apache Ossie keeps metric definitions in versioned files.

A disclosure: I work at Dremio, which builds a semantic layer and an MCP server that agents use. Nothing in this article depends on a particular vendor.

## Why Agents Break Between Deploys

List everything that determines what a data agent answers, and the length of the list explains the problem.

**The model.** The weights that generate every plan, query, and summary. Hosted providers update models, sometimes under the same alias. Self-hosted models change when someone pulls a new revision or a new quantization.

**The system prompt.** Instructions, examples of tone, rules about when to ask for clarification. Edited often, usually by people tuning one behavior who do not see the side effects on others.

**Tool definitions.** The names, descriptions, and parameter schemas the model sees. A one-word change to a tool description changes when the model calls it.

**Tool code.** What the tools actually do: how a semantic query is validated, how filter values are resolved, how errors are reported.

**The semantic model.** Metric definitions, dimension descriptions, synonyms, and AI instructions. Owned by data teams, edited for reasons that have nothing to do with the agent.

**The embedding model and metadata index.** Retrieval decides which metrics and dimensions the model even sees. A new embedding model or a rebuilt index changes retrieval results across the board.

**The example bank.** Few-shot question and query pairs that shape how the model handles common questions.

**Policies and grants.** What the agent's principal can read. A narrowed grant turns answers into refusals. A widened one exposes data the agent should not see.

**The engine and catalog.** Query engine upgrades change SQL behavior at the edges, such as null ordering, decimal rounding, or time zone handling.

Data changes too, constantly, but data changes are not releases. They are the reason the agent exists. The release discipline in this article covers everything on the list above and deliberately excludes the data, which evaluation handles by freezing it.

Two properties make this list dangerous. First, the components have different owners. A model upgrade belongs to the platform team, a prompt edit to the agent team, a metric change to finance analytics, an index rebuild to whoever runs the retrieval service. Second, many of them change silently. Nobody files a pull request when a hosted model alias moves. Release management for agents starts by making every one of these changes visible and deliberate.

## Define the Release Unit: The Agent Manifest

The first step is to name the thing you release. For a data agent, that is not a container image. It is a manifest that pins every component on the list, so that one identifier fully describes the agent's behavior apart from the data.

Here is a manifest in YAML.

```yaml
manifest_id: analyst-agent-2026.10.07-3
parent: analyst-agent-2026.09.30-1
created_by: agent-platform
model:
  provider: self-hosted
  name: Qwen/Qwen3-8B
  revision: 4f2c9a1            # exact weights revision
  quantization: awq-int4
  serving: {max_model_len: 16384, temperature: 0}
escalation_model:
  provider: hosted
  name: frontier-large
  version: "2026-08-14"        # dated snapshot, never a floating alias
prompt:
  system_prompt_sha: 9e1b77c4
  examples_bank: examples-v41
tools:
  package: analyst-tools
  version: 3.12.0
  descriptions_sha: 2d0a6f13
semantic_model:
  format: ossie
  repo: git@example.com:data/semantic-models.git
  commit: b81c3e0
retrieval:
  embedding_model: bge-small-en-v1.5@a3f9
  index_build: metadata-index-2026-10-06T22
policy:
  agent_principal_role: analyst_agent
  grants_sha: 51ac9d2
evaluation:
  golden_set: golden-v18
  data_tag: golden-2026-10
```

Walk through the parts that matter.

`manifest_id` and `parent` give each release an identity and a lineage. When something breaks, you diff the current manifest against its parent and see exactly which components moved.

`model` pins the weights revision and the quantization, not just the model name. Two builds of the same model at different quantization levels behave differently on edge cases, and the manifest has to tell them apart.

`escalation_model` uses a dated snapshot version for the hosted model. Floating aliases that always point at the latest version are convenient in prototypes and unacceptable in a manifest, because they let the provider ship a release on your behalf.

`prompt` and `tools` record content hashes. The prompt and tool descriptions live in version control, and the hash proves which text was live.

`semantic_model` points at a specific commit of the repository that holds the Ossie model files. Apache Ossie, the open specification for semantic model interchange, stores datasets, metrics, relationships, and AI instructions as YAML or JSON. Because it is plain files, a git commit pins the entire semantic model at once.

`retrieval` pins both the embedding model and the index build. They move together: a new embedding model requires a new index, and an index built with one embedding model is meaningless to another.

`policy` records which principal role the agent uses and a hash of its grants, so a grant change shows up as a manifest change.

`evaluation` records which golden question set and which frozen data tag the release was tested against.

With a manifest, three questions that used to be hard become lookups. What is in production? The current manifest. What changed? The diff from its parent. What was tested? The evaluation block and its results.

## Pin What You Do Not Control

Some components change without your involvement unless you pin them. Each needs a specific approach.

**Hosted models.** Use dated or versioned model identifiers wherever the provider offers them, and record the identifier in the manifest. Track the provider's deprecation schedule for each pinned version, and plan upgrades as releases before the old version retires. A forced migration with two days of notice is how teams end up shipping an untested model.

**Self-hosted models.** Pin the exact weights revision from the model repository, the quantization method, and the serving parameters. Store the weights in your own artifact store rather than pulling from a public hub at startup, so a deleted or modified upstream revision cannot change production.

**Embedding models.** Treat them like generation models. A new embedding model is a full release, because it changes retrieval for every question. Keep the old index until the new release has fully rolled out, so rollback does not require a rebuild.

**Engines and catalogs.** Pin engine versions in the deployment that serves agent queries, and run the golden questions as part of every engine upgrade. Small changes in rounding, null handling, or time zones show up as failed questions long before users notice.

**Upstream semantic changes.** Metric definitions live in a repository owned by data teams. Pin the agent to a commit rather than to the branch head, so a merged metric change reaches the agent only through a release.

The rule underneath all of these is simple: nothing reaches the production agent except through a new manifest. Anything that bypasses the manifest is a change you will discover from a user.

## The Pipeline: From Change to Production

With a manifest defined, every change follows the same path. A new manifest is proposed, tested, compared against live traffic, exposed to a small share of users, and then promoted. Each stage has a gate, and a failed gate stops the release.

**Stage one: propose.** Someone changes a component and opens a pull request that produces a new manifest. The pull request shows the manifest diff. Reviewers see at a glance that this release changes the system prompt and nothing else, or changes the semantic model commit and the index build together. Small diffs are easy to review and easy to blame later. A release that changes the model, the prompt, and the semantic model at once is three releases bundled together, and when it fails you will not know which part failed. Keep releases to one component change whenever possible.

**Stage two: smoke test.** A fast subset of golden questions, around 40, runs against the new manifest on every pull request. Each question has an expected answer computed against Iceberg tables frozen with a tag, so the data cannot drift between runs. This stage catches broken tools, malformed prompts, and obvious regressions in minutes.

**Stage three: full evaluation.** The complete golden question set runs, with paraphrases, several times to absorb run-to-run variation. Gates check the overall pass rate, a per-category limit so no single category collapses inside a stable average, a zero-tolerance rule on permission violations, and a cost and latency budget. A release that holds its accuracy but doubles token usage per question fails here too. So does a release whose median latency climbs past the budget, because users feel a slower agent long before they notice a small accuracy change.

**Stage four: shadow.** The new manifest runs alongside production on real traffic, without users seeing its answers. This catches what golden questions miss, because real users ask things nobody thought to write down.

**Stage five: canary.** A small share of real sessions get the new manifest's answers. Live metrics decide whether it proceeds.

**Stage six: promote.** The new manifest becomes the default. The old one stays deployable for fast rollback.

Not every change needs every stage. A typo fix in one metric description can go from full evaluation straight to a short canary. A new model needs all six. Write down which changes require which stages, so the decision does not depend on who is on call.

## Shadow Mode on Live Traffic

Shadow mode is the most underused stage, and the most useful one for data agents. Golden questions test what you expected users to ask. Shadow mode tests what they actually ask.

The mechanics are simple. For a sampled share of production requests, the router sends the question to both the production manifest and the candidate manifest. The production answer goes to the user. The candidate answer goes to storage. Both run with the same user identity and the same permissions, so the comparison is fair, and the candidate never shows a user anything.

Then compare the two answers, and focus on disagreements.

**Same answer.** Most questions. Nothing to do.

**Different answer, both plausible.** The interesting cases. One of the two is wrong, or the question is ambiguous and the two manifests resolved it differently. Sample these for human review. When the candidate is right, you have found a real improvement. When production is right, you have found a regression the golden set missed, and the question belongs in the golden set now.

**Candidate refused or asked for clarification where production answered.** Sometimes this is a regression. Sometimes the candidate is correctly declining a question production answered with a guess. Review a sample.

**Candidate errored.** A clear regression. Count these and gate on them.

Store everything in Iceberg. Each shadow comparison is a row: the request ID, the tenant and policy context, both manifest IDs, both canonical queries, hashes of both result sets, the snapshot IDs each result was computed from, and the comparison outcome. Storing snapshot IDs matters, because a shadow answer computed a second after the production answer can see a newer snapshot. When the snapshot IDs differ, the comparison is not apples to apples. Either rerun the candidate pinned to production's snapshots with Iceberg time travel, or exclude the pair.

```sql
-- Disagreement rate by question category for a candidate manifest in shadow.
SELECT category,
       COUNT(*) AS compared,
       SUM(CASE WHEN outcome = 'different_answer' THEN 1 ELSE 0 END) AS different,
       SUM(CASE WHEN outcome = 'candidate_error' THEN 1 ELSE 0 END) AS errors,
       ROUND(100.0 * SUM(CASE WHEN outcome <> 'same_answer' THEN 1 ELSE 0 END) / COUNT(*), 2)
         AS disagreement_pct
FROM agent_ops.shadow_comparisons
WHERE candidate_manifest = 'analyst-agent-2026.10.07-3'
  AND production_snapshot_ids = candidate_snapshot_ids
GROUP BY category
ORDER BY disagreement_pct DESC;
```

The query groups comparisons by question category and reports disagreements and errors for one candidate. The filter on matching snapshot IDs keeps only comparisons where both manifests read the same data. Sorting by disagreement rate puts the categories that need review at the top.

Shadow mode costs real money, since every shadowed request runs twice. Shadow a sample rather than all traffic, such as 10 to 20 percent, and run it for long enough to cover your weekly traffic pattern. Monday morning questions differ from Friday afternoon questions.

## Canary Releases by Cohort

A canary exposes real users to the candidate's answers, in a controlled slice, with fast automatic rollback.

Three design choices make canaries work for agents.

**Sticky assignment.** A user who gets the candidate in one message must keep getting it for the whole session, and ideally for the whole canary period. An agent that switches manifests mid-conversation produces inconsistent answers to follow-up questions, and users notice.

**Cohort selection.** Start with internal users, then a slice of external users, then larger slices. In multi-tenant products, choose tenants that agreed to early releases, and avoid putting your largest or most regulated customers in the first slice.

**Automatic rollback triggers.** Define the metrics that end a canary without a human in the loop. Error rate above a threshold. Thumbs-down rate meaningfully above the control group. Clarification or refusal rate shifting sharply in either direction. Any permission violation. Cost per question above budget.

Here is a compact router that handles sticky assignment and rollback.

```python
import hashlib

class ManifestRouter:
    def __init__(self, production: str, candidate: str | None = None, canary_pct: float = 0.0,
                 allowed_tenants: set[str] | None = None):
        self.production = production
        self.candidate = candidate
        self.canary_pct = canary_pct
        self.allowed_tenants = allowed_tenants
        self.halted = False

    def manifest_for(self, user_id: str, tenant_id: str) -> str:
        if self.halted or not self.candidate or self.canary_pct <= 0:
            return self.production
        if self.allowed_tenants is not None and tenant_id not in self.allowed_tenants:
            return self.production
        bucket = int(hashlib.sha256(f"{self.candidate}:{user_id}".encode()).hexdigest(), 16) % 10_000
        return self.candidate if bucket < self.canary_pct * 100 else self.production

    def check_and_halt(self, metrics: dict, control: dict) -> bool:
        """Stop the canary when any trigger fires. Returns True if halted."""
        triggers = [
            metrics["permission_violations"] > 0,
            metrics["error_rate"] > max(0.02, control["error_rate"] * 2),
            metrics["thumbs_down_rate"] > control["thumbs_down_rate"] + 0.03,
            metrics["cost_per_question"] > control["cost_per_question"] * 1.25,
        ]
        if any(triggers):
            self.halted = True
        return self.halted
```

Walk through it.

`manifest_for` hashes the candidate ID together with the user ID into one of 10,000 buckets. The same user lands in the same bucket for the life of the canary, which gives sticky assignment without storing anything. Including the candidate ID in the hash means each new canary draws a different set of users, so the same people are not always the test group.

`canary_pct` sets the share of buckets that get the candidate. A value of 5 sends 5 percent of users. The tenant allowlist restricts the canary to tenants that opted in.

`check_and_halt` compares live canary metrics with the control group on the production manifest. The thresholds are examples. Set yours from your own baseline variation. A permission violation halts the canary on its own, regardless of anything else.

Once halted, `manifest_for` returns the production manifest for everyone. Because the manifest pins every component, halting is a complete rollback. There is no partial state to clean up.

Run the halt check every few minutes during the canary, from the same metrics pipeline that feeds your dashboards. A canary that someone has to remember to check is not a canary.

## Rollback That Actually Works

Every team says it can roll back. For data agents, rollback often fails for one of four reasons, and the manifest approach fixes each one.

**The old version no longer exists.** A hosted model alias moved, or the previous prompt was overwritten in a configuration store. With a manifest, every component is pinned to an immutable identifier. The previous manifest refers to things that still exist, because you kept them.

**Components were rolled back separately.** Someone reverted the prompt but not the tool descriptions that the new prompt depended on. The result is a combination that was never tested. With a manifest, rollback switches the whole set at once, back to a combination that passed every gate.

**The index was rebuilt in place.** The new embedding model's index replaced the old one, so rolling back the model leaves it searching an index it cannot read. Keep the previous index build until the new release is fully promoted and has run cleanly for a set period, such as two weeks.

**Caches kept the new behavior alive.** Results and narration cached under the new manifest keep getting served after rollback. Include the manifest ID, or at least the semantic model commit and prompt hash, in cache keys for anything the agent generates. Result caches keyed on canonical queries and metric definition hashes handle semantic changes on their own, because a definition rollback changes the hashes back.

Three kinds of rollback need extra care.

**Semantic model rollbacks.** Reverting a metric definition reverts what the agent computes, which is usually what you want. But users who saw the new numbers during the canary will now see different numbers. If the change was a correction, rolling it back reintroduces the error. Decide case by case, and tell affected users either way.

**Policy rollbacks.** If a release widened the agent's grants and you roll back, the grants narrow again. Any question that depended on the wider access now gets refused. That is correct behavior, but it looks like an outage to users mid-conversation. Roll back policy changes during low traffic, and message users.

**Write-capable agents.** If the agent writes anything, such as saved analyses, tagged records, or tickets, rolling back the agent does not roll back what it wrote. Have write-capable agents record the manifest ID on every write. When a release turns out to be bad, you can find everything it produced. If the agent writes to Iceberg tables, write to a branch first and publish after validation, so a bad release's writes can be discarded without touching the main branch.

Data is the one thing an agent rollback never touches. If a bad release produced wrong answers, the fix for users is a correction and a notification, not a change to the tables. Keep those two concerns separate.

## The Release Ledger

Release history is data. Store it as data.

Keep two Iceberg tables in an `agent_ops` namespace. The first, `releases`, has one row per manifest: the manifest ID, parent, full manifest text, who proposed it, which stages it passed, when each stage started and ended, the promotion time, and the rollback time if there was one. The second, `release_evaluations`, has one row per golden question attempt per manifest, with pass or fail, the failure reason, cost, and latency.

With the ledger in tables, release questions become queries.

```sql
-- Which component changes have caused the most rollbacks this year?
SELECT changed_component,
       COUNT(*) AS releases,
       SUM(CASE WHEN rolled_back_at IS NOT NULL THEN 1 ELSE 0 END) AS rollbacks,
       ROUND(100.0 * SUM(CASE WHEN rolled_back_at IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1)
         AS rollback_pct
FROM agent_ops.releases
WHERE proposed_at >= DATE '2026-01-01'
GROUP BY changed_component
ORDER BY rollback_pct DESC;
```

The `changed_component` column comes from the manifest diff against the parent, computed when the release is proposed: model, prompt, tools, semantic model, retrieval, examples, or policy. The query shows which kinds of change are riskiest in your organization. If semantic model changes roll back more often than model upgrades, your metric review process needs more attention than your model evaluation does.

Because the ledger is in Iceberg, any engine reads it, and it lives under the same catalog and access controls as everything else. Auditors asking what the agent was running on a given date get a precise answer. With Iceberg time travel, you can even show what the ledger itself said at that time.

Join the ledger with agent telemetry and you get the most useful question of all: for any answer a user received, which manifest produced it and what that manifest's evaluation results were. That join is the starting point of every incident investigation.

## Semantic Model Changes Are Agent Releases

The release discipline breaks most often at the boundary between the agent team and the data teams. A finance analyst changes the definition of `net_revenue` to exclude a new type of credit. The change is correct, reviewed by finance, and merged into the semantic model repository. Dashboards pick it up overnight. So does the agent, unless the agent is pinned. And because nobody thought of the metric change as an agent change, nobody ran the agent's evaluation.

Treat every semantic model change as a candidate agent release. In practice, that means three things.

**Pin the agent to a semantic model commit.** As described above, the manifest records a specific commit. A merged metric change does nothing to the agent until a new manifest picks it up.

**Generate a manifest automatically.** When the semantic model repository merges a change, automation creates a candidate manifest that differs from production only in the semantic model commit, and runs the pipeline. The data team does not have to know the agent's release process. The process comes to them.

**Run the affected questions with their owners.** Golden questions record which metrics they depend on. When a metric changes, the pipeline knows which questions are affected and which ones will now have a different correct answer. Those questions go to the metric owner for review. Either the owner confirms the new expected answer, or the change has a problem.

Ossie's file format helps here. Because semantic models are plain YAML or JSON in a repository, a metric change is a reviewable diff, and automation can parse it to find which metrics, dimensions, and AI instructions changed. A change to a metric's `ai_context` instructions affects retrieval and interpretation without changing any number, so it needs a different review than a change to the metric's expression. The format makes that distinction visible.

The same logic applies to dimension descriptions and synonyms. A new synonym that maps "workspace" to the account dimension changes which questions the agent understands. It is small, it is helpful, and it is still a release.

## A Release Walked Through: Changing the Embedding Model

To see the stages work together, here is a hypothetical walk-through of one of the riskiest routine changes: replacing the embedding model that powers metadata retrieval. The numbers are illustrative, but the pattern is common.

The motivation is reasonable. A newer, smaller embedding model handles domain vocabulary better, and the retrieval team wants it. The change touches one block of the manifest, `retrieval`, but both fields in that block move: the embedding model and the index build, since a new model needs a new index.

**Propose.** The retrieval team builds a new index from the pinned semantic model commit using the new embedding model, and stores it alongside the current index rather than replacing it. The pull request creates a candidate manifest whose diff shows only the retrieval block.

**Smoke and full evaluation.** The golden questions run against the candidate. Overall pass rate holds. Per-category results show a 6-point gain on questions that use domain jargon and a 9-point drop on questions involving time comparisons. Looking at failures, the new model ranks a `fiscal_period` dimension below a `calendar_month` dimension for phrases like "last quarter," so the agent builds queries on the wrong calendar. The per-category gate fails the release.

**Fix and retry.** The fix belongs in the semantic model, not the retrieval service. The metric owner adds clearer descriptions and synonyms to the fiscal period dimension in the Ossie file. That is a semantic model change, so it gets its own candidate manifest, its own evaluation, and its own promotion, first. Then the retrieval candidate is rebased onto the new semantic commit, its index is rebuilt, and evaluation passes in every category.

**Shadow.** Two weeks in shadow at 15 percent of traffic shows a disagreement rate under 3 percent on matching snapshots. Review of a sample finds the candidate right more often than production in the disagreements, mostly on questions using product nicknames that the old embedding model missed.

**Canary and promote.** A week of canary at 10 percent, internal users first, with no halt triggers. Promotion follows. The old index stays available for two more weeks in case rollback is needed, then retires.

Notice what the process caught. The new embedding model was better on average and worse on one category. An average-only gate ships it, and users asking about quarters start getting calendar-quarter numbers instead of fiscal-quarter numbers. The fix also landed in the right place: a clearer semantic model that helps every model and every tool, rather than a retrieval hack that helps only this one.

## Business Calendars and Change Freezes

Software teams freeze changes around peak traffic. Data agents need freezes around the business calendar instead.

The riskiest times to change a data agent are when its answers matter most: quarter close, board preparation, annual planning, and audit periods. During those windows, finance and leadership lean on the agent heavily, and a subtle regression in a revenue metric does real damage. Freeze model, prompt, retrieval, and semantic model releases for the agent during those windows, and allow only fixes for confirmed incidents.

The ledger makes freezes enforceable. Record freeze windows in a small table, and have the pipeline refuse to promote any manifest during a freeze unless it carries an incident reference. After the window ends, release the queued changes one at a time, not as a batch, so the first week after close does not become a week of tangled regressions.

Freezes also apply in reverse. When the business changes something important, such as the fiscal calendar, the revenue recognition rules, or the region structure, the semantic model changes with it, and the agent needs a planned release timed to the business change. Schedule it like any other launch, with metric owners reviewing affected golden questions ahead of the effective date.

## Who Owns Which Gate

A release process for agents spans several teams, and it works only when each team knows which decisions belong to it.

**The agent platform team** owns the manifest format, the pipeline, the router, and the ledger. They decide which stages each kind of change requires and maintain the automation that creates candidate manifests. They do not decide whether a metric definition is correct.

**The agent team** owns the prompt, the tools, the example bank, and the model choice. They propose most releases and triage shadow disagreements and canary results.

**Metric owners** own the semantic model and the expected answers of golden questions that depend on their metrics. When a release changes what a correct answer is, they sign off. When a shadow disagreement involves their metrics, they decide which answer is right.

**Security and governance** own the agent's grants and the zero-tolerance gates on permission violations. Any manifest that changes the policy block needs their approval.

**On call** owns the halt button. Anyone on call can halt a canary or roll back production without approval. Promotion needs the owners. Rollback needs only judgment.

Write these responsibilities into the pipeline itself. Required reviewers on pull requests that touch each manifest block make the ownership automatic. A semantic model change cannot skip the metric owner, and a policy change cannot skip security.

Keep the cadence predictable. A weekly release train for routine changes, with an expedited path for fixes, keeps the number of simultaneous candidates low. Two candidates in shadow at once is manageable. Five is not, because their disagreements overlap and nobody can tell which candidate caused what.

## Failure Modes and Warning Signs

Release processes for agents fail in recognizable ways.

**Floating aliases in production.** A hosted model referenced by a "latest" alias, or a semantic model tracked at branch head. The warning sign is behavior changes with no corresponding manifest change in the ledger. Scan production configuration for floating references and treat each one as a defect.

**Bundled releases.** One release changes the model, the prompt, and the semantic model. It fails, and nobody knows why. The warning sign is manifest diffs that touch several blocks. Split them and ship in sequence.

**Shadow comparisons across different data.** The candidate's shadow answer reads a newer snapshot than production's answer, and every disagreement looks like a regression. The warning sign is a disagreement rate that correlates with how often the underlying tables commit. Compare only pairs with matching snapshot IDs, or rerun the candidate pinned to production's snapshots.

**Canaries without automatic halts.** The canary runs, someone forgets to check it, and a regression reaches 20 percent of users for a weekend. The warning sign is canary stages longer than planned with no metric reviews in the ledger. Make halts automatic.

**Evaluation sets that lag the product.** The golden questions reflect last quarter's features and miss this quarter's. Releases pass every gate and still break new workflows. The warning sign is user-reported regressions on questions that have no golden counterpart. Feed shadow disagreements and user reports back into the golden set every week.

**Rollback that skips caches.** The agent rolls back, but cached narration from the bad release keeps appearing. The warning sign is user reports of the old bad behavior after a confirmed rollback. Key generated content on the manifest, or flush on rollback.

**Unowned semantic changes.** A metric change reaches the agent without its owner reviewing affected golden questions. The warning sign is golden question failures right after a semantic model merge, followed by someone updating expected answers without a metric owner's sign-off. Require the owner's approval for expected-answer changes.

**Release fatigue.** The process is so heavy that people route around it, pushing prompt edits directly to a configuration store. The warning sign is production changes outside the ledger. Make the light path genuinely light for small changes, so nobody has a reason to bypass it.

## Operational Guidance

Introduce release management in the order that removes the most risk first.

**Start with the manifest and pinning.** Even before any pipeline exists, write down the full manifest of what is in production and pin every floating reference. This alone stops silent changes.

**Add golden-question gates next.** A smoke subset on pull requests and a full run before promotion, with frozen Iceberg tags for the data. This catches most regressions before users see them.

**Add the ledger.** Record every manifest, every evaluation result, and every promotion and rollback in Iceberg tables. From this point on, every incident investigation starts with a query instead of a search through chat history.

**Add shadow mode for model and retrieval changes.** These are the changes most likely to shift behavior in ways golden questions miss.

**Add canaries with automatic halts.** Start with internal users, then extend to opted-in customers.

**Automate semantic model candidates last.** Once the pipeline is reliable, wire the semantic model repository into it so every merged metric change becomes a candidate release with metric-owner review.

**Write the runbook before the first rollback.** Document how to halt a canary, how to roll production back to the previous manifest, how to flush manifest-keyed caches, and how to tell users. Practice it once on a harmless release. The first real rollback is a bad time to discover that the previous index was deleted or that nobody knows where the router configuration lives.

**Keep manifests small enough to read.** A manifest that runs to hundreds of lines stops being reviewed. Keep it to the pins that shape behavior, and link out to detailed configuration by hash. Reviewers should be able to read a manifest diff in under a minute and know what changed.

**Separate the release ledger's access from the agent's.** The agent principal should never be able to write to `agent_ops`. Only the pipeline's service principal writes releases and evaluations, and an Apache Polaris catalog role can enforce that boundary like any other grant. A ledger the agent can modify is not a record anyone can trust.

**Measure the process.** Track lead time from proposal to promotion, the share of releases that roll back, and the share of incidents traced to changes outside the ledger. The last number should reach zero and stay there.

## Where This Is Heading

Three developments will make this discipline easier.

Model providers are moving toward explicit versioning with published deprecation schedules, and open-weight models give teams full control of the weights they run. Both make pinning practical. The remaining gap is behavioral transparency: knowing what changed between two versions of a model. Golden questions and shadow comparisons fill that gap for your own workload, whatever the provider publishes.

Semantic models are becoming standard files. Apache Ossie's community is defining semantic models, expression languages, and query interfaces in an open specification, with converters to and from existing tools. As more of the agent's knowledge lives in versioned Ossie files rather than in proprietary configuration screens, more of the release unit becomes something you can diff, review, and pin.

Agent definitions are becoming files too. Teams increasingly describe agents declaratively: the model, the instructions, the tools, the permissions. A declarative agent definition and a release manifest are close relatives. When the definition itself is a versioned file, the manifest becomes a pointer to a commit, and agent release management starts to look like ordinary software release management, with the data platform keeping the records.

## Conclusion

A data agent's behavior depends on far more than its code. The model, prompt, tool descriptions, semantic model, retrieval index, example bank, and grants each shape the answers, and each changes on its own schedule. Release management for agents starts by naming all of them in one manifest and pinning every one, so nothing changes in production except through a deliberate release.

From there, the pipeline is familiar. Small, single-component releases. Golden questions against frozen Iceberg data. Shadow comparisons on live traffic, compared only where both answers read the same snapshots. Sticky canaries with automatic halts. Rollback as a pointer switch to a manifest that already passed every gate. And semantic model changes treated as agent releases, reviewed by the people who own the metrics.

The open lakehouse supplies the record keeping. Iceberg tables hold the ledger, the evaluations, and the shadow comparisons, readable by any engine and governed by the same catalog as the business data. Iceberg tags freeze evaluation data, and time travel reproduces exactly what an answer saw. Ossie keeps metric definitions in versioned files that pin to a commit. With those pieces, "what was the agent running when it said that" becomes a question you answer in one query.

## Keep Going

If this piece was useful, I have written a lot more on running AI agents reliably on top of open lakehouse data. *Evaluating AI Systems: Testing LLMs, RAG, and Agents* covers the evaluation side of this process in depth, from golden questions to comparing model versions. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
