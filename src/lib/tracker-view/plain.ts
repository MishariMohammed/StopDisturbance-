/** Server → client props: Dates become ISO strings (what JSON does). */
export type Plain<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Plain<U>[]
    : T extends object
      ? { [K in keyof T]: Plain<T[K]> }
      : T;

export function toPlain<T>(v: T): Plain<T> {
  return JSON.parse(JSON.stringify(v)) as Plain<T>;
}
