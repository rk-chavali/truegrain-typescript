/**
 * Tool definitions for agent frameworks.
 *
 * Most frameworks, whatever else they disagree about, accept a list of function
 * schemas in the shape OpenAI popularised, and call back with a name and an
 * object of arguments. This module produces that list and dispatches those
 * calls, which is enough to wire the engine into the Vercel AI SDK, LangChain
 * JS, Mastra or something hand-rolled, without this library growing an adapter
 * per framework. Adapters age badly; a schema does not.
 *
 * If your client speaks the Model Context Protocol, use the engine's MCP server
 * directly instead. It is the same four tools with the same guarantees.
 */

import type { Client, QueryRequest } from "./client.js";
import { Refused } from "./errors.js";

/**
 * The four tools the engine exposes. There is no fifth, and none of them
 * accepts SQL.
 */
export const TOOL_NAMES = ["list_metrics", "describe_metric", "list_dimensions", "query"] as const;

/** One of {@link TOOL_NAMES}. */
export type ToolName = (typeof TOOL_NAMES)[number];

/** One tool, in the function-schema shape most agent frameworks accept. */
export interface ToolSpec {
  /** Always `"function"`, which is what the frameworks expect. */
  type: "function";
  /** The callable itself. */
  function: {
    /** The name the model calls back with; pass it to {@link dispatch}. */
    name: ToolName;
    /** Written for a model rather than a human: when to use this, and when not to. */
    description: string;
    /** JSON Schema for the arguments. */
    parameters: Record<string, unknown>;
  };
}

const FILTER_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "A structured predicate. This is not SQL and no SQL fragment is accepted.",
  required: ["dimension", "op"],
  properties: {
    dimension: { type: "string", description: "dataset.field or namespace.dataset.field" },
    op: {
      type: "string",
      enum: ["eq", "ne", "in", "not_in", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"],
    },
    values: {
      type: "array",
      description:
        "One value for the comparisons, two for between, one or more for in and not_in, none for the null checks.",
      items: {},
    },
  },
};

/**
 * The engine's tools as OpenAI-style function schemas.
 *
 * The descriptions are written for a model rather than a human: they say when
 * to use a tool and when not to, because that is what decides whether an agent
 * picks the right metric or invents one.
 */
export function toolSpecs(): ToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "list_metrics",
        description:
          "List the metrics this semantic layer can answer, with a plain-language " +
          "description of each. Call this first when you do not already know the " +
          "exact metric name. Do not guess a metric name: a name not in this list " +
          "does not exist and the query will be refused.",
        parameters: {
          type: "object",
          properties: {
            search: { type: "string", description: "Narrow by name, description or synonym." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "describe_metric",
        description:
          "Return one metric's full definition and exactly which dimensions it can " +
          "be grouped by. Call this before query whenever you are unsure a metric " +
          "answers the question asked, or which dimensions are legal for it.",
        parameters: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: "string",
              description: "Qualified as namespace.metric, or bare when unambiguous.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_dimensions",
        description:
          "List the dimensions available for grouping and filtering. Pass a metric " +
          "to get only the dimensions valid for it, which is almost always what you want.",
        parameters: {
          type: "object",
          properties: {
            metric: { type: "string", description: "Restrict to this metric." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "query",
        description:
          "Answer a question by naming metrics, dimensions and filters. This is the " +
          "only way to get numbers, and it is not a SQL interface. The response " +
          "carries the rows, the SQL that was compiled and the model version, so any " +
          "number can be traced back. If a request is refused, read the refusal: it " +
          "says whether to change the request, wait, or stop.",
        parameters: {
          type: "object",
          required: ["metrics"],
          properties: {
            metrics: {
              type: "array",
              items: { type: "string" },
              description: "Metric names from list_metrics.",
            },
            dimensions: {
              type: "array",
              items: { type: "string" },
              description: "Dimension names from list_dimensions.",
            },
            filters: { type: "array", items: FILTER_SCHEMA },
            grain: {
              type: "string",
              enum: ["second", "minute", "hour", "day", "week", "month", "quarter", "year"],
              description: "Time bucket for the selected time dimension.",
            },
            limit: { type: "integer", description: "Maximum rows." },
            order_by: {
              type: "array",
              items: {
                type: "object",
                required: ["field"],
                properties: { field: { type: "string" }, desc: { type: "boolean" } },
              },
            },
          },
        },
      },
    },
  ];
}

/**
 * Run one tool call and return a JSON-serializable result.
 *
 * A refusal is returned rather than thrown, because a framework feeding this
 * back to a model wants the text, not a stack trace. The shape carries the
 * `retry` class so the model learns whether to change the request, wait, or
 * stop, instead of looping on a denial.
 */
export async function dispatch(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  try {
    switch (name) {
      case "list_metrics": {
        const metrics = await client.metrics(asString(args.search));
        return { metrics: metrics.map((m) => m.raw) };
      }
      case "describe_metric": {
        const metricName = asString(args.name);
        if (!metricName) return badArguments("describe_metric needs a `name`");
        return (await client.metric(metricName)).raw;
      }
      case "list_dimensions": {
        const dims = await client.dimensions(asString(args.metric));
        return { dimensions: dims.map((d) => d.raw) };
      }
      case "query": {
        const metrics = Array.isArray(args.metrics) ? (args.metrics as string[]) : [];
        if (metrics.length === 0) return badArguments("query needs at least one metric");
        const request: QueryRequest = { metrics };
        if (Array.isArray(args.dimensions)) request.dimensions = args.dimensions as string[];
        if (Array.isArray(args.filters)) request.filters = args.filters as NonNullable<QueryRequest["filters"]>;
        if (typeof args.grain === "string") request.grain = args.grain;
        if (typeof args.limit === "number") request.limit = args.limit;
        if (Array.isArray(args.order_by)) request.orderBy = args.order_by as NonNullable<QueryRequest["orderBy"]>;
        return (await client.query(request)).raw;
      }
      default:
        return badArguments(`unknown tool "${name}"; expected one of ${TOOL_NAMES.join(", ")}`);
    }
  } catch (error) {
    if (error instanceof Refused) {
      return {
        refused: true,
        code: error.code,
        reason: error.reason,
        hint: error.hint,
        retry: error.retry,
        note: "This is a refusal, not an empty result. Do not report a number for this question.",
      };
    }
    if (error instanceof TypeError) return badArguments(error.message);
    throw error;
  }
}

function badArguments(reason: string): Record<string, unknown> {
  return { refused: true, code: "invalid_arguments", reason, retry: "modify" };
}

const asString = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
