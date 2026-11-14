import { expect, test } from "nsh/test";
import { AsyncDrain } from "./async-drain";

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function flush(turns = 6): Promise<void> {
  if (turns <= 0) return;
  await Promise.resolve();
  await flush(turns - 1);
}

test("a join without an active drain asks for a start instead", () => {
  const drain = new AsyncDrain();
  expect(drain.active).toBe(false);
  expect(drain.join()).toBeNull();
});

test("a second request joins the active drain and settles with it", async () => {
  const drain = new AsyncDrain();
  const firstRead = gate();
  let iterations = 0;
  const first = drain.start(async () => {
    iterations += 1;
    await firstRead.promise;
    return "done";
  });
  expect(drain.active).toBe(true);

  let joinedSettled = false;
  // A join with the same inputs: settle with the drain, no follow-up.
  const joined = drain.join(false);
  expect(joined).not.toBeNull();
  void joined?.then(() => {
    joinedSettled = true;
  });
  // The join is real progress, not an already-resolved promise.
  await flush();
  expect(joinedSettled).toBe(false);

  firstRead.open();
  await Promise.all([first, joined]);
  expect(iterations).toBe(1);
  expect(joinedSettled).toBe(true);
  expect(drain.active).toBe(false);
});

test("a join that needs the newer inputs runs exactly one follow-up", async () => {
  const drain = new AsyncDrain();
  const reads = [gate(), gate()];
  let iterations = 0;
  const first = drain.start(async (isDirty) => {
    iterations += 1;
    await reads[iterations - 1]?.promise;
    return isDirty() ? "continue" : "done";
  });

  const joined = drain.join(true);
  reads[0]?.open();
  await flush();
  expect(iterations).toBe(2);

  reads[1]?.open();
  await Promise.all([first, joined]);
  expect(iterations).toBe(2);
  expect(drain.active).toBe(false);
});

test("a join that found the same inputs asks for no follow-up", async () => {
  const drain = new AsyncDrain();
  const firstRead = gate();
  let iterations = 0;
  const first = drain.start(async (isDirty) => {
    iterations += 1;
    await firstRead.promise;
    return isDirty() ? "continue" : "done";
  });

  const joined = drain.join(false);
  firstRead.open();
  await Promise.all([first, joined]);
  expect(iterations).toBe(1);
});

test("a start that races a running drain joins it without running its own step", async () => {
  const drain = new AsyncDrain();
  const firstRead = gate();
  let iterations = 0;
  const first = drain.start(async (isDirty) => {
    iterations += 1;
    await firstRead.promise;
    return isDirty() ? "continue" : "done";
  });

  let racedStepRan = false;
  const raced = drain.start(async () => {
    racedStepRan = true;
    return "done";
  });

  await flush();
  expect(racedStepRan).toBe(false);
  firstRead.open();
  await Promise.all([first, raced]);
  // The start marked the active drain for one follow-up; its own step never ran.
  expect(iterations).toBe(2);
  expect(racedStepRan).toBe(false);
});

test("a step may ask for a second follow-up", async () => {
  const drain = new AsyncDrain();
  const reads = [gate(), gate(), gate()];
  let iterations = 0;
  const run = drain.start(async () => {
    iterations += 1;
    await reads[iterations - 1]?.promise;
    return iterations < 3 ? "continue" : "done";
  });

  reads[0]?.open();
  await flush();
  expect(iterations).toBe(2);
  reads[1]?.open();
  await flush();
  expect(iterations).toBe(3);

  reads[2]?.open();
  await run;
  expect(drain.active).toBe(false);
});

test("a drain that went dirty after its last check still follows up", async () => {
  const drain = new AsyncDrain();
  let iterations = 0;
  const run = drain.start(async () => {
    iterations += 1;
    // The join lands after the step decided to stop; the core must honor it.
    if (iterations === 1) void drain.join(true);
    return "done";
  });

  await run;
  expect(iterations).toBe(2);
  expect(drain.active).toBe(false);
});

test("a step that throws still settles every caller", async () => {
  const drain = new AsyncDrain();
  const originalError = console.error;
  let logged = 0;
  console.error = () => {
    logged += 1;
  };
  try {
    const result = drain.start(async () => {
      throw new Error("boom");
    });
    await result;
    expect(drain.active).toBe(false);
    expect(logged).toBe(1);
  } finally {
    console.error = originalError;
  }
});
