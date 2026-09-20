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

/** One team's independently owned set of definitions. */
export interface Namespace {
  /** The namespace name, which qualifies everything inside it. */
  name: string;
  /** False when the namespace failed to load; see `error`. */
  available: boolean;
  /** How many metrics it defines that this identity may see. */
  metricCount: number;
  /** Identifies this namespace's definitions exactly. */
  digest: string;
  /** Who approves access and answers when a number is disputed. */
  owners: string[];
  /**
   * Present only when the namespace failed to load. An unavailable namespace
   * is reported rather than omitted, so absence is never mistaken for a model
   * that simply had no such metrics.
   */
  error: string;
  /** The unparsed payload, so a new server field is readable without an SDK release. */
  raw: Record<string, unknown>;
}

/** Something the engine can measure. */
export interface Metric {
  /** Qualified as `namespace.metric`. */
  name: string;
  /** The namespace that owns and governs this definition. */
  namespace: string;
  /**
   * The grounding text an agent reads to decide whether this metric answers
   * the question that was asked. It is not decoration.
   */
  description: string;
  /** The logical type of the value, for example Decimal or Integer. */
  datatype: string;
  /** Other names that resolve to this metric, such as "top line". */
  synonyms: string[];
  /** Only the dimensions this identity may group the metric by. */
  dimensions: string[];
  /** The metric's definition. Present on describeMetric, absent on a list. */
  definition?: string;
  /** The unparsed payload, so a new server field is readable without an SDK release. */
  raw: Record<string, unknown>;
}

/** Something a metric can be grouped or filtered by. */
export interface Dimension {
  /** `dataset.field`, or `namespace.dataset.field`. */
  name: string;
  /** The namespace that owns and governs this field. */
  namespace: string;
  /** The logical type of the value. */
  datatype: string;
  /** Whether this dimension accepts a `grain`. */
  isTime: boolean;
  /** What the field means, written for a reader rather than for a schema. */
  description: string;
  /** Other names that resolve to this dimension. */
  synonyms: string[];
  /** Legal time buckets. Present only when isTime. */
  grains: string[];
  /** The unparsed payload, so a new server field is readable without an SDK release. */
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
  /** The namespaces served, as a readable list. */
  workspace: string;
  /** Identifies the exact set of definitions in force. */
  workspaceDigest: string;
  /** The Apache Ossie spec version the models declare. */
  ossieSpecVersion: string;
  /** Each namespace, and whether it loaded. */
  namespaces: Namespace[];
  /** The compilation target, and what it secures by itself. */
  dialect: DialectSecurity;
  /** The policy resolver this engine applies. */
  governance: Governance;
  /** The warehouse driver and its limits, including whether queries run as the caller. */
  executor: string;
  /** How many metrics this identity may see. */
  metricCount: number;
  /** How many dimensions this identity may see. */
  dimensionCount: number;
  /** The operators a {@link Filter} may use. */
  supportedFilterOps: string[];
  /** The legal values for a request's `grain`. */
  supportedGrains: string[];
  /** The gaps, in plain language. Read these. */
  enforcementNotes: string[];
  /**
   * Where the served model came from, or `undefined` when the engine read it
   * from a path. Undefined is the answer to "is this deployment under version
   * control", so check it before reading through it.
   */
  origin?: Origin;
  /** The unparsed payload, so a new server field is readable without an SDK release. */
  raw: Record<string, unknown>;
}

/**
 * The commit a served model came from.
 *
 * How {@link Client.reload} is confirmed. Reload names no commit, because a
 * sync is not instant and reporting one before the swap happened would be a
 * claim a pipeline then asserts as fact. A deploy is finished when
 * {@link Health.origin} reports the commit you merged, and not before.
 *
 * Carries no credential. A repository URL with one in it is refused at
 * startup rather than stored here and redacted on the way out.
 */
export interface Origin {
  /** The clone URL, without credentials. */
  repository: string;
  /** The branch, tag or commit asked for. A ref moves; read `commit`. */
  ref: string;
  /** The revision serving right now. */
  commit: string;
  /** The directory inside the repository holding the workspace. */
  subdirectory: string;
}

/**
 * What the target warehouse enforces by itself, independently of the engine.
 *
 * When both flags are false the engine's own gate is the only control, and it
 * applies only to queries that go through the engine.
 */
export interface DialectSecurity {
  /** The compilation target, for example `bigquery` or `duckdb`. */
  dialect: string;
  /** Whether the warehouse restricts columns itself, such as with policy tags. */
  columnLevelSecurity: boolean;
  /** Whether the warehouse filters rows itself. */
  rowLevelSecurity: boolean;
  /** The limits, in plain language. */
  note: string;
}

