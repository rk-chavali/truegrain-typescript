/**
 * TypeScript client for truegrain.
 *
 * https://github.com/rk-chavali/truegrain
 */

export { Client, OPERATIONS, DEFAULT_TIMEOUT_MS } from "./client.js";
export type { ClientOptions, QueryRequest, RunOptions } from "./client.js";

export { Refused, TransportError, TruegrainError, Unauthorized } from "./errors.js";
export type { Retry } from "./errors.js";

export * as filters from "./filters.js";
export type { Filter, FilterOp, FilterValue } from "./filters.js";

export * as tools from "./tools.js";
export type { ToolName, ToolSpec } from "./tools.js";

export type {
  Cell,
  Compiled,
  Dimension,
  Health,
  Job,
  JobState,
  Metric,
  Namespace,
  Result,
} from "./models.js";

export const VERSION = "0.1.0";
