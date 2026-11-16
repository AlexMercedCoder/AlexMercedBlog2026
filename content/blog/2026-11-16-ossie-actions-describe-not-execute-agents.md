---
title: "Should Semantic Models Describe Actions? Apache Ossie and the Describe-Not-Execute Boundary for Agents"
description: "Should Apache Ossie describe actions agents can take? Two November proposals, the describe-never-execute boundary, and where enforcement actually lives."
date: 2026-11-16T09:00:00Z
tags: ["Apache Ossie", "Semantic Layer", "AI Agents", "Data Governance", "Standards"]
canonical: https://datalakehousehub.com/blog/ossie-actions-describe-not-execute-agents/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/ossie-actions-describe-not-execute-agents/).

Apache Ossie describes semantic models: datasets, metrics and relationships. Its dev list is debating whether the ontology should also describe actions, the operations an agent can take on business objects. The boundary set so far is that Ossie describes an operation but never executes it, leaving execution and authorization to other layers.

Agents are pushing semantic layers in a new direction. A semantic layer used to answer one kind of question: what does this business term mean, and how is this metric computed? An agent that understands those answers wants to do something next. It wants to open a retention case, record an exit, or update a forecast. The question is whether the shared semantic standard should say anything about those operations.

Two proposals reached the Apache Ossie dev list in early November 2026. Purvaja Narayanaswamy of Snowflake proposed Action as a concept in the ontology spec on November 4 ([thread](https://lists.apache.org/thread/psgo3yx8t3txm8j4xtwdq2t5l0mvpx7x)). Bei Li of Google shared a broader document, "Adding Actions to Apache Ossie," on November 9, developed with RelationalAI, and proposed a working group ([thread](https://lists.apache.org/thread/s0y77vx8d7h41zp09d0vv5rmcz3br6dm)). This article covers what each proposal says, the boundary the community drew, and where execution and authorization have to live. A disclosure: I work at Dremio, which ships an AI Semantic Layer. This piece is about the open standard.

## Why agents push semantic layers from reading toward doing

Apache Ossie is an incubating Apache project that standardizes how semantic metadata moves between analytics, BI, and AI platforms. Its core spec covers datasets, measures, and relationships. Its ontology spec describes the business itself: entity types such as Employee, value types such as a currency amount, and relationships between them. How the query side works for agents is covered in [How Apache Ossie Is Deciding What Agents and BI Tools Can Ask a Semantic Layer](https://iceberglakehouse.com/posts/ossie-semantic-query-interface-agents/) on IcebergLakehouse.com.

Purvaja's proposal names the gap in one line. A term says what something means. A metric says how it is measured. Nothing says what the business can do.

That gap matters for agents in a specific way. An agent can learn what Employee means and how regrettable attrition is calculated. It has no shared way to know which existing callable is the recognized "record an exit" operation, or which entity that operation is allowed to touch. In a real organization, several tools can change employee records: an HR system API, a stored procedure, a data correction script, and an MCP tool someone built last quarter. An agent that picks the wrong one does damage that a wrong query never does.

Reading and doing have different risk profiles. A wrong query returns a wrong number, which a person can catch before acting. A wrong action changes a record, and the change propagates. So the question "should the semantic standard describe actions" is really two questions. Does a shared definition help agents pick the right operation? And can the standard provide that definition without becoming a runtime, a permission system, or a workflow engine?

## Proposal one: Action as an ontology concept

Purvaja's November 4 proposal defines an Action as the verb next to the ontology's nouns. It names an operation the business recognizes, the entity that operation changes, what must be true before it runs, and which existing callable performs it. Her examples: Record Employee Exit acts on Employee. Open Retention Case acts on Employee.

The proposal is explicit about what an Action is not. The ontology stores the definition. It does not run the operation, grant permission, block execution, or audit the run. It is also not a representation. A representation answers "what data stands for this concept," a read binding, such as Employee represented as the employee table. An Action answers "what operation is this, and which implementation is the recognized one."

Stewardship follows the ontology's existing path. The domain steward owns the business statement: the name, the target entity, the effects, and the criteria. The implementation owner owns the callable and proposes it as the target, whether a stored procedure, an MCP tool, or another named callable. One approval is enough.

The payoff is visibility. Once Actions exist, the ontology graph shows which operations touch Employee, the same way it shows which metrics describe Employee. When several write tools exist, the contract names the recognized one.

### Precedents

Jochen Christ of Entropy Data asked which other ontologies use Action as a concept. Purvaja's answer listed three precedents.

- **Schema.org** has an Action class with subtypes such as CreateAction, UpdateAction, and DeleteAction. A thing exposes what can be done to it through `potentialAction`. An action has an object, a result, and a target entry point, and schema.org distinguishes a potential action from one that already happened.
- **Palantir Foundry** has action types beside object types, with parameters, submission criteria, and rules that create, modify, or delete objects. Foundry executes the action and enforces the criteria. Her proposal only records the definition.
- **OWL-S**, an older web services model, describes atomic processes with inputs, preconditions, and effects. That is the same contract shape under a different name.

She noted that enterprise ontologies such as FIBO, gist, and BFO do not have the concept. They describe what exists or processes that occur, not named operations bound to callables.

Piotr Sowiński of NeverBlink added a fourth data point. His team implemented experimental first-class actions in LinkML, a data modeling language, which map to function interfaces in Python, TypeScript, and Scala. His advice: do not go far into policies, because they are too tied to the execution environment.

## Proposal two: Adding Actions to Apache Ossie

Bei Li's November 9 email shared a document developed by Google with Molham Aref, Ankit Tandon, and Kurt Stirewalt of RelationalAI, and shared earlier with Josh Klahr and Purvaja at Snowflake. Bei asked people to comment on the document, add their names to participate, and join a new working group channel.

Jean-Baptiste Onofré replied the next morning with a process reminder that applies to every Apache project. Discussions like this belong on the dev list, in the open, not among a few committers. Working groups discuss, but decisions are made on the dev list. Bei agreed and asked JB to leave specific comments in the document for the working group to follow up on.

Matthew Mullins of Coginiti raised a scope question on November 10 that the two proposals need to answer together. He found it unclear where actions live in Ossie's existing layers. Semantic models have always sat close to a data plane, such as a semantic model over a database. The document discusses write-back, which some semantic layers already support over the data plane. Then it moves to REST and gRPC endpoints, and its example uses an MCP endpoint, which he noted sit outside the scope of any existing semantic layer he knows.

That observation separates two very different ideas that share the word "action."

- **Write-back** is a semantic layer writing data to its own data plane, such as saving a forecast adjustment to a table the model already reads.
- **Operations** are calls to systems outside the data plane, such as an HR API or an MCP tool that opens a ticket.

A semantic standard that covers write-back stays close to data. One that covers arbitrary operations becomes a catalog of enterprise APIs. The second is a much bigger scope.

## Write-back on a lakehouse, and why it is a separate case

Matthew's distinction matters most on an open lakehouse, because write-back there has a clean, well-understood path. An analyst adjusting a forecast, a planner entering a target, or a reviewer tagging records as checked all produce small amounts of new data that belong next to the data the semantic model already reads.

On Apache Iceberg, that path is an append or a merge into a table the model knows about. A forecast adjustment becomes a row in a `forecast_adjustments` table with the user, the time, the entity, and the new value. The semantic model then reads base forecasts plus adjustments. The write goes through the catalog, so table permissions apply, and every change is a snapshot you can audit or roll back with time travel.

That kind of action stays inside the data plane. The semantic layer already knows the tables, the permissions model is the catalog's, and the effects are rows in tables. Describing it in an ontology adds clarity without adding new systems.

External operations are different. Recording an employee exit in an HR system, opening a support case, or issuing a refund happens in systems with their own data, their own permissions, and their own approval steps. The ontology can name those operations and point at their effects in business terms. It cannot see whether they succeeded, roll them back, or apply their permissions.

A working group draft that treats both cases the same will confuse implementers. One that separates them, with write-back as a near-term, data-plane case and external operations as a description-only case, gives each the right expectations.

## The boundary: describe, never execute

Yufei Gu raised the scope concern directly on November 5. Introducing Action as a first-class concept risks expanding Ossie's scope considerably. Once Actions exist, should Ossie also cover workflows, policies, and approvals? He also asked whether actions make interoperability harder, since the same Action can have different parameters, preconditions, and behaviors in different systems. He asked what interoperability problem the proposal solves, and whether Action needs to be in the core ontology spec.

Purvaja's answer set the boundary at the definition of one business operation and nothing past it. Workflows, policies, approvals, and execution stay out. Criteria are text the consumer can read. The platform does not evaluate them, and storing the callable's name is not a permission. The interoperability problem is a shared name for the operation, so two systems that already exchange what Employee means can also agree on which callable is "record an employee exit." Parameters and behavior differ by system, and the contract carries them as declared fields rather than trying to normalize them.

JB then proposed the line the thread converged on, and it gives this article its title. Ossie describes an operation. It never executes, authorizes, or orchestrates it. Ossie is not a runtime. So no policies, no workflows, no approvals, and the spec should say so.

He added three design suggestions, which Purvaja accepted on November 5:

1. **Place Action beside concepts, not as a new concept type.** In the spec, a concept is a population of objects or values. An action is not a population.
2. **Reuse what the ontology already provides.** Type parameters with concepts instead of raw data types. Write criteria in the same expression language the ontology uses for `requires` and `derived_by`, with an optional description for people. Make effects reference ontology relationships and concepts, and keep physical names in the mappings.
3. **Keep the callable out of the ontology document.** Binding an action to a callable is close to what mappings do for concepts. An action binding next to the mappings lets each platform bind the same action to its own callable with its own signature. Vendor-specific callable kinds belong in the extensions registry, not a vendor-neutral enum. Operation kinds can point to schema.org's CreateAction, UpdateAction, and DeleteAction through the `iri` field instead of a new enum.

JB also asked for a concrete interoperability scenario before any pull request, and called the work experimental.

## The interoperability scenario

Purvaja supplied the scenario JB asked for. Two platforms share one ontology and nothing platform-specific.

- Employee is an entity type.
- `RecordEmployeeExit` sits beside it, acts on Employee, and is an UpdateAction by IRI.
- Its parameters are the concepts EmployeeId, ExitDate, and Regrettable.
- Its criterion is the expression "the Employee is active," with a human-readable description.
- Its effects name the Employee status relationship and the ExitEvent concept.

Platform A binds `RecordEmployeeExit` to its stored procedure `PEOPLE.RECORD_EMPLOYEE_EXIT`. Platform B binds the same action to its own API or tool with a different signature. Each consumer gets the same operation, the same entity, and the same criterion. Each binding supplies only that platform's callable. Neither binding is in the shared ontology.

Here is a sketch of how that splits across documents. The structure follows the thread. The field names are illustrative, since no spec text exists yet.

```yaml
# Shared ontology: portable, vendor-neutral.
actions:
  - name: RecordEmployeeExit
    iri: https://schema.org/UpdateAction
    acts_on: Employee
    parameters:
      - name: employee
        concept: EmployeeId
      - name: exit_date
        concept: ExitDate
      - name: regrettable
        concept: Regrettable
    criteria:
      expression: "Employee.status = 'active'"
      description: "Only active employees can be exited."
    effects:
      - relationship: Employee.status
      - concept: ExitEvent

# Platform A binding: lives next to Platform A's mappings, not in the ontology.
action_bindings:
  - action: RecordEmployeeExit
    callable:
      kind: stored_procedure
      name: PEOPLE.RECORD_EMPLOYEE_EXIT
```

The `actions` block is what every platform shares. It names the operation, points its kind at schema.org through `iri`, and says it acts on Employee. Parameters are typed by ontology concepts rather than raw types. The criterion uses an expression a consumer can read, plus a description for people. Effects point at ontology relationships and concepts. The `action_bindings` block belongs to one platform. It ties the shared action to that platform's callable, and a second platform writes its own binding to its own API or MCP tool. Nothing in the binding grants permission to call it.

## Where actions get enforced

The boundary leaves an obvious question: if Ossie only describes actions, what stops an agent from calling the wrong one, or calling the right one for the wrong employee? The answer is that enforcement lives where it already lives, at the layers that execute calls.

**MCP tools.** The callable behind an action is often an MCP tool. The MCP server authenticates the caller, validates arguments, and runs the operation. It should check the criterion itself, since Ossie's criterion is descriptive.

**Gateways.** An MCP gateway in front of the tool decides whether this agent, acting for this user, is allowed to call this tool at all. It logs the call with both identities. The controls gateways enforce are compared in the [Agent Gateway Control Matrix](https://datalakehousehub.com/blog/agent-gateway-control-matrix/).

**Data permissions.** If the operation writes to tables, catalog grants and the engine's access controls decide whether the write is allowed, the same way they govern reads.

**Business systems.** For operations in systems such as an HR platform, that system's own authorization and approval workflows apply.

The Ossie definition helps each of these layers in a different way. A gateway can use the action's name and target entity to write policy in business terms: "agents acting for HR partners can call RecordEmployeeExit." A tool can use the declared criterion as a specification of the check it must perform. An auditor can see in the ontology graph every operation that touches Employee and compare that list against what the gateway allows. This layering follows the pattern described in [Anatomy of an Agentic Lakehouse](https://datalakehousehub.com/blog/anatomy-agentic-lakehouse-four-layers/).

## How an agent uses an action definition

It helps to follow one request through the layers, assuming the design from the thread lands. An HR partner asks an agent to record that an employee left the company last Friday.

1. **The agent reads the ontology.** It finds Employee, and beside it the action `RecordEmployeeExit`, which acts on Employee, takes an employee ID, an exit date, and a regrettable flag, and requires that the employee is active.
2. **The agent checks the criterion in plain terms.** It queries the semantic model to confirm the employee's status is active. If not, it tells the user instead of trying the operation.
3. **The agent finds the binding for its platform.** The platform's action binding points at the callable that performs the operation, here an MCP tool exposed by the HR integration.
4. **The gateway decides.** The agent calls the tool through the gateway. The gateway checks that this agent, acting for this HR partner, is allowed to call that tool, and logs the request with both identities.
5. **The tool enforces.** The tool validates the arguments, checks the criterion itself against the source system, and performs the update. The HR system applies its own rules and approvals.
6. **The effects show up as data.** The employee's status changes and an exit event appears. The semantic model reads both, so attrition metrics reflect the change once the data lands in the lakehouse.

Notice which steps the ontology made easier. It told the agent which operation to use, what inputs it needs, and what must be true first. It gave the gateway a business-level name to write policy against. It told auditors which effects to expect. It did not run anything, and no permission came from it.

## Arguments against putting actions in a semantic standard

The thread surfaced real objections, and they deserve a fair hearing.

**Scope creep.** Yufei's concern stands even with the boundary. Once a standard names operations, pressure builds to describe their approvals, their sequencing, and their policies. Each addition is reasonable alone, and together they turn a semantic standard into a workflow spec. The describe-not-execute rule only holds if maintainers enforce it in review.

**Interoperability is thinner than it looks.** Two platforms can agree on the name `RecordEmployeeExit` and still disagree on what it does. One sends a notification and the other does not. One accepts a backdated exit and the other refuses. The shared definition carries the parts both agree on. The differences live in bindings, which are platform-specific. A consumer that assumes the same behavior because the name matches is making the same mistake as a consumer that assumes the same join type because the relationship matches.

**Distance from the data plane.** Matthew's point shows a real mismatch. Semantic layers know about data. Many business operations happen in systems that hold no analytic data. Putting those operations in a semantic standard ties the standard to systems its implementers do not control.

**A false sense of safety.** A list of recognized operations in a governed ontology looks like a control. It is not one. If teams treat "the action is in the ontology" as "the agent is allowed to do it," they skip the enforcement layers that matter. The spec's explicit statement that a binding is not a permission is the defense, and it needs to be prominent.

These objections do not defeat the proposal. They argue for keeping it experimental, small, and clearly labeled, which is where the thread ended up.

## Questions for data leaders

Most data leaders will not write Ossie action definitions themselves. They will decide whether their organization lets agents act at all, and under what conditions. These questions help frame that decision, with or without a standard.

**Which operations should agents perform, and which should they only recommend?** Many teams start with agents that propose an action and a person who approves it. Recording that split per operation is a governance decision, not a technical one.

**Who owns each operation's definition?** The Ossie proposal assigns the business statement to a domain steward and the callable to an implementation owner. If your organization has no domain stewards, someone has to play that role before agents act on that domain.

**Where is the audit trail?** Every agent action needs a record of the agent, the user it acted for, the operation, the inputs, and the result. Decide whether that record lives in the gateway, the tool, the business system, or all three, and how the pieces connect.

**How fast can you remove an operation?** If an agent misuses a tool, you need to cut it off in minutes. A gateway policy change is fast. A code change to remove a tool from an agent's configuration is slower. Know which lever you will pull.

**What does the semantic layer need to know?** If an operation changes data the semantic model reads, decide how quickly those changes need to appear in metrics, and who checks that they did.

## What to model now and what to wait on

The proposals are experimental, and no spec text exists yet. Here is what is safe to do today.

**Inventory your write paths.** For each business entity your agents can touch, list every tool, API, procedure, and script that changes it. Most organizations find more paths than they expected. That inventory is valuable whether or not Ossie adds actions.

**Name the recognized operation.** For each common business operation, decide which path is the sanctioned one. Write it down next to your semantic model, even if only in documentation.

**Expose only recognized operations to agents.** If an agent can reach three tools that change employee status, remove two of them from the agent's tool list. The gateway is the place to enforce that.

**Write criteria as checks in the tool.** Whatever a future Ossie criterion says, the tool that performs the operation has to check it. Put the check in code now.

**Wait on encoding.** Do not invent your own action schema inside your semantic model files yet. The thread already changed the shape once, moving bindings out of the ontology and parameters onto concepts. Encode actions in Ossie when the working group produces a draft that the dev list accepts.

**Join the discussion if you have a use case.** JB's request for concrete interoperability scenarios is an open invitation. A real scenario from your organization, with two platforms and one operation, is the most useful input the working group can get.

## Where this is heading

Bei's working group has a channel and a document. Purvaja is bringing her proposal into that document to reconcile the two. JB has asked that decisions happen on the dev list. The shape that emerged from the November 4 to 5 thread is likely to anchor the working group's draft: actions beside concepts, parameters typed by concepts, criteria in the ontology's expression language, effects referencing relationships, kinds borrowed from schema.org, and bindings next to mappings.

Two signals will show whether the boundary holds. First, whether the draft keeps policies, approvals, and workflows out, as JB, Yufei, and Piotr argued. Second, whether it answers Matthew's question about layers, by saying clearly whether actions cover write-back to the data plane, external operations, or both.

The semantic layer is becoming the place where agents learn what a business is. Adding what the business can do is a natural next step, as long as the standard describes the operation and leaves the doing to systems built for it.

## Conclusion

Agents read semantic models to understand data, and then they want to act. Two November proposals ask Apache Ossie to describe those actions: Purvaja Narayanaswamy's Action concept and a broader document from Google and RelationalAI with a new working group. The community drew a firm line. Ossie describes an operation. It never executes, authorizes, or orchestrates it.

Within that line, the design is taking a clean shape. Shared definitions carry the operation's name, target entity, typed parameters, criteria, and effects. Platform-specific bindings tie each definition to a real callable. Enforcement stays with MCP tools, gateways, catalog permissions, and business systems. Until a draft lands, inventory your write paths, pick the recognized operation for each, expose only those to agents, and put the checks in the tools that run them.

## Keep Going

If this piece was useful, I have written a lot more on semantic layers and governed agent access. My books cover lakehouse architecture, semantic modeling, and how agents should reach data and operations through open standards such as Apache Ossie, Apache Iceberg, and MCP. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
