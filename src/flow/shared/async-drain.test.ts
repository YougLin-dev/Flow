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
  const joined = drain.join(true);
  expect(joined).not.toBeNull();
  void joined?.then(() => {
    joinedSettled = true;
  });

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

test("a start that races a running drain joins it instead of reading twice", async () => {
  const drain = new AsyncDrain();
  const firstRead = gate();
  let iterations = 0;
  const first = drain.start(async () => {
    iterations += 1;
    await firstRead.promise;
    return "done";
  });

  let racedStepRan = false;
  const raced = drain.start(async () => {
    racedStepRan = true;
    return "done";
  });

  firstRead.open();
  await Promise.all([first, raced]);
  expect(iterations).toBe(1);
  expect(racedStepRan).toBe(false);
});
