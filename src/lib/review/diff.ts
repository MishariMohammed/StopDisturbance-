// Word-level diff for "Show changes from template" (04-ux §6.2). Pure; safe in client components.

export type DiffOp = { type: "same" | "add" | "del"; text: string };

/** Splits into words and the whitespace between them, so the diff keeps line breaks. */
export function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

const MAX_CELLS = 4_000_000;

/** LCS diff of two texts. Adjacent operations of the same type are merged. */
export function diffWords(before: string, after: string): DiffOp[] {
  const a = tokenize(before);
  const b = tokenize(after);
  // Trim the common prefix/suffix first: letters are mostly unchanged.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: DiffOp[] = [];
  const push = (type: DiffOp["type"], text: string) => {
    if (!text) return;
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };
  push("same", a.slice(0, start).join(""));

  if (midA.length * midB.length > MAX_CELLS) {
    // Too large for a table: show it as one replacement.
    push("del", midA.join(""));
    push("add", midB.join(""));
  } else {
    const n = midA.length;
    const m = midB.length;
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        push("same", midA[i]);
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        push("del", midA[i++]);
      } else {
        push("add", midB[j++]);
      }
    }
    while (i < n) push("del", midA[i++]);
    while (j < m) push("add", midB[j++]);
  }
  push("same", a.slice(endA).join(""));
  return ops;
}

export function hasChanges(ops: DiffOp[]): boolean {
  return ops.some((o) => o.type !== "same" && o.text.trim() !== "");
}
