/**
 * Constructors for structured filters.
 *
 * A filter is never a SQL fragment. That is what keeps an ungoverned predicate
 * inexpressible, and it is the reason these are small functions rather than a
 * string builder.
 *
 * Using them instead of hand-written objects catches a misspelled operator at
 * the call site rather than as a refusal from the server.
 */

export type FilterOp =
  | "eq"
  | "ne"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "is_null"
  | "is_not_null";

export type FilterValue = string | number | boolean | null;

export interface Filter {
  dimension: string;
  op: FilterOp;
  values?: FilterValue[];
}

function build(dimension: string, op: FilterOp, ...values: FilterValue[]): Filter {
  const filter: Filter = { dimension, op };
  // Omitted rather than sent empty: the server rejects unknown and malformed
  // fields, and an empty list is not the same as absent.
  if (values.length > 0) filter.values = values;
  return filter;
}

/** `dimension = value` */
export const eq = (dimension: string, value: FilterValue): Filter => build(dimension, "eq", value);

/** `dimension <> value` */
export const ne = (dimension: string, value: FilterValue): Filter => build(dimension, "ne", value);

/** `dimension IN (...)` */
export function isIn(dimension: string, ...values: FilterValue[]): Filter {
  if (values.length === 0) throw new TypeError("isIn needs at least one value");
  return build(dimension, "in", ...values);
}

/** `dimension NOT IN (...)` */
export function notIn(dimension: string, ...values: FilterValue[]): Filter {
  if (values.length === 0) throw new TypeError("notIn needs at least one value");
  return build(dimension, "not_in", ...values);
}

/** `dimension > value` */
export const gt = (dimension: string, value: FilterValue): Filter => build(dimension, "gt", value);

/** `dimension >= value` */
export const gte = (dimension: string, value: FilterValue): Filter => build(dimension, "gte", value);

/** `dimension < value` */
export const lt = (dimension: string, value: FilterValue): Filter => build(dimension, "lt", value);

/** `dimension <= value` */
export const lte = (dimension: string, value: FilterValue): Filter => build(dimension, "lte", value);

/**
 * `dimension BETWEEN low AND high`
 *
 * The engine refuses a reversed range rather than matching no rows, because an
 * empty result that looks like a real answer is worse than an error.
 */
export const between = (dimension: string, low: FilterValue, high: FilterValue): Filter =>
  build(dimension, "between", low, high);

/** `dimension IS NULL` */
export const isNull = (dimension: string): Filter => build(dimension, "is_null");

/** `dimension IS NOT NULL` */
export const isNotNull = (dimension: string): Filter => build(dimension, "is_not_null");
