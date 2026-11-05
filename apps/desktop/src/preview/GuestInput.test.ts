import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";

import { describe, expect, it, vi } from "vite-plus/test";

import { sendPageCommand, toKeyboardInputEvents } from "./GuestInput.ts";

const makeGuest = ({
  focused,
  focusedDocument = true,
}: {
  readonly focused: boolean;
  readonly focusedDocument?: boolean;
}) => {
  const sendCommand = vi.fn(async (method: string, params?: { expression?: string }) =>
    method === "Runtime.evaluate" && params?.expression?.endsWith("!== null")
      ? { result: { value: focusedDocument } }
      : { result: {} },
  );
  const webContents = {
    focusedFrame: focused ? {} : null,
    insertText: vi.fn(async () => {}),
    sendInputEvent: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
  };
  return {
    webContents,
    sendCommand,
    send: (method: string, params: Record<string, unknown>) =>
      sendPageCommand(
        webContents as unknown as Electron.WebContents,
        { sendCommand } as unknown as Electron.Debugger,
        method,
        params,
      ),
  };
};

describe("preview guest input", () => {
  it.each([
    { kind: "TEXTAREA", outcome: "blur" },
    { kind: "INPUT", outcome: "blur" },
    { kind: "contenteditable", outcome: "blur" },
    { kind: "shadow", outcome: "blur" },
    { kind: "TEXTAREA", outcome: "abort" },
    { kind: "TEXTAREA", outcome: "navigation" },
    { kind: "TEXTAREA", outcome: "timeout" },
    { kind: "TEXTAREA", outcome: "removal" },
  ])(
    "waits for the host $kind and handles $outcome without dispatching input",
    async ({ kind, outcome }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
      const editor = {
        tagName: kind,
        isContentEditable: kind === "contenteditable" || kind === "shadow",
      };
      const document = Object.assign(new EventTarget(), {
        activeElement: kind === "shadow" ? { shadowRoot: { activeElement: editor } } : editor,
        documentElement: {},
      });
      const observed = Promise.withResolvers<void>();
      const disconnect = vi.fn();
      let mutation = () => {};
      const context = NodeVM.createContext({
        document,
        queueMicrotask,
        MutationObserver: class {
          constructor(callback: () => void) {
            mutation = callback;
          }
          observe() {
            observed.resolve();
          }
          disconnect = disconnect;
        },
      });
      const host = Object.assign(new NodeEvents.EventEmitter(), {
        isDestroyed: () => false,
        executeJavaScript: async (script: string) => NodeVM.runInContext(script, context),
      });
      const sendCommand = vi.fn(async () => ({}));
      const guest = { hostWebContents: host, focusedFrame: null };
      const controller = new AbortController();
      let finished = false;
      const wait = sendPageCommand(
        guest as unknown as Electron.WebContents,
        { sendCommand } as unknown as Electron.Debugger,
        "T3.waitForHostInput",
        { timeoutMs: 1000 },
        undefined,
        controller.signal,
      ).then(() => {
        finished = true;
      });
      await observed.promise;
      expect(finished).toBe(false);
      expect(sendCommand).not.toHaveBeenCalled();
      // Moving between editors must not release a pending click.
      document.dispatchEvent(new Event("focusout"));
      await Promise.resolve();
      expect(finished).toBe(false);
      if (["abort", "navigation", "timeout"].includes(outcome)) {
        const rejected = expect(wait).rejects.toThrow(/cancelled|Timed out/);
        if (outcome === "abort") controller.abort();
        else if (outcome === "navigation") host.emit("did-navigate");
        else await vi.advanceTimersByTimeAsync(1000);
        await rejected;
      } else {
        document.activeElement = { tagName: "BUTTON", isContentEditable: false };
        if (outcome === "removal") mutation();
        else document.dispatchEvent(new Event("focusout"));
        await wait;
      }
      expect(disconnect).toHaveBeenCalledOnce();
      expect(host.eventNames()).toEqual([]);
      expect(context["__t3PreviewInputWaiters"]).toBeUndefined();
      expect(sendCommand).not.toHaveBeenCalled();
    },
  );

  it.each([
    ...["mousePressed", "mouseMoved", "mouseWheel", "touchStart", "touchMove"].map((type) => ({
      type,
      protectHostInput: true,
    })),
    { type: "mousePressed", protectHostInput: false },
  ])(
    "checks host input before $type, agent protection: $protectHostInput",
    async ({ type, protectHostInput }) => {
      const context = NodeVM.createContext({
        document: { activeElement: { isContentEditable: true } },
      });
      const host = {
        isDestroyed: () => false,
        executeJavaScript: async (script: string) => NodeVM.runInContext(script, context),
      };
      const sendCommand = vi.fn(async () => ({}));
      const result = sendPageCommand(
        { hostWebContents: host, focusedFrame: null } as unknown as Electron.WebContents,
        { sendCommand } as unknown as Electron.Debugger,
        type.startsWith("touch") ? "Input.dispatchTouchEvent" : "Input.dispatchMouseEvent",
        { type },
        undefined,
        undefined,
        protectHostInput,
      );
      if (protectHostInput) {
        await expect(result).rejects.toThrow("host input");
        expect(sendCommand).not.toHaveBeenCalled();
      } else {
        await result;
        expect(sendCommand).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["queued", "capturing"])(
    "cancels a pointer %s before it reaches the guest",
    async (phase) => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const host = {
        isDestroyed: () => false,
        executeJavaScript: async () => {
          if (phase === "capturing") {
            started.resolve();
            await release.promise;
          }
        },
      };
      const guest = { hostWebContents: host, focusedFrame: null };
      const sendCommand = vi.fn(async () => {
        started.resolve();
        await release.promise;
        return {};
      });
      const controller = new AbortController();
      const send = (type: string, signal?: AbortSignal) =>
        sendPageCommand(
          guest as unknown as Electron.WebContents,
          { sendCommand } as unknown as Electron.Debugger,
          "Input.dispatchMouseEvent",
          { type },
          undefined,
          signal,
        );
      const first = phase === "queued" ? send("mouseMoved") : undefined;
      const cancelled = send("mousePressed", controller.signal);
      const rejected = expect(cancelled).rejects.toThrow();
      await started.promise;
      controller.abort();
      release.resolve();
      await first;
      await rejected;
      expect(sendCommand.mock.calls.length).toBe(phase === "queued" ? 1 : 0);
    },
  );

  it("types into an unfocused guest's own page, not the app's focused field", async () => {
    const guest = makeGuest({ focused: false });
    await guest.send("Input.insertText", { text: "pairing-code" });
    expect(guest.webContents.insertText).toHaveBeenCalledWith("pairing-code");
    expect(guest.sendCommand).not.toHaveBeenCalledWith("Input.insertText", expect.anything());
  });

  it.each([
    {
      sessionId: undefined,
      method: "Input.dispatchMouseEvent",
      type: "mousePressed",
      outcome: "restore",
    },
    {
      sessionId: "child-frame",
      method: "Input.dispatchMouseEvent",
      type: "mousePressed",
      outcome: "restore",
    },
    {
      sessionId: undefined,
      method: "Input.dispatchTouchEvent",
      type: "touchStart",
      outcome: "restore",
    },
    {
      sessionId: undefined,
      method: "Input.dispatchMouseEvent",
      type: "mousePressed",
      outcome: "other-field",
    },
    {
      sessionId: undefined,
      method: "Input.dispatchMouseEvent",
      type: "mousePressed",
      outcome: "removed",
    },
    {
      sessionId: undefined,
      method: "Input.dispatchMouseEvent",
      type: "mousePressed",
      outcome: "failure",
    },
  ])(
    "preserves host focus for $method in $sessionId with $outcome",
    async ({ sessionId, method, type, outcome }) => {
      const document = { activeElement: {} as object };
      const composer = {
        isConnected: true,
        focus: () => {
          document.activeElement = composer;
        },
      };
      const preview = { tagName: "WEBVIEW", getWebContentsId: () => 7 };
      const otherField = { tagName: "INPUT" };
      document.activeElement = composer;
      const context = NodeVM.createContext({ document });
      const host = {
        isDestroyed: () => false,
        executeJavaScript: async (script: string) => NodeVM.runInContext(script, context),
      };
      const guest = { id: 7, focusedFrame: null, hostWebContents: host };
      const debuggee = {
        sendCommand: async () => {
          document.activeElement = outcome === "other-field" ? otherField : preview;
          if (outcome === "removed") composer.isConnected = false;
          if (outcome === "failure") throw new Error("Pointer failed");
          return {};
        },
      };
      const result = sendPageCommand(
        guest as unknown as Electron.WebContents,
        debuggee as unknown as Electron.Debugger,
        method,
        { type, x: 10, y: 10, button: "left" },
        sessionId,
      );
      if (outcome === "failure") await expect(result).rejects.toThrow("Pointer failed");
      else await result;
      expect(document.activeElement).toBe(
        outcome === "other-field" ? otherField : outcome === "removed" ? preview : composer,
      );
      expect(Object.keys(context)).toEqual(["document"]);
    },
  );

  it.each([{ userClicksStuckTab: false }, { userClicksStuckTab: true }])(
    "keeps the right focus when a sibling press finishes beside a stuck one, user clicks: $userClicksStuckTab",
    async ({ userClicksStuckTab }) => {
      const document = { activeElement: {} as object };
      const composer = {
        isConnected: true,
        focus: () => {
          document.activeElement = composer;
        },
      };
      document.activeElement = composer;
      const context = NodeVM.createContext({ document });
      const host = {
        isDestroyed: () => false,
        executeJavaScript: async (script: string) => NodeVM.runInContext(script, context),
      };
      const previews = new Map(
        [7, 8].map((id) => [id, { tagName: "WEBVIEW", getWebContentsId: () => id }]),
      );
      const stuckPressFocused = Promise.withResolvers<void>();
      const stuckPressEnds = Promise.withResolvers<void>();
      const press = (id: number) => {
        const debuggee = {
          sendCommand: async () => {
            document.activeElement = previews.get(id)!;
            if (id === 7) {
              stuckPressFocused.resolve();
              await stuckPressEnds.promise;
            } else if (userClicksStuckTab) {
              document.activeElement = previews.get(7)!;
            }
            return {};
          },
        };
        return sendPageCommand(
          { id, focusedFrame: null, hostWebContents: host } as unknown as Electron.WebContents,
          debuggee as unknown as Electron.Debugger,
          "Input.dispatchMouseEvent",
          { type: "mousePressed", x: 10, y: 10, button: "left" },
        );
      };
      // A press held open, as by a page's confirm() on mousedown, must not block or win focus.
      const stuck = press(7);
      await stuckPressFocused.promise;
      await press(8);
      const expected = userClicksStuckTab ? previews.get(7) : composer;
      expect(document.activeElement).toBe(expected);
      stuckPressEnds.resolve();
      await stuck;
      expect(Object.keys(context)).toEqual(["document"]);
    },
  );

  it.each([
    {
      method: "Input.dispatchMouseEvent",
      press: "mousePressed",
      release: "mouseReleased",
      failPress: false,
    },
    {
      method: "Input.dispatchTouchEvent",
      press: "touchStart",
      release: "touchEnd",
      failPress: false,
    },
    {
      method: "Input.dispatchMouseEvent",
      press: "mousePressed",
      release: "mouseReleased",
      failPress: true,
    },
  ])(
    "keeps $method releases behind presses waiting for host focus, failed press: $failPress",
    async ({ method, press, release, failPress }) => {
      const captureStarted = Promise.withResolvers<void>();
      const finishCapture = Promise.withResolvers<void>();
      const events: Array<unknown> = [];
      const guest = {
        id: 7,
        focusedFrame: null,
        hostWebContents: {
          isDestroyed: () => false,
          executeJavaScript: async () => {
            captureStarted.resolve();
            await finishCapture.promise;
          },
        },
      };
      const debuggee = {
        sendCommand: async (_method: string, params: Record<string, unknown>) => {
          events.push(params["type"]);
          if (failPress && params["type"] === press) throw new Error("Press failed");
          return {};
        },
      };
      const send = (type: string) =>
        sendPageCommand(
          guest as unknown as Electron.WebContents,
          debuggee as unknown as Electron.Debugger,
          method,
          { type },
        );
      const pressed = send(press);
      await captureStarted.promise;
      const released = send(release);
      finishCapture.resolve();
      const results = await Promise.allSettled([pressed, released]);
      expect(results.map((result) => result.status)).toEqual([
        failPress ? "rejected" : "fulfilled",
        "fulfilled",
      ]);
      expect(events).toEqual([press, release]);
    },
  );

  it("refuses input when a cross-site frame holds the unfocused page's focus", async () => {
    const guest = makeGuest({ focused: false, focusedDocument: false });
    await expect(guest.send("Input.insertText", { text: "secret" })).rejects.toThrow(
      /cross-site frame/,
    );
    expect(guest.webContents.insertText).not.toHaveBeenCalled();
  });
});

describe("CDP key events as Electron input", () => {
  it("sends a key's text as char events after its key down", () => {
    expect(toKeyboardInputEvents({ type: "keyDown", key: "Enter", text: "\r" })).toEqual([
      { type: "rawKeyDown", keyCode: "Enter", modifiers: [] },
      { type: "char", keyCode: "\r", modifiers: [] },
    ]);
    expect(toKeyboardInputEvents({ type: "keyDown", key: "é", text: "é", modifiers: 8 })).toEqual([
      { type: "rawKeyDown", keyCode: "é", modifiers: ["shift"] },
      { type: "char", keyCode: "é", modifiers: ["shift"] },
    ]);
  });

  // regression: #18556 agent typing in a preview tab landed in the app instead of the guest
  it("names arrows and function keys as Electron accelerators", () => {
    expect(toKeyboardInputEvents({ type: "keyUp", key: "ArrowLeft", modifiers: 3 })).toEqual([
      { type: "keyUp", keyCode: "Left", modifiers: ["alt", "control"] },
    ]);
    expect(toKeyboardInputEvents({ type: "rawKeyDown", key: "F12" })).toEqual([
      { type: "rawKeyDown", keyCode: "F12", modifiers: [] },
    ]);
    expect(toKeyboardInputEvents({ type: "rawKeyDown", key: "AudioVolumeUp" })).toEqual([]);
  });
});
