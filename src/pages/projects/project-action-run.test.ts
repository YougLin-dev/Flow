import { expect, test } from "nsh/test";
import { runProjectAction, type DialogRun, type DialogRuns } from "./project-action-run";

function harness(live: DialogRun | null): {
  runs: DialogRuns;
  calls: string[];
  late: { action: string; message: string }[];
  dismiss: () => void;
} {
  const calls: string[] = [];
  const late: { action: string; message: string }[] = [];
  let current = live;
  return {
    calls,
    late,
    dismiss: () => {
      if (current !== null) current.dismissed = true;
      current = null;
    },
    runs: {
      current: () => current,
      finish: (run) => {
        calls.push("finish");
        if (run === current) current = null;
      },
      reportLateError: (action, cause) => {
        late.push({ action, message: cause instanceof Error ? cause.message : String(cause) });
      },
    },
  };
}

test("a live run closes its dialog and applies its result", async () => {
  const { runs, calls, dismiss } = harness({ dismissed: false });
  const applied: string[] = [];
  const value = await runProjectAction(
    runs,
    "rename",
    async () => "Renamed",
    (result) => {
      calls.push("applied");
      applied.push(result);
    },
  );
  dismiss();
  expect(value).toBe("Renamed");
  expect(applied).toEqual(["Renamed"]);
  expect(calls).toEqual(["finish", "applied"]);
});

test("a run dismissed while its write runs applies nothing", async () => {
  const { runs, calls, dismiss } = harness({ dismissed: false });
  const applied: string[] = [];
  const value = await runProjectAction(
    runs,
    "duplicate",
    async () => {
      dismiss();
      return "Copy";
    },
    (result) => applied.push(result),
  );
  expect(value).toBe("Copy");
  expect(applied).toEqual([]);
  expect(calls).toEqual([]);
});

test("a dismissed run reports its late failure to the list", async () => {
  const { runs, late, dismiss } = harness({ dismissed: false });
  await expect(
    runProjectAction(
      runs,
      "create",
      async () => {
        dismiss();
        throw new Error("the project title is invalid");
      },
      () => undefined,
    ),
  ).rejects.toThrow("the project title is invalid");
  expect(late).toEqual([{ action: "create", message: "the project title is invalid" }]);
});

test("a live run leaves its failure with the dialog", async () => {
  const { runs, late } = harness({ dismissed: false });
  await expect(
    runProjectAction(
      runs,
      "delete",
      async () => {
        throw new Error("the project is open in another window");
      },
      () => undefined,
    ),
  ).rejects.toThrow("the project is open in another window");
  expect(late).toEqual([]);
});

test("a submit after the dismissal starts no write", async () => {
  const { runs, calls } = harness(null);
  let wrote = false;
  const value = await runProjectAction(
    runs,
    "import",
    async () => {
      wrote = true;
      return "Imported";
    },
    () => calls.push("applied"),
  );
  expect(value).toBe(null);
  expect(wrote).toBe(false);
  expect(calls).toEqual([]);
});
