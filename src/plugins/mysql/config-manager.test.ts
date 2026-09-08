import assert from "node:assert/strict";
import test from "node:test";

import { createMysqlConfigManager } from "./config-manager.js";

test("MySQL password uses framework Secret retention and replacement semantics", async () => {
  let environment: Record<string, string> = {
    MYSQL_HOST: "localhost",
    MYSQL_PORT: "3306",
    MYSQL_USER: "reader",
    MYSQL_PASSWORD: "old-secret",
    MYSQL_DATABASE: "metrics",
  };
  const writes: Record<string, string>[] = [];
  const manager = createMysqlConfigManager({
    environment: () => ({ ...environment }),
    update: async (values) => {
      writes.push({ ...values });
      environment = { ...environment, ...values };
    },
  });

  const initial = manager.getSnapshot();
  assert.equal(Object.hasOwn(initial.values, "MYSQL_PASSWORD"), false);
  assert.deepEqual(initial.secretStates, { MYSQL_PASSWORD: { configured: true } });

  await manager.update({ values: { MYSQL_HOST: "db.internal", MYSQL_PASSWORD: "" } });
  assert.equal(writes[0]?.MYSQL_PASSWORD, "old-secret");

  const replacement = await manager.update({ values: { MYSQL_PASSWORD: "new-secret" } });
  assert.equal(writes[1]?.MYSQL_PASSWORD, "new-secret");
  assert.equal(Object.hasOwn(replacement.snapshot.values, "MYSQL_PASSWORD"), false);
  assert.deepEqual(replacement.snapshot.secretStates, { MYSQL_PASSWORD: { configured: true } });

  await assert.rejects(
    manager.update({ values: {}, clearSecrets: ["MYSQL_PASSWORD"] }),
    /MYSQL_PASSWORD.*required/,
  );
  assert.equal(environment.MYSQL_PASSWORD, "new-secret");
  assert.equal(writes.length, 2);
});