/** What the engine's policy resolver enforces. */
export interface Governance {
  /** For example bigquery-policy-tags, file, or allow-all. */
  resolver: string;
  /** False means every caller may read every column. */
  columnLevel: boolean;
  /** The limits, in plain language. */
  note: string;
}

/** The SQL a request compiles to, without having run it. */
export interface Compiled {
  /** The statement the engine would execute. */
  compiledSql: string;
  /** The result columns, in order. */
  columns: string[];
  /** The dialect the statement is written in. */
  dialect: string;
  /** The namespaces the query touched. */
  namespace: string;
  /** The exact set of definitions that produced this. */
  modelVersion: string;
  /** How many facts were aggregated separately and joined. */
  parts: number;
  /** The unparsed payload, so a new server field is readable without an SDK release. */
  raw: Record<string, unknown>;
}

/** Rows, plus the provenance needed to defend the numbers in them. */
export interface Result {
  /** The result columns, in order. Row values line up with these. */
  columns: string[];
  /** The rows, each aligned to `columns`. */
  rows: Cell[][];
  /** How many rows are in `rows`. */
  rowCount: number;
  /**
   * The exact statement executed. Carried on every response on purpose: it is
   * how a disagreement about a number gets settled.
   */
  compiledSql: string;
  /** The exact set of definitions that produced these numbers. */
  modelVersion: string;
  /** The namespaces the query touched. */
  namespace: string;
  /** The dialect the statement was written in. */
  dialect: string;
  /** The unparsed payload, so a new server field is readable without an SDK release. */
  raw: Record<string, unknown>;
  /** Rows as objects keyed by column name. */
  toObjects(): Record<string, Cell>[];
}

/**
 * Where an asynchronous query has got to.
 *
 * `running` is the only non-terminal state, and `cancelled` is distinct from
 * `failed` because the caller stopped it rather than the warehouse failing.
 */
export type JobState = "running" | "succeeded" | "failed" | "cancelled";

/**
 * One asynchronously executing query.
 *
 * `state` is the field to branch on. `running` is the only non-terminal one,
 * and `cancelled` is distinct from `failed` because the caller stopped it
 * rather than the warehouse failing.
 */
export interface Job {
  /** Opaque identifier, 128 bits of randomness. Poll and cancel with it. */
  jobId: string;
  /** Where the query has got to. Branch on this. */
  state: JobState;
  /**
   * Available from the moment of submission: compilation, and therefore the
   * governance gate, runs synchronously before the job exists.
   */
  compiledSql: string;
  /** The result columns, in order. */
  columns: string[];
  /** One page of rows. Use `run()` to collect every page. */
  rows: Cell[][];
  /** Rows in the whole result, not in this page. */
  rowCount: number;
  /** Present when more rows remain. Pass it back as `cursor`. */
  nextCursor: string;
  /** The exact set of definitions that produced this. */
  modelVersion: string;
  /** The namespaces the query touched. */
  namespace: string;
  /** The dialect the statement was written in. */
  dialect: string;
  /** Set only when the job failed. Same vocabulary as a synchronous refusal. */
  code: string;
  /** One sentence stating what went wrong. Set only on failure. */
  reason: string;
  /** What to do instead. Set only on failure. */
  hint: string;
  /** How to treat the failure. Empty unless the job failed. */
  retry: Retry | "";
  /** The unparsed payload, so a new server field is readable without an SDK release. */
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
    ...(p.origin ? { origin: parseOrigin(p.origin as Record<string, unknown>) } : {}),
    raw: p,
  };
}

