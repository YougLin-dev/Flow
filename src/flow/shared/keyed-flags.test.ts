import { effect } from "nsh";
import { expect, test } from "nsh/test";
import { KeyedFlags } from "./keyed-flags";

test("a flag reads true only after its id is set", () => {
  const flags = new KeyedFlags();
  expect(flags.has("a")).toBe(false);
  let runs = 0;
  effect(() => {
    flags.has("a");
    runs += 1;
  });
  expect(runs).toBe(1);

  flags.set(["a"]);
  expect(flags.has("a")).toBe(true);
  expect(runs).toBe(2);
});

test("set flips only the ids whose value changed", () => {
  const flags = new KeyedFlags();
  flags.set(["a", "b"]);
  let runsA = 0;
  let runsB = 0;
  let runsC = 0;
  effect(() => {
    flags.has("a");
    runsA += 1;
  });
  effect(() => {
    flags.has("b");
    runsB += 1;
  });
  effect(() => {
    flags.has("c");
    runsC += 1;
  });
  expect([runsA, runsB, runsC]).toEqual([1, 1, 1]);

  flags.set(["b", "c"]);
  expect(runsA).toBe(2);
  expect(runsB).toBe(1);
  expect(runsC).toBe(2);
});

test("setting the same ids wakes no reader", () => {
  const flags = new KeyedFlags();
  flags.set(["a", "b"]);
  let runs = 0;
  effect(() => {
    flags.has("a");
    flags.has("b");
    runs += 1;
  });

  flags.set(["b", "a"]);
  flags.set(["a", "b"]);
  expect(runs).toBe(1);
});

test("a hover moving from A to B wakes only A's and B's readers", () => {
  const flags = new KeyedFlags();
  flags.set(["a"]);
  let runsA = 0;
  let runsB = 0;
  let runsC = 0;
  effect(() => {
    flags.has("a");
    runsA += 1;
  });
  effect(() => {
    flags.has("b");
    runsB += 1;
  });
  effect(() => {
    flags.has("c");
    runsC += 1;
  });

  flags.set(["b"]);
  expect(runsA).toBe(2);
  expect(runsB).toBe(2);
  expect(runsC).toBe(1);
});

test("a repeated flip leaves an unrelated reader at its initial run count", () => {
  const flags = new KeyedFlags();
  flags.set(["a"]);
  let runsA = 0;
  let runsB = 0;
  let runsC = 0;
  let unused = 0;
  effect(() => {
    flags.has("a");
    runsA += 1;
  });
  effect(() => {
    flags.has("b");
    runsB += 1;
  });
  effect(() => {
    flags.has("c");
    runsC += 1;
  });
  effect(() => {
    flags.has("unused");
    unused += 1;
  });

  flags.set(["b", "c"]);
  flags.set(["a"]);
  flags.set(["b"]);
  expect(runsB).toBe(4);
  expect(runsC).toBe(3);
  expect(runsA).toBe(4);
  expect(unused).toBe(1);
});

test("retain drops flags for ids no longer present", () => {
  const flags = new KeyedFlags();
  flags.set(["a", "b", "c"]);
  flags.retain(new Set(["a", "b"]));

  expect(flags.size()).toBe(2);
  expect(flags.has("c")).toBe(false);
  expect(flags.size()).toBe(3);
  let runs = 0;
  effect(() => {
    flags.has("c");
    runs += 1;
  });
  expect(runs).toBe(1);
});
