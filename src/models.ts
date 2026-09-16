/**
 * Types for the engine's responses.
 *
 * Every model keeps the raw payload alongside the parsed fields. The engine is
 * a young project and the spec will gain fields; a caller should never have to
 * wait for an SDK release to read one.
 */

import type { Retry } from "./errors.js";

/** A value the engine can return in a result cell. */
export type Cell = string | number | boolean | null;

export interface Namespace {
  name: string;
  available: boolean;
  metricCount: number;
  digest: string;
  owners: string[];
  /**
   * Present only when the namespace failed to load. An unavailable namespace
   * is reported rather than omitted, so absence is never mistaken for a model
   * that simply had no such metrics.
   */
  error: string;
  raw: Record<string, unknown>;
}

export interface Metric {
  name: string;
  namespace: string;
  description: string;
  datatype: string;
  synonyms: string[];
  /** Only the dimensions this identity may group the metric by. */
  dimensions: string[];
  /** The metric's definition. Present on describeMetric, absent on a list. */
  definition?: string;
  raw: Record<string, unknown>;
}

export interface Dimension {
  name: string;
  namespace: string;
  datatype: string;
  isTime: boolean;
  description: string;
  synonyms: string[];
  /** Legal time buckets. Present only when isTime. */
  grains: string[];
  raw: Record<string, unknown>;
}

/**
 * What a deployment enforces, including what it does not.
 *
 * Two separate things are reported and they are not the same: `governance`
 * says what the engine enforces before it emits SQL, and `dialect` says what
 * the warehouse enforces on its own. A caller with direct warehouse
 * credentials is subject only to the second.
 */
export interface Health {
  workspace: string;
  /** Identifies the exact set of definitions in force. */
  workspaceDigest: string;
  ossieSpecVersion: string;
  namespaces: Namespace[];
  /** The compilation target, and what it secures by itself. */
  dialect: DialectSecurity;
  /** The policy resolver this engine applies. */
  governance: Governance;
  /** The warehouse driver and its limits, including whether queries run as the caller. */
  executor: string;
  metricCount: number;
  dimensionCount: number;
  supportedFilterOps: string[];
  supportedGrains: string[];
  /** The gaps, in plain language. Read these. */
  enforcementNotes: string[];
  raw: Record<string, unknown>;
}

/**
 * What the target warehouse enforces by itself, independently of the engine.
 *
 * When both flags are false the engine's own gate is the only control, and it
 * applies only to queries that go through the engine.
 */
export interface DialectSecurity {
  dialect: string;
  columnLevelSecurity: boolean;
  rowLevelSecurity: boolean;
  note: string;
}

/** What the engine's policy resolver enforces. */
export interface Governance {
  /** For example bigquery-policy-tags, file, or allow-all. */
  resolver: string;
  /** False means every caller may read every column. */
  columnLevel: boolean;
  note: string;
}

export interface Compiled {
  compiledSql: string;
  columns: string[];
  dialect: string;
  namespace: string;
  modelVersion: string;
  /** How many facts were aggregated separately and joined. */
  parts: number;
  raw: Record<string, unknown>;
}

/** Rows, plus the provenance needed to defend the numbers in them. */
export interface Result {
  columns: string[];
  rows: Cell[][];
  rowCount: number;
  /**
   * The exact statement executed. Carried on every response on purpose: it is
   * how a disagreement about a number gets settled.
   */
  compiledSql: string;
  modelVersion: string;
  namespace: string;
  dialect: string;
  raw: Record<string, unknown>;
  /** Rows as objects keyed by column name. */
  toObjects(): Record<string, Cell>[];
}

export type JobState = "running" | "succeeded" | "failed" | "cancelled";

/**
 * One asynchronously executing query.
 *
 * `state` is the field to branch on. `running` is the only non-terminal one,
 * and `cancelled` is distinct from `failed` because the caller stopped it
 * rather than the warehouse failing.
 */
export interface Job {
  jobId: string;
  state: JobState;
  /**
   * Available from the moment of submission: compilation, and therefore the
   * governance gate, runs synchronously before the job exists.
   */
  compiledSql: string;
  columns: string[];
  /** One page of rows. Use `run()` to collect every page. */
  rows: Cell[][];
  /** Rows in the whole result, not in this page. */
  rowCount: number;
  /** Present when more rows remain. Pass it back as `cursor`. */
  nextCursor: string;
  modelVersion: string;
  namespace: string;
  dialect: string;
  /** Set only when the job failed. Same vocabulary as a synchronous refusal. */
  code: string;
  reason: string;
  hint: string;
  retry: Retry | "";
  raw: Record<string, unknown>;
}

