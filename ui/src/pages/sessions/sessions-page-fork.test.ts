/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountMutation, sessionRow } from "./sessions-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([
  ["operator.write", "viewer", true],
  ["operator.sessions.write", "owner", true],
  ["operator.sessions.write", "viewer", false],
  ["operator.sessions.read", "owner", false],
] as const)("gates active-session forks for %s/%s", async (scope, sharingRole, allowed) => {
  const { page, sessions, connection } = await mountMutation({
    createResult: vi.fn<SessionCapability["createResult"]>(async () => ({
      key: "active-fork",
      entry: { sessionId: "active-fork-id" },
      initialRun: { status: "idle" },
    })),
  });
  connection.emit({ hello: gatewayHelloForMethods(["sessions.create"], [scope]) });
  page.result = sessionsResult([sessionRow("main", { key: "main", sharingRole })], 1);
  await page.forkSession("main", true);
  if (!allowed) {
    expect(sessions.createResult).not.toHaveBeenCalled();
    expect(page.error).toBeTruthy();
    return;
  }
  expect(sessions.createResult).toHaveBeenCalledWith(
    {
      parentSessionKey: "main",
      fork: true,
      forkFrom: "last-completed",
    },
    { signal: expect.any(AbortSignal) },
  );
});