export function parseOrigin(p: Record<string, unknown>): Origin {
  return {
    repository: str(p.repository),
    ref: str(p.ref),
    commit: str(p.commit),
    subdirectory: str(p.subdirectory),
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

/**
 * One decision the engine recorded.
 *
 * `refused` and `denied` are separate on purpose, and a consumer should keep
 * them separate. Denied is access: this caller may not read a field. Refused is
 * correctness: nobody can be told this accurately, and `hint` names a question
 * that can be answered. Counting them together turns every fan-out into an
 * access incident.
 *
 * Carries no filter values, no SQL text and no result rows, by design. The
 * `sqlHash` identifies the statement without disclosing it.
 */
export interface AuditEvent {
  /** When the decision was made, RFC 3339. */
  time: string;
  /** Who asked. `anonymous` on an engine without authentication. */
  identity: string;
  /** What the engine decided. */
  decision: AuditDecision;
  /** Which refusal, when `decision` is `refused`. */
  code: string;
  /** What the caller should do about a refusal. */
  retry: Retry | "";
  /** The refusal in the engine's own words. */
  reason: string;
  /** What would answer instead. The actionable half. */
  hint: string;
  /** What was asked for. Names only, never values. */
  metrics: string[];
  /** How it was grouped. */
  dimensions: string[];
  /** The workspace namespace the request resolved to. */
  namespace: string;
  /** The workspace digest that answered, tying a number to a model revision. */
  modelVersion: string;
  /** The warehouse this compiled for. */
  dialect: string;
  /** Semantic fields refused, on a denial. Never shown to the denied caller. */
  deniedFields: string[];
  /** Identifies the compiled statement without disclosing it. */
  sqlHash: string;
  /** The warehouse's own identifier, so two logs can be joined. */
  jobId: string;
  /** Rows returned, for a query that ran to completion. */
  rowCount: number;
  /**
   * What the warehouse says the query cost. Zero means not reported rather
   * than free: DuckDB bills nobody and reports nothing, and the two are
   * indistinguishable.
   */
  bytesBilled: number;
  /** Wall clock time of the warehouse round trip. */
  durationMs: number;
  /** The failure, when `decision` is `error`. */
  /** The failure, when `decision` is `error`. */
  error: string;
  /** The event as the engine sent it, for anything not modelled here. */
  raw: Record<string, unknown>;
}

/** What the engine decided. */
export type AuditDecision = "allowed" | "refused" | "denied" | "compiled" | "error";

/** A window of recorded decisions, newest first. */
export interface AuditPage {
  /** The decisions, newest first. */
  events: AuditEvent[];
  /** How many are in this page. */
  count: number;
  /** Says that this is a window rather than the whole record. */
  note: string;
  /** The response as the engine sent it. */
  raw: Record<string, unknown>;
}

export function parseAuditEvent(p: Record<string, unknown>): AuditEvent {
  const retry = p.retry;
  return {
    time: str(p.time),
    identity: str(p.identity) || "anonymous",
    decision: (str(p.decision) || "error") as AuditDecision,
    code: str(p.refusal_code),
    retry: retry === "modify" || retry === "later" || retry === "never" ? retry : "",
    reason: str(p.reason),
    hint: str(p.hint),
    metrics: strs(p.metrics),
    dimensions: strs(p.dimensions),
    namespace: str(p.namespace),
    modelVersion: str(p.model_version),
    dialect: str(p.dialect),
    deniedFields: strs(p.denied_fields),
    sqlHash: str(p.sql_hash),
    jobId: str(p.job_id),
    rowCount: num(p.row_count),
    bytesBilled: num(p.bytes_billed),
    durationMs: num(p.duration_ms),
    error: str(p.error),
    raw: p,
  };
}

export function parseAuditPage(p: Record<string, unknown>): AuditPage {
  const events = Array.isArray(p.events) ? p.events : [];
  return {
    events: events.map((e) => parseAuditEvent(e as Record<string, unknown>)),
    count: num(p.count),
    note: str(p.note),
    raw: p,
  };
}


// ---------- what the engine says about itself ----------

/** One thing the warehouse disagrees with the model about. */
export interface Finding {
  /** `error` breaks a query. `warning` will not break today. */
  severity: string;
  /** What it is about, in model terms. */
  dataset: string;
  field: string;
  /** The physical table, for somebody about to go and look. */
  source: string;
  message: string;
  /** What to do, when there is something to do. */
  hint: string;
}

/**
 * What the warehouse says about the model right now.
 *
 * It reports rather than refuses: a model can be wrong in ways that do not
 * matter yet, and which of those to act on is a person's decision.
 */
export interface Diagnosis {
  /** False when a finding would break a query. Not the same as having none. */
  ok: boolean;
  tablesChecked: number;
  findings: Finding[];
  /**
   * Why nothing was checked, when nothing was. A Diagnosis with no findings
   * and `skipped` set is the engine saying it could not look, not saying
   * everything is fine.
   */
  skipped: string;
  raw: Record<string, unknown>;
}

/** One scheduled check. */
export interface DoctorRun {
  /** RFC 3339. */
  at: string;
  ok: boolean;
  tablesChecked: number;
  findings: number;
  /** Set when the check could not run at all, which is not the same as
   * running and finding something wrong. */
  error: string;
  /** Ties the result to what was being served, so a run from before a reload
   * is not read as evidence about the model after it. */
  modelVersion: string;
}

/** What the scheduled check has seen, oldest first. */
export interface DoctorHistory {
  runs: DoctorRun[];
  /** The configured interval, which is how a reader tells a gap from a check
   * that has simply not come round yet. */
  everySeconds: number;
  /** Runs that completed and found the warehouse changed. */
  drifted: number;
  raw: Record<string, unknown>;
}

/** One assertion and what became of it. */
export interface TestCase {
  name: string;
  passed: boolean;
  skipped: boolean;
  /** Why, for a case that failed or was skipped. */
  reason: string;
  durationMs: number;
}

/**
 * The result of every case in the suite.
 *
 * Read `withheld` as well as `ok`. A credential without `run:query` cannot
 * cause warehouse execution, so cases that would are withheld and counted
 * rather than run or silently dropped, and a caller reading only `ok` would
 * conclude a suite passed when half of it never ran.
 */
export interface TestReport {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  /** Cases this credential may not run. */
  withheld: number;
  results: TestCase[];
  raw: Record<string, unknown>;
}

/** What the engine enforces. Says nothing about who is allowed what. */
export interface Policy {
  governance: Governance;
  /**
   * The gaps in plain language. Read these: an engine running allow-all says
   * so here rather than letting a reader assume a gate exists because the
   * product has one.
   */
  enforcementNotes: string[];
  raw: Record<string, unknown>;
}

/**
 * What the calling identity may read of a metric, and why.
 *
 * For the caller only. An engine that reported what somebody else can see
 * would publish the policy it was configured to enforce, so there is no field
 * here for another identity and no endpoint that takes one.
 */
export interface PolicyExplanation {
  metric: string;
  identity: string;
  /** The dimensions this caller may group the metric by, qualified and sorted. */
  readable: string[];
  governance: Governance;
  raw: Record<string, unknown>;
}

/** What one request compiled to before and after a reload. */
export interface Change {
  before: string;
  after: string;
}

/**
 * What the last reload moved.
 *
 * Compared on compiled SQL rather than on model text, because that is where a
 * silent correctness incident lives: the model still validates, the tests
 * still pass, and every dashboard quietly moves. Renaming a description does
 * not appear here; changing a join, a grain or an expression does.
 */
export interface Diff {
  changed: boolean;
  /** The model versions either side of the reload. */
  from: string;
  to: string;
  added: string[];
  removed: string[];
  /** Request label to its SQL before and after. */
  altered: Record<string, Change>;
  raw: Record<string, unknown>;
}

/** What a {@link Client.reload} was told. */
export type ReloadStatus = "reading" | "already running";

const records = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

export function parseFinding(p: Record<string, unknown>): Finding {
  return {
    severity: str(p.severity),
    dataset: str(p.dataset),
    field: str(p.field),
    source: str(p.source),
    message: str(p.message),
    hint: str(p.hint),
  };
}

export function parseDiagnosis(p: Record<string, unknown>): Diagnosis {
  return {
    ok: bool(p.ok, true),
    tablesChecked: num(p.tables_checked),
    findings: records(p.findings).map(parseFinding),
    skipped: str(p.skipped),
    raw: p,
  };
}

export function parseDoctorHistory(p: Record<string, unknown>): DoctorHistory {
  return {
    runs: records(p.runs).map((r) => ({
      at: str(r.at),
      ok: bool(r.ok, true),
      tablesChecked: num(r.tables_checked),
      findings: num(r.findings),
      error: str(r.error),
      modelVersion: str(r.model_version),
    })),
    everySeconds: num(p.every_seconds),
    drifted: num(p.drifted),
    raw: p,
  };
}

export function parseTestReport(p: Record<string, unknown>): TestReport {
  return {
    ok: bool(p.ok),
    passed: num(p.passed),
    failed: num(p.failed),
    skipped: num(p.skipped),
    withheld: num(p.withheld),
    results: records(p.results).map((r) => ({
      name: str(r.name),
      passed: bool(r.passed),
      skipped: bool(r.skipped),
      reason: str(r.reason),
      durationMs: num(r.duration_ms),
    })),
    raw: p,
  };
}

function governanceOf(v: unknown): Governance {
  const g = (v ?? {}) as Record<string, unknown>;
  return { resolver: str(g.resolver), columnLevel: bool(g.column_level), note: str(g.note) };
}

export function parsePolicy(p: Record<string, unknown>): Policy {
  return {
    governance: governanceOf(p.governance),
    enforcementNotes: strs(p.enforcement_notes),
    raw: p,
  };
}

export function parsePolicyExplanation(p: Record<string, unknown>): PolicyExplanation {
  return {
    metric: str(p.metric),
    identity: str(p.identity),
    readable: strs(p.readable),
    governance: governanceOf(p.governance),
    raw: p,
  };
}

export function parseDiff(p: Record<string, unknown>): Diff {
  const altered: Record<string, Change> = {};
  for (const [label, change] of Object.entries((p.altered ?? {}) as Record<string, unknown>)) {
    const c = (change ?? {}) as Record<string, unknown>;
    altered[label] = { before: str(c.before), after: str(c.after) };
  }
  return {
    changed: bool(p.changed),
    from: str(p.from),
    to: str(p.to),
    added: strs(p.added),
    removed: strs(p.removed),
    altered,
    raw: p,
  };
}
