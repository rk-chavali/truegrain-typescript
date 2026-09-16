/**
 * Errors this client raises.
 *
 * A refusal is not an exception in the usual sense. The engine understood the
 * request and declined it, and it said what to do about that. The distinction
 * matters most to an agent: the difference between "change the arguments" and
 * "stop" is the difference between a self-correcting loop and an infinite one.
 */

/** What a caller should do about a refusal. */
export type Retry = "modify" | "later" | "never";

/** Base class, so a caller can catch everything this library throws. */
export class TruegrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Without this, `instanceof` fails for anything compiled down to ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The engine could not be reached, or answered with something unparseable.
 *
 * A network or deployment problem, never a statement about the request.
 * Retrying the same request is reasonable.
 */
export class TransportError extends TruegrainError {}

/** Credentials are missing or were not recognised. */
export class Unauthorized extends TruegrainError {}

/** The engine declined the request and said why. */
export class Refused extends TruegrainError {
  /** Machine-readable reason. Branch on this, never on the text. */
  readonly code: string;
  /** One sentence stating what was wrong. */
  readonly reason: string;
  /**
   * What to do instead. For a fan-out refusal this names the metrics defined
   * at the grain where the question is well defined.
   */
  readonly hint: string;
  /**
   * How to treat this refusal. Prefer {@link Refused.shouldModify},
   * {@link Refused.shouldWait} and {@link Refused.isFinal} to comparing it.
   */
  readonly retry: Retry;
  /** The HTTP status that carried the refusal. 0 when it came from a job. */
  readonly status: number;

  constructor(init: {
    code: string;
    reason: string;
    hint?: string;
    retry?: Retry;
    status?: number;
  }) {
    const hint = init.hint ?? "";
    const retry = init.retry ?? "never";
    let text = `${init.code}: ${init.reason}`;
    if (hint) text += `\n  hint: ${hint}`;
    text += `\n  retry: ${retry}`;
    super(text);

    this.code = init.code;
    this.reason = init.reason;
    this.hint = hint;
    this.retry = retry;
    this.status = init.status ?? 0;
  }

  /**
   * Build a refusal from an engine error body.
   *
   * Unrecognised values fall back to `never`, which stops a caller rather than
   * inviting it to loop on something this client did not understand.
   */
  static fromPayload(payload: Record<string, unknown>, status: number): Refused {
    return new Refused({
      code: typeof payload.code === "string" ? payload.code : "unknown",
      reason: typeof payload.reason === "string" ? payload.reason : "",
      hint: typeof payload.hint === "string" ? payload.hint : "",
      retry: isRetry(payload.retry) ? payload.retry : "never",
      status,
    });
  }

  /**
   * The request is answerable, but not as written.
   *
   * Change the arguments and try again. Repeating it unchanged will not work.
   * The hint usually names what to change.
   */
  get shouldModify(): boolean {
    return this.retry === "modify";
  }

  /**
   * Nothing about the request is wrong.
   *
   * Something outside it failed, such as the policy source being unreachable,
   * or this caller is at their concurrency limit. The same request may succeed
   * shortly.
   */
  get shouldWait(): boolean {
    return this.retry === "later";
  }

  /**
   * No version of this request from this caller will succeed.
   *
   * Usually a denial. Say so rather than substituting a different metric that
   * answers a different question.
   */
  get isFinal(): boolean {
    return this.retry === "never";
  }
}

function isRetry(value: unknown): value is Retry {
  return value === "modify" || value === "later" || value === "never";
}
