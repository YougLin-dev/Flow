import { expect, test } from "nsh/test";
import { databasePath } from "./database-path";

test("prefers an explicit host or environment override", () => {
  expect(
    databasePath({
      dataDir: "/data/Flow",
      hostPath: "/tmp/test.db",
      envPath: "/tmp/env.db",
    }),
  ).toBe("/tmp/test.db");
  expect(databasePath({ dataDir: "/data/Flow", hostPath: undefined, envPath: "/tmp/env.db" })).toBe(
    "/tmp/env.db",
  );
});

test("uses the host's data directory by default", () => {
  expect(databasePath({ dataDir: "/data/Flow", hostPath: undefined, envPath: undefined })).toBe(
    "/data/Flow/flow.db",
  );
});

test("stays in memory without a data directory or override", () => {
  expect(databasePath({ dataDir: null, hostPath: "", envPath: "   " })).toBe(":memory:");
});
