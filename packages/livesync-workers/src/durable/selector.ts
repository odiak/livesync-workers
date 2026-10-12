type DocBody = Record<string, unknown>;
type Selector = Record<string, unknown>;
type RevRow = { id: string; rev: string; deleted: number };
type RevisionMetadata = { soft_deleted: number; type: string | null; path: string | null; size: number | null; mtime: number | null };
function compareCodePoints(a: string, b: string): number {
  const aa = Array.from(a, c => c.codePointAt(0)!);
  const bb = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  return aa.length - bb.length;
}
function getField(doc: DocBody, field: string): unknown {
  if (field === "_id") return doc._id;
  if (field === "_rev") return doc._rev;
  return field.split(".").reduce<unknown>((value, key) => {
    if (value == null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, doc);
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return compareCodePoints(String(a), String(b));
}

const MAX_SELECTOR_REGEX_LENGTH = 256;

/**
 * Whether a pattern has the shapes that make backtracking blow up: a
 * quantified group whose contents, at any depth, repeat or alternate
 * ((a+)+, ((a+))+, (a|aa)*), and backreferences. A conservative check, not
 * a proof: chains of plain quantifiers such as a*a*a* still cost polynomial time.
 */
function hasNestedRepetition(pattern: string): boolean {
  // One entry per open group: whether its contents repeat or alternate.
  const groups: boolean[] = [];
  const isQuantifier = (index: number) => {
    const c = pattern[index];
    return c === "*" || c === "+" || c === "?" || (c === "{" && /\d/.test(pattern[index + 1] ?? ""));
  };
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const next = pattern[i + 1] ?? "";
      if (!inClass && (/[1-9]/.test(next) || next === "k")) return true;
      i++;
    } else if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "(") {
      groups.push(false);
      // Skip the ?: ?= ?! ?<= ?<! ?<name> prefix, whose "?" is not a quantifier.
      if (pattern[i + 1] === "?") {
        if (pattern[i + 2] === "<" && pattern[i + 3] !== "=" && pattern[i + 3] !== "!") {
          const end = pattern.indexOf(">", i);
          i = end < 0 ? pattern.length : end;
        } else {
          i += pattern[i + 2] === "<" ? 3 : 2;
        }
      }
    } else if (c === ")") {
      const inner = groups.pop() ?? false;
      const quantified = isQuantifier(i + 1);
      if (inner && quantified) return true;
      if (groups.length && (inner || quantified)) groups[groups.length - 1] = true;
    } else if ((c === "|" || isQuantifier(i)) && groups.length) {
      groups[groups.length - 1] = true;
    }
  }
  return false;
}

const selectorRegexCache = new Map<string, RegExp | null>();

/**
 * Compile a Mango $regex once per pattern. Over-long patterns and nested
 * quantifiers never match, so one selector cannot easily pin the vault
 * object's CPU. LiveSync itself does not use $regex.
 */
function selectorRegex(pattern: string): RegExp | null {
  if (selectorRegexCache.has(pattern)) return selectorRegexCache.get(pattern)!;
  let compiled: RegExp | null = null;
  if (pattern.length <= MAX_SELECTOR_REGEX_LENGTH && !hasNestedRepetition(pattern)) {
    try {
      compiled = new RegExp(pattern);
    } catch {
      compiled = null;
    }
  }
  if (selectorRegexCache.size >= 64) selectorRegexCache.clear();
  selectorRegexCache.set(pattern, compiled);
  return compiled;
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition == null || typeof condition !== "object" || Array.isArray(condition)) {
    return value === condition;
  }
  for (const [op, expected] of Object.entries(condition as Record<string, unknown>)) {
    switch (op) {
      case "$eq":
        if (value !== expected) return false;
        break;
      case "$ne":
        if (value === expected) return false;
        break;
      case "$lt":
        if (compareValues(value, expected) >= 0) return false;
        break;
      case "$lte":
        if (compareValues(value, expected) > 0) return false;
        break;
      case "$gt":
        if (compareValues(value, expected) <= 0) return false;
        break;
      case "$gte":
        if (compareValues(value, expected) < 0) return false;
        break;
      case "$exists":
        if ((value !== undefined) !== Boolean(expected)) return false;
        break;
      case "$in":
        if (!Array.isArray(expected) || !expected.includes(value)) return false;
        break;
      case "$nin":
        if (Array.isArray(expected) && expected.includes(value)) return false;
        break;
      case "$regex":
        if (typeof value !== "string" || typeof expected !== "string") return false;
        if (!selectorRegex(expected)?.test(value)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

export function matchesSelector(doc: DocBody, selector: Selector | null): boolean {
  if (!selector || Object.keys(selector).length === 0) return true;
  for (const [field, condition] of Object.entries(selector)) {
    if (field === "$and") {
      if (!Array.isArray(condition)) return false;
      if (!condition.every((item) => matchesSelector(doc, item as Selector))) {
        return false;
      }
      continue;
    }
    if (field === "$or") {
      if (!Array.isArray(condition)) return false;
      if (!condition.some((item) => matchesSelector(doc, item as Selector))) {
        return false;
      }
      continue;
    }
    if (!matchesCondition(getField(doc, field), condition)) return false;
  }
  return true;
}

/** Unknown fields need the body; SQL NULL does not distinguish missing, null or a non-scalar value. */
export function matchesMetadata(
  row: RevRow,
  metadata: RevisionMetadata | null,
  selector: Selector,
): boolean | undefined {
  if (!selector || Object.keys(selector).length === 0) return true;
  let unknown = false;
  for (const [field, condition] of Object.entries(selector)) {
    let matched: boolean | undefined;
    if (field === "$and" || field === "$or") {
      if (!Array.isArray(condition)) return false;
      const parts = condition.map((item) => matchesMetadata(row, metadata, item as Selector));
      matched =
        field === "$and"
          ? parts.includes(false)
            ? false
            : parts.includes(undefined)
              ? undefined
              : true
          : parts.includes(true)
            ? true
            : parts.includes(undefined)
              ? undefined
              : false;
    } else {
      const value =
        field === "_id"
          ? row.id
          : field === "_rev"
            ? row.rev
            : field === "_deleted" && row.deleted
              ? true
              : field === "deleted" && metadata?.soft_deleted
                ? true
                : field === "type" || field === "path" || field === "size" || field === "mtime"
                  ? metadata?.[field]
                  : undefined;
      matched = value == null ? undefined : matchesCondition(value, condition);
    }
    if (matched === false) return false;
    if (matched === undefined) unknown = true;
  }
  return unknown ? undefined : true;
}
