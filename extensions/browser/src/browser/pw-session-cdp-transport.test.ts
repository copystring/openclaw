import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectOverCdpTransport } from "./pw-session-cdp-transport.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");

afterEach(() => {
  connectOverCdpSpy.mockReset();
});

function mockPageInitializationFailure(
  wire: import("playwright-core").ConnectOverCDPTransport,
  sessionId: string,
  targetId: string,
  transition?: () => void,
) {
  connectOverCdpSpy.mockImplementationOnce((async (value: unknown) => {
    const transport = value as import("playwright-core").ConnectOverCDPTransport;
    wire.onmessage?.({
      method: "Target.attachedToTarget",
      params: {
        sessionId,
        targetInfo: { targetId, type: "page", browserContextId: "default-context" },
      },
    });
    transport.send({ id: 7, method: "Runtime.enable", sessionId });
    transition?.();
    const error = new Error("Timeout 1000ms exceeded");
    error.name = "TimeoutError";
    throw error;
  }) as never);
}

describe("Playwright CDP initialization diagnostics", () => {
  it.each([
    { mode: "generic", defer: false, fail: false, rejectReplay: false },
    { mode: "borrowed relay", defer: true, fail: false, rejectReplay: false },
    { mode: "failed borrowed relay handshake", defer: true, fail: true, rejectReplay: false },
    { mode: "rejected borrowed relay replay", defer: true, fail: false, rejectReplay: true },
  ])("handles initial auto-attach for $mode", async ({ defer, fail, rejectReplay }) => {
    const closeWire = vi.fn();
    const sendWire = vi.fn((message: object) => {
      const command = message as { id?: number };
      if (rejectReplay && typeof command.id === "number" && command.id <= -10_000) {
        wire.onmessage?.({
          id: command.id,
          error: { message: "native attach denied" },
        });
      }
    });
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: sendWire,
      close: closeWire,
    };
    const browser = { close: vi.fn() } as never;
    let playwrightTransport: import("playwright-core").ConnectOverCDPTransport | undefined;
    const originalParams = {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "page" }],
    };
    connectOverCdpSpy.mockImplementationOnce((async (value: unknown) => {
      const transport = value as import("playwright-core").ConnectOverCDPTransport;
      playwrightTransport = transport;
      transport.send({ id: 41, method: "Target.setAutoAttach", params: originalParams });
      if (fail) {
        const error = new Error("Timeout 1000ms exceeded");
        error.name = "TimeoutError";
        throw error;
      }
      wire.onmessage?.({ id: 41, result: {} });
      return browser;
    }) as never);

    const connection = connectOverCdpTransport("http://127.0.0.1:18799", {
      timeout: 1000,
      headers: {},
      preparedTransport: wire,
      deferInitialAutoAttach: defer,
    });
    if (fail) {
      await expect(connection).rejects.toThrow("Timeout 1000ms exceeded");
    } else {
      await expect(connection).resolves.toBe(browser);
    }

    expect(sendWire).toHaveBeenCalledTimes(defer && !fail ? 2 : 1);
    expect(sendWire).toHaveBeenNthCalledWith(1, {
      id: 41,
      method: "Target.setAutoAttach",
      params: { ...originalParams, autoAttach: !defer },
    });
    if (defer && !fail) {
      expect(sendWire).toHaveBeenNthCalledWith(2, {
        id: expect.any(Number),
        method: "Target.setAutoAttach",
        params: originalParams,
      });
      expect((sendWire.mock.calls[1]?.[0] as { id: number } | undefined)?.id).toBeLessThan(-9999);
    }
    if (rejectReplay) {
      expect(closeWire).toHaveBeenCalledOnce();
      expect(() => playwrightTransport?.send({ id: 42, method: "Browser.getVersion" })).toThrow(
        "Relay page attachment failed: native attach denied",
      );
    }
  });

  it("identifies the page target whose initialization blocks a cold connection", async () => {
    const closeWire = vi.fn();
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: vi.fn(),
      close: closeWire,
    };
    mockPageInitializationFailure(wire, "stalled-session", "STALLED-PAGE");

    const connection = connectOverCdpTransport("http://127.0.0.1:18799", {
      timeout: 1000,
      headers: {},
      preparedTransport: wire,
    });
    await expect(connection).rejects.toThrow(
      'page target "STALLED-PAGE" did not respond during initialization',
    );
    await expect(connection).rejects.toThrow(
      "Close the target in the browser or provider dashboard",
    );
    expect(closeWire).toHaveBeenCalledOnce();
  });

  it("forgets unanswered commands when their page session detaches", async () => {
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: vi.fn(),
      close: vi.fn(),
    };
    mockPageInitializationFailure(wire, "detached-session", "DETACHED-PAGE", () => {
      wire.onmessage?.({
        method: "Target.detachedFromTarget",
        params: { sessionId: "detached-session" },
      });
    });

    await expect(
      connectOverCdpTransport("http://127.0.0.1:18799", {
        timeout: 1000,
        headers: {},
        preparedTransport: wire,
      }),
    ).rejects.toThrow("Timeout 1000ms exceeded");
  });

  it("does not blame a target whose initialization command completed", async () => {
    const wire: import("playwright-core").ConnectOverCDPTransport = {
      send: vi.fn(),
      close: vi.fn(),
    };
    mockPageInitializationFailure(wire, "healthy-session", "HEALTHY-PAGE", () => {
      wire.onmessage?.({ id: 7, result: {} });
    });

    await expect(
      connectOverCdpTransport("http://127.0.0.1:18799", {
        timeout: 1000,
        headers: {},
        preparedTransport: wire,
      }),
    ).rejects.toThrow("Timeout 1000ms exceeded");
  });
});
