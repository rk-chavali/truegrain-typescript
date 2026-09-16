/**
 * HTTP client for the truegrain engine.
 *
 * Deliberately dependency-free. It uses only `fetch`, which is built into Node
 * 18 and later and every browser, so installing it into an application cannot
 * conflict with anything already there.
 *
 * There is no method that sends SQL, because there is no endpoint that accepts
 * it. The only expressible request is a semantic one.
 */

import { Refused, TransportError, TruegrainError, Unauthorized } from "./errors.js";
import type { Filter } from "./filters.js";
import {
  jobIsDone,
  parseCompiled,
  parseDimension,
  parseHealth,
  parseJob,
  parseMetric,
  parseNamespace,
  parseResult,
  type Cell,
  type Compiled,
  type Dimension,
  type Health,
  type Job,
  type Metric,
  type Namespace,
  type Result,
} from "./models.js";

/**
 * Maps each OpenAPI operationId to the method that implements it.
 *
 * `test/covers-spec.test.ts` asserts this covers every operation in
 * `spec/openapi.yaml`, so an endpoint the engine gains cannot quietly go
 * unsupported here.
 */
export const OPERATIONS: Readonly<Record<string, string>> = Object.freeze({
  getHealth: "health",
  getModelVersion: "modelVersion",
  listNamespaces: "namespaces",
  listMetrics: "metrics",
  describeMetric: "metric",
  listDimensions: "dimensions",
  query: "query",
  compile: "compile",
  submitJob: "submit",
  getJob: "job",
  cancelJob: "cancelJob",
});

export const DEFAULT_TIMEOUT_MS = 60_000;

/** Options for the {@link Client} constructor. */
export interface ClientOptions {
  /**
   * Bearer token identifying the workload. Read it from the environment; never
   * hard-code one. Omit it only against a local engine running without
   * authentication.
   */
  token?: string;
  /** Milliseconds to wait for a response. */
  timeoutMs?: number;
  /**
   * Overrides the identifying header, which is useful when you want the audit
   * log to distinguish one agent from another.
   */
  userAgent?: string;
  /** Injected for tests, and for a runtime whose global fetch you must wrap. */
  fetch?: typeof globalThis.fetch;
}

/**
 * A semantic question.
 *
 * The same shape serves {@link Client.query}, {@link Client.compile},
 * {@link Client.submit} and {@link Client.run}. There is no field for SQL, by
 * design.
 */
export interface QueryRequest {
  /**
   * Metric names. Metrics at different grains, or in different namespaces, are
   * aggregated separately and joined on the shared dimensions.
   */
  metrics: string[];
  /** `dataset.field` or `namespace.dataset.field`. */
  dimensions?: string[];
  /**
   * Structured predicates, never SQL text. Build them with the
   * {@link filters} helpers.
   */
  filters?: Filter[];
  /** Time bucket for the selected time dimension. */
  grain?: string;
  /** Maximum rows. Defaults to the server's limit. */
  limit?: number;
  /** Sort keys applied to the result. */
  orderBy?: Array<{
    /** A metric or dimension name from the same request. */
    field: string;
    /** Sort descending. */
    desc?: boolean;
  }>;
}

/** A {@link QueryRequest}, plus how long to wait and how to page. */
export interface RunOptions extends QueryRequest {
  /**
   * Milliseconds to wait before giving up. On expiry the job is cancelled
   * rather than left running, so an abandoned wait does not keep spending
   * warehouse time.
   */
  maxWaitMs?: number;
  /** Rows per page while collecting. Lower it when rows are wide. */
  pageSize?: number;
}