// ---------- parsing ----------

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
const bool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const cells = (v: unknown): Cell[][] => (Array.isArray(v) ? (v as Cell[][]) : []);

export function parseNamespace(p: Record<string, unknown>): Namespace {
  return {
    name: str(p.name),
    available: bool(p.available),
    metricCount: num(p.metric_count),
    digest: str(p.digest),
    owners: strs(p.owners),
    error: str(p.error),
    raw: p,
  };
}

export function parseMetric(p: Record<string, unknown>): Metric {
  const metric: Metric = {
    name: str(p.name),
    namespace: str(p.namespace),
    description: str(p.description),
    datatype: str(p.datatype),
    synonyms: strs(p.synonyms),
    dimensions: parseDimensionNames(p.dimensions),
    raw: p,
  };
  if (typeof p.definition === "string") metric.definition = p.definition;
  return metric;
}

/**
 * Dimensions arrive as bare names from `listMetrics` and as objects from
 * `describeMetric`. Both are normalised to names here so a caller does not
 * have to know which call produced the metric.
 */
function parseDimensionNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((d) => (typeof d === "string" ? d : typeof d === "object" && d !== null ? str((d as Record<string, unknown>).name) : ""))
    .filter(Boolean);
}

export function parseDimension(p: Record<string, unknown>): Dimension {
  return {
    name: str(p.name),
    namespace: str(p.namespace),
    datatype: str(p.datatype),
    isTime: bool(p.is_time),
    description: str(p.description),
    synonyms: strs(p.synonyms),
    grains: strs(p.grains),
    raw: p,
  };
}

export function parseHealth(p: Record<string, unknown>): Health {
  const dialect = (p.dialect ?? {}) as Record<string, unknown>;
  const governance = (p.governance ?? {}) as Record<string, unknown>;
  return {
    workspace: str(p.workspace),
    workspaceDigest: str(p.workspace_digest),
    ossieSpecVersion: str(p.ossie_spec_version),
    namespaces: Array.isArray(p.namespaces)
      ? (p.namespaces as Record<string, unknown>[]).map(parseNamespace)
      : [],
    dialect: {
      dialect: str(dialect.dialect),
      columnLevelSecurity: bool(dialect.column_level_security),
      rowLevelSecurity: bool(dialect.row_level_security),
      note: str(dialect.note),
    },
    governance: {
      resolver: str(governance.resolver),
      columnLevel: bool(governance.column_level),
      note: str(governance.note),
    },
    executor: str(p.executor),
    metricCount: num(p.metric_count),
    dimensionCount: num(p.dimension_count),
    supportedFilterOps: strs(p.supported_filter_ops),
    supportedGrains: strs(p.supported_grains),
    enforcementNotes: strs(p.enforcement_notes),
    raw: p,
  };
}

export function parseCompiled(p: Record<string, unknown>): Compiled {
  return {
    compiledSql: str(p.compiled_sql),
    columns: strs(p.columns),
    dialect: str(p.dialect),
    namespace: str(p.namespace),
    modelVersion: str(p.model_version),
    parts: num(p.parts),
    raw: p,
  };
}

export function parseResult(p: Record<string, unknown>, rowsOverride?: Cell[][]): Result {
  const columns = strs(p.columns);
  const rows = rowsOverride ?? cells(p.rows);
  return {
    columns,
    rows,
    rowCount: rows.length,
    compiledSql: str(p.compiled_sql),
    modelVersion: str(p.model_version),
    namespace: str(p.namespace),
    dialect: str(p.dialect),
    raw: p,
    toObjects() {
      return rows.map((row) => {
        const out: Record<string, Cell> = {};
        columns.forEach((c, i) => {
          out[c] = row[i] ?? null;
        });
        return out;
      });
    },
  };
}

export function parseJob(p: Record<string, unknown>): Job {
  const retry = p.retry;
  return {
    jobId: str(p.job_id),
    state: (str(p.state) || "running") as JobState,
    compiledSql: str(p.compiled_sql),
    columns: strs(p.columns),
    rows: cells(p.rows),
    rowCount: num(p.row_count),
    nextCursor: str(p.next_cursor),
    modelVersion: str(p.model_version),
    namespace: str(p.namespace),
    dialect: str(p.dialect),
    code: str(p.code),
    reason: str(p.reason),
    hint: str(p.hint),
    retry: retry === "modify" || retry === "later" || retry === "never" ? retry : "",
    raw: p,
  };
}

export function jobIsDone(job: Job): boolean {
  return job.state === "succeeded" || job.state === "failed" || job.state === "cancelled";
}
