# truegrain (TypeScript)

The TypeScript client for [truegrain](https://github.com/rk-chavali/truegrain):
governed metrics for agents, notebooks and applications.

There is no method that sends SQL, because there is no endpoint that accepts it.
The only expressible request is a semantic one.

```bash
npm install truegrain
```

No runtime dependencies. It uses only `fetch`, which is built into Node 18 and
later and every browser. That is deliberate: this package goes into
applications where a dependency conflict is a real cost, and thirteen endpoints
do not justify dragging one in. A CI job proves it rather than the README
asserting it.

## Use it

```ts
import { Client, filters } from "truegrain";

const client = Client.fromEnv(); // SEMANTIC_URL, SEMANTIC_TOKEN

for (const metric of await client.metrics("revenue")) {
  console.log(metric.name, "-", metric.description);
}

const result = await client.query({
  metrics: ["sales.order_revenue", "marketing.campaign_spend"],
  dimensions: ["sales.orders.order_date"],
  grain: "month",
  filters: [filters.eq("sales.orders.status", "shipped")],
});

console.table(result.toObjects());
```

Every result carries `compiledSql` and `modelVersion`. That is how a
disagreement about a number gets settled: two results with the same digest were
produced by exactly the same definitions.

## Queries that outlive an HTTP request

A warehouse query can run longer than the default timeout of every agent
framework in use. Synchronously the client gives up, retries, and the warehouse
runs and bills the query twice for an answer nobody reads.

```ts
const result = await client.run({
  metrics: ["sales.order_revenue"],
  dimensions: ["sales.customers.region"],
});
```

`run()` submits, polls with backoff, collects every page and returns one result,
so no caller writes a polling loop. Abandoning the wait cancels the job rather
than leaving the warehouse spending on an answer nobody is waiting for.

## Read the refusal

The engine refuses questions it cannot answer correctly rather than returning a
plausible wrong number. A refusal says what to do about itself, and that is the
field to branch on:

```ts
import { Refused } from "truegrain";

try {
  await client.run({ metrics: ["sales.order_revenue"], dimensions: ["sales.order_lines.item_id"] });
} catch (error) {
  if (error instanceof Refused) {
    if (error.shouldModify) {
      // The question is answerable, just not as written. error.hint names the
      // metrics defined at the grain where it is well defined.
    } else if (error.shouldWait) {
      // Nothing about the request is wrong. Try the same thing shortly.
    } else if (error.isFinal) {
      // A denial. Say so rather than substituting a different metric that
      // answers a different question.
    }
  }
}
```

That distinction is the difference between a self-correcting agent loop and an
infinite one.

## Agents

```ts
import { tools } from "truegrain";

const specs = tools.toolSpecs();                       // hand to the framework
const out = await tools.dispatch(client, "query", args); // and call back here
```

Four tools, in the shape most frameworks accept. `dispatch` returns a refusal
rather than throwing, because a framework feeding the result back to a model
wants the text, not a stack trace, and the `retry` class teaches the model
whether to change the request, wait, or stop.

If your client speaks the Model Context Protocol, use the engine's MCP server
directly instead. It is the same four tools with the same guarantees.

## How this stays in step with the engine

The engine's OpenAPI contract is vendored at `spec/openapi.yaml`, pinned to an
engine commit in `spec/PINNED_AT`.

`test/covers-spec.test.ts` checks this client against it in both directions: an
operation the engine exposes with no method here fails the build, and a method
claiming an operation the spec does not define fails it too. A scheduled job
compares the pin against the engine daily and opens a pull request when the
contract moves, so a change arrives as a reviewable diff with the contract tests
already run against it.

The client is hand-written rather than generated. A generator produces a
transport and a flat error type; the parts worth having are the ones it cannot
produce, namely the refusal semantics above and a `run()` that submits a job and
polls it.

## Licence

Apache 2.0, matching the engine.