/** A connection to one truegrain engine. */
export class Client {
  /** Where the engine is served, without a trailing slash. */
  readonly baseUrl: string;
  /** Milliseconds any single call waits before giving up. */
  readonly timeoutMs: number;
  /** Sent on every request. The engine's audit log records it. */
  readonly userAgent: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(baseUrl: string, options: ClientOptions = {}) {
    if (!baseUrl) throw new TypeError("baseUrl is required");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? "truegrain-typescript/0.1";

    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new TruegrainError(
        "no fetch available; use Node 18 or later, or pass one as options.fetch",
      );
    }
    // Bound to globalThis. A browser's fetch refuses to run detached from its
    // window and throws "Illegal invocation", so storing the bare reference
    // works under Node and breaks in every browser. An injected fetch is bound
    // too, which costs nothing and spares a caller from having to know this.
    this.#fetch = f.bind(globalThis);
  }

  /**
   * Build a client from environment variables.
   *
   * Keeps the token out of source and out of the process list, which is where
   * a token passed as a command-line flag ends up.
   */
  static fromEnv(
    urlVar = "SEMANTIC_URL",
    tokenVar = "SEMANTIC_TOKEN",
    options: ClientOptions = {},
  ): Client {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const url = env[urlVar];
    if (!url) throw new TruegrainError(`${urlVar} is not set`);
    const token = env[tokenVar];
    return new Client(url, token ? { ...options, token } : options);
  }

  // ---------- metadata ----------

  /**
   * What this deployment enforces, including what it does not.
   *
   * Worth reading before trusting the layer with anything sensitive:
   * `enforcementNotes` states the gaps in plain language.
   */
  async health(): Promise<Health> {
    return parseHealth(await this.#get("/v1/health"));
  }

  /**
   * The workspace digest currently served.
   *
   * Every query result carries this too. Two results with the same digest were
   * produced by exactly the same definitions.
   */
  async modelVersion(): Promise<string> {
    const body = await this.#get("/v1/model/version");
    return typeof body.model_version === "string" ? body.model_version : "";
  }

  /** The namespaces in the workspace, their owners and availability. */
  async namespaces(): Promise<Namespace[]> {
    const body = await this.#get("/v1/namespaces");
    return asArray(body.namespaces).map(parseNamespace);
  }

  /** Every metric this identity may read. */
  async metrics(search?: string): Promise<Metric[]> {
    const body = await this.#get("/v1/metrics", search ? { search } : undefined);
    return asArray(body.metrics).map(parseMetric);
  }

  /**
   * One metric's definition and the dimensions legal for it.
   *
   * @param name Qualified as `namespace.metric`, or bare when unambiguous.
   */
  async metric(name: string): Promise<Metric> {
    if (!name) throw new TypeError("metric name is required");
    return parseMetric(await this.#get(`/v1/metrics/${encodeURIComponent(name)}`));
  }

  /**
   * Dimensions available for grouping and filtering.
   *
   * @param metric Restrict to dimensions valid for this metric, which is almost
   * always what you want.
   */
  async dimensions(metric?: string): Promise<Dimension[]> {
    const body = await this.#get("/v1/dimensions", metric ? { metric } : undefined);
    return asArray(body.dimensions).map(parseDimension);
  }

  // ---------- query ----------

  /**
   * Answer a question and return rows.
   *
   * Use {@link run} instead when the warehouse might be slow: this call holds
   * the connection open for the whole query.
   *
   * @throws {Refused} The engine declined. Check `err.retry` before retrying.
   */
  async query(request: QueryRequest): Promise<Result> {
    return parseResult(await this.#post("/v1/query", body(request)));
  }

  /**
   * Return the SQL a request compiles to, without running it.
   *
   * A dry run is still governed: a request you may not run returns a refusal
   * and no SQL, and the inspection is audited. It is a way to see what a query
   * would do, not a way around the gate.
   */
  async compile(request: QueryRequest): Promise<Compiled> {
    return parseCompiled(await this.#post("/v1/compile", body(request)));
  }

  // ---------- asynchronous execution ----------

  /**
   * Run a query that may take longer than an HTTP request should.
   *
   * Submits the query, polls until it finishes, collects every page and returns
   * one result. A large BigQuery scan routinely outlives the default timeout of
   * an agent framework, and a synchronous call that times out leaves the query
   * running and billable with nobody reading it.
   *
   * The governance gate runs during submission, so a request this identity may
   * not make throws immediately rather than after a wait.
   */
  async run(options: RunOptions): Promise<Result> {
    const { maxWaitMs = 900_000, pageSize, ...request } = options;
    const submitted = await this.submit(request);
    // Built conditionally rather than passing undefined: exactOptionalPropertyTypes
    // distinguishes "absent" from "present and undefined", and so does the server.
    const paging = pageSize !== undefined ? { pageSize } : {};
    const finished = await this.wait(submitted.jobId, { maxWaitMs, ...paging });
    raiseForState(finished);

    // Walk the remaining pages. rowCount is the size of the whole result, so it
    // bounds the walk without the loop having to trust the cursor to eventually
    // come back empty.
    const rows: Cell[][] = [...finished.rows];
    let cursor = finished.nextCursor;
    const total = finished.rowCount || undefined;
    while (cursor && (total === undefined || rows.length < total)) {
      const page = await this.job(finished.jobId, { cursor, ...paging });
      if (page.rows.length === 0) break;
      rows.push(...page.rows);
      cursor = page.nextCursor;
    }
    return parseResult(finished.raw, rows);
  }

  /**
   * Start a query in the background and return immediately.
   *
   * The returned job already carries `compiledSql`, because compilation happened
   * synchronously. A job coming back at all means the query was authorized, not
   * merely accepted.
   *
   * Prefer {@link run} unless you need to do something else while it runs.
   */
  async submit(request: QueryRequest): Promise<Job> {
    return parseJob(await this.#post("/v1/jobs", body(request)));
  }

  /** Poll a job and read one page of its rows. */
  async job(jobId: string, options: { cursor?: string; pageSize?: number } = {}): Promise<Job> {
    if (!jobId) throw new TypeError("jobId is required");
    const params: Record<string, string> = {};
    if (options.cursor) params.cursor = options.cursor;
    if (options.pageSize !== undefined) params.page_size = String(options.pageSize);
    return parseJob(await this.#get(`/v1/jobs/${encodeURIComponent(jobId)}`, params));
  }

  /** Stop a running query. Idempotent. */
  async cancelJob(jobId: string): Promise<Job> {
    if (!jobId) throw new TypeError("jobId is required");
    return parseJob(await this.#send(`/v1/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }));
  }

  /**
   * Poll until a job reaches a terminal state.
   *
   * Backs off from a fast first poll to a two second ceiling, so a query that
   * finishes quickly is not delayed and a slow one is not hammered.
   *
   * On expiry the job is cancelled before throwing, so giving up here also
   * stops the warehouse work.
   */
  async wait(
    jobId: string,
    options: { maxWaitMs?: number; pageSize?: number } = {},
  ): Promise<Job> {
    const maxWaitMs = options.maxWaitMs ?? 900_000;
    const deadline = Date.now() + maxWaitMs;
    let intervalMs = 250;

    for (;;) {
      const current = await this.job(jobId, options.pageSize !== undefined ? { pageSize: options.pageSize } : {});
      if (jobIsDone(current)) return current;

      if (Date.now() >= deadline) {
        // Leaving it running would keep spending warehouse time for an answer
        // this caller has already stopped waiting for.
        try {
          await this.cancelJob(jobId);
        } catch {
          // The job may already have finished or expired; the wait failing is
          // what the caller needs to hear about, not the cleanup.
        }
        throw new TruegrainError(
          `job ${jobId} did not finish within ${maxWaitMs}ms and was cancelled`,
        );
      }

      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
      intervalMs = Math.min(intervalMs * 1.5, 2000);
    }
  }

  // ---------- internals ----------

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    return headers;
  }

  async #get(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
    let url = path;
    if (params && Object.keys(params).length > 0) {
      url += `?${new URLSearchParams(params).toString()}`;
    }
    return this.#send(url, { method: "GET" });
  }

  async #post(path: string, payload: unknown): Promise<Record<string, unknown>> {
    return this.#send(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async #send(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const url = this.baseUrl + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: { ...this.#headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new TransportError(`${url} did not respond within ${this.timeoutMs}ms`);
      }
      throw new TransportError(`cannot reach ${url}: ${(cause as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    if (response.status === 401) {
      throw new Unauthorized(text.trim() || "credentials were not accepted");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new TransportError(`HTTP ${response.status} from ${url}: ${text.trim() || response.statusText}`);
      }
      throw new TransportError(`HTTP ${response.status} body was not JSON`);
    }

    if (!isObject(payload)) {
      throw new TransportError(`HTTP ${response.status} body was not a JSON object`);
    }

    if (!response.ok) {
      // A refusal arrives as an error status with a JSON body. It is an answer,
      // not a transport failure, so it is thrown as Refused with the code and
      // retry class intact.
      if ("code" in payload) throw Refused.fromPayload(payload, response.status);
      throw new TransportError(`HTTP ${response.status} from ${url}: ${text}`);
    }
    return payload;
  }
}

/**
 * Throw if a job did not succeed.
 *
 * A failure carries the same code, hint and retry class a synchronous refusal
 * would have, so an agent branches on it identically.
 */
function raiseForState(job: Job): void {
  if (job.state === "succeeded" || job.state === "running") return;
  if (job.state === "cancelled") {
    throw new TruegrainError(`job ${job.jobId} was cancelled`);
  }
  throw new Refused({
    code: job.code || "execution_failed",
    reason: job.reason,
    hint: job.hint,
    retry: job.retry || "later",
  });
}

/** Build the wire body, omitting anything absent rather than sending it empty. */
function body(request: QueryRequest): Record<string, unknown> {
  if (!request.metrics || request.metrics.length === 0) {
    throw new TypeError("at least one metric is required");
  }
  const out: Record<string, unknown> = { metrics: request.metrics };
  if (request.dimensions?.length) out.dimensions = request.dimensions;
  if (request.filters?.length) out.filters = request.filters;
  if (request.grain) out.grain = request.grain;
  if (request.limit !== undefined) out.limit = request.limit;
  if (request.orderBy?.length) out.order_by = request.orderBy;
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asArray = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter(isObject) : [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
