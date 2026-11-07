/** A recorded canvas call: `[0, property, value]` or `[1, method, ...args]`. */
export type Op = [0 | 1, string, ...unknown[]];
