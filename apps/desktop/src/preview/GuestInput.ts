// CDP input follows shared window focus; send directly to unfocused guests to avoid typing into the app.

const FOCUS_ROUTED_INPUT = new Set([
  "Input.insertText",
  "Input.dispatchKeyEvent",
  "Input.imeSetComposition",
]);

/** Direct input reaches only the main-frame process; insertText crashes when a cross-site frame has focus. */
const FOCUSED_DOCUMENT = `(() => {
  let doc = document;
  for (;;) {
    const active = doc.activeElement;
    if (active?.tagName !== "IFRAME" && active?.tagName !== "FRAME") return doc;
    if (!active.contentDocument) return null;
    doc = active.contentDocument;
  }
})()`;

/** Electron runs editing commands only for CDP keys; exclude clipboard commands to preserve the user's clipboard. */
const EDITING_COMMANDS = new Set(["selectAll", "undo", "redo"]);

const CROSS_SITE_FOCUS_MESSAGE =
  "The page's focus is inside a cross-site frame, which takes typed input only while the preview has focus. Click the field first.";

const ARROW_KEYS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};
const NAMED_KEYS = new Set([
  "Backspace",
  "Tab",
  "Enter",
  "Escape",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "PrintScreen",
]);
const MODIFIER_BITS = [
  [1, "alt"],
  [2, "control"],
  [4, "meta"],
  [8, "shift"],
] as const;

const keyCodeFor = (key: string) => {
  if ([...key].length === 1) return key;
  if (ARROW_KEYS[key]) return ARROW_KEYS[key];
  return NAMED_KEYS.has(key) || /^F(?:[1-9]|1\d|2[0-4])$/u.test(key) ? key : null;
};

/** Electron derives text from keyCode, so typed text needs separate char events. */
export const toKeyboardInputEvents = (
  params: Record<string, unknown>,
): Array<Electron.KeyboardInputEvent> => {
  const bits = typeof params["modifiers"] === "number" ? params["modifiers"] : 0;
  const modifiers = MODIFIER_BITS.flatMap(([bit, name]) => (bits & bit ? [name] : []));
  const text = typeof params["text"] === "string" ? params["text"] : "";
  const chars = [...text].map((char) => ({ type: "char" as const, keyCode: char, modifiers }));
  const keyCode = keyCodeFor(typeof params["key"] === "string" ? params["key"] : "");
  switch (params["type"]) {
    case "keyDown":
      return [...(keyCode ? [{ type: "rawKeyDown" as const, keyCode, modifiers }] : []), ...chars];
    case "rawKeyDown":
    case "keyUp":
      return keyCode ? [{ type: params["type"], keyCode, modifiers }] : [];
    case "char":
      return chars;
    default:
      return [];
  }
};

const evaluate = async (debuggee: Electron.Debugger, expression: string) => {
  const reply = (await debuggee.sendCommand("Runtime.evaluate", {
    expression,
    returnByValue: true,
  })) as { readonly result?: { readonly value?: unknown } };
  return reply.result?.value;
};

const HOST_EDITABLE = `(() => {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (active?.isContentEditable) return true;
  if (!active || active.disabled || active.readOnly) return false;
  return active.tagName === "TEXTAREA" || (active.tagName === "INPUT" &&
    !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "hidden", "image"].includes(active.type));
})()`;
const HOST_WAITERS = "globalThis.__t3PreviewInputWaiters";
let nextInputWait = 0;

/** Only the readiness check waits; a timed-out Playwright click must never remain queued here. */
const waitForHostInput = async (
  host: Electron.WebContents | null | undefined,
  timeoutMs: unknown,
  signal?: AbortSignal,
) => {
  if (!host) return {};
  if (host.isDestroyed()) throw new Error("The browser host has closed.");
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("The browser request expired while waiting for host input.");
  }
  signal?.throwIfAborted();
  const id = ++nextInputWait;
  const done = Promise.withResolvers<unknown>();
  const cancel = () => done.reject(new Error("The host input wait was cancelled."));
  // @effect-diagnostics-next-line globalTimers:off - Electron debugger promises run outside the Effect runtime.
  const timer = setTimeout(
    () => done.reject(new Error("Timed out waiting for host input to lose focus.")),
    timeoutMs,
  );
  host.once("destroyed", cancel);
  host.once("did-navigate", cancel);
  signal?.addEventListener("abort", cancel, { once: true });
  void host
    .executeJavaScript(`new Promise(resolve => {
    const editable = () => ${HOST_EDITABLE};
    if (!editable()) { resolve(true); return; }
    const waits = (${HOST_WAITERS} ??= new Map());
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      document.removeEventListener("focusout", check, true);
      document.removeEventListener("focusin", check, true);
      observer.disconnect();
      waits.delete(${id});
      if (waits.size === 0) delete ${HOST_WAITERS};
      resolve(true);
    };
    const check = () => queueMicrotask(() => { if (!editable()) finish(); });
    const observer = new MutationObserver(check);
    waits.set(${id}, finish);
    document.addEventListener("focusout", check, true);
    document.addEventListener("focusin", check, true);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["contenteditable", "readonly", "disabled"] });
    check();
  })`)
    .then(done.resolve, done.reject);
  try {
    await done.promise;
    signal?.throwIfAborted();
    return {};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    host.off("destroyed", cancel);
    host.off("did-navigate", cancel);
    if (!host.isDestroyed()) {
      await host.executeJavaScript(`${HOST_WAITERS}?.get(${id})?.()`).catch(() => {});
    }
  }
};

/** Host focus shared by the presses in flight in one window, so a later press keeps the field an earlier one saved. */
const HOST_FOCUS = "globalThis.__t3PreviewFocus";

/** A CDP pointer press focuses the guest's native view even with focus emulation enabled. */
const sendPointerPress = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
  protectHostInput: boolean,
) => {
  signal?.throwIfAborted();
  const host = webContents.hostWebContents;
  if (!host || host.isDestroyed()) {
    return debuggee.sendCommand(method, params, sessionId);
  }
  // Focus in a webview with a press in flight came from that press, so keep the earlier save.
  const captured = await host.executeJavaScript(`(() => {
    if (${protectHostInput} && ${HOST_EDITABLE}) return false;
    const state = (${HOST_FOCUS} ??= { saved: null, presses: [] });
    const active = document.activeElement;
    let pressed = false;
    try {
      pressed = active?.tagName === "WEBVIEW" && state.presses.includes(active.getWebContentsId());
    } catch {}
    if (!pressed) {
      state.saved = active && active !== document.body && active.tagName !== "WEBVIEW" ? active : null;
    }
    state.presses.push(${webContents.id});
    return true;
  })()`);
  if (captured === false)
    throw new Error("The host input regained focus. Retry after leaving the input field.");
  try {
    signal?.throwIfAborted();
    return await debuggee.sendCommand(method, params, sessionId);
  } finally {
    if (!host.isDestroyed()) {
      // Membership check: a host reload starts a new state without this press.
      await host.executeJavaScript(`(() => {
        const state = ${HOST_FOCUS};
        const index = state ? state.presses.indexOf(${webContents.id}) : -1;
        if (index < 0) return;
        state.presses.splice(index, 1);
        if (state.presses.length === 0) delete ${HOST_FOCUS};
        const current = document.activeElement;
        try {
          if (state.saved?.isConnected && current?.tagName === "WEBVIEW" &&
              current.getWebContentsId() === ${webContents.id}) state.saved.focus({ preventScroll: true });
        } catch {}
      })()`);
    }
  }
};

const pointerCommands = new WeakMap<Electron.WebContents, Promise<unknown>>();

/** Focus capture crosses processes; later pointer events must not overtake the press. */
const sendPointerCommand = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
  protectHostInput: boolean,
) => {
  const previous = pointerCommands.get(webContents) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      signal?.throwIfAborted();
      const press = params["type"] === "mousePressed" || params["type"] === "touchStart";
      const host = webContents.hostWebContents;
      if (
        !press &&
        protectHostInput &&
        host &&
        !host.isDestroyed() &&
        params["type"] !== "mouseReleased" &&
        params["type"] !== "touchEnd" &&
        params["type"] !== "touchCancel" &&
        (await host.executeJavaScript(HOST_EDITABLE))
      ) {
        throw new Error("The host input regained focus. Retry after leaving the input field.");
      }
      signal?.throwIfAborted();
      return press
        ? sendPointerPress(
            webContents,
            debuggee,
            method,
            params,
            sessionId,
            signal,
            protectHostInput,
          )
        : debuggee.sendCommand(method, params, sessionId);
    });
  pointerCommands.set(webContents, current);
  try {
    return await current;
  } finally {
    if (pointerCommands.get(webContents) === current) pointerCommands.delete(webContents);
  }
};

/** Sends one command to the guest's page, keeping reloads and input inside it. */
export const sendPageCommand = async (
  webContents: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
  signal?: AbortSignal,
  protectHostInput = true,
): Promise<unknown> => {
  if (method === "T3.waitForHostInput") {
    return waitForHostInput(webContents.hostWebContents, params["timeoutMs"], signal);
  }
  if (method === "Input.dispatchMouseEvent" || method === "Input.dispatchTouchEvent") {
    return sendPointerCommand(
      webContents,
      debuggee,
      method,
      params,
      sessionId,
      signal,
      protectHostInput,
    );
  }
  if (sessionId !== undefined) return debuggee.sendCommand(method, params, sessionId);
  // Electron's debugger routes Page.reload on a webview to its embedder window.
  if (method === "Page.reload") {
    if (params["ignoreCache"] === true) webContents.reloadIgnoringCache();
    else webContents.reload();
    return {};
  }
  if (!FOCUS_ROUTED_INPUT.has(method) || webContents.focusedFrame) {
    return debuggee.sendCommand(method, params);
  }
  if ((await evaluate(debuggee, `${FOCUSED_DOCUMENT} !== null`)) !== true) {
    throw new Error(CROSS_SITE_FOCUS_MESSAGE);
  }
  switch (method) {
    case "Input.insertText":
      await webContents.insertText(typeof params["text"] === "string" ? params["text"] : "");
      return {};
    case "Input.dispatchKeyEvent": {
      for (const event of toKeyboardInputEvents(params)) webContents.sendInputEvent(event);
      const commands = Array.isArray(params["commands"])
        ? params["commands"].filter((command) => EDITING_COMMANDS.has(command))
        : [];
      // Runs after the page handles the keys, so the reply also waits for them.
      await evaluate(
        debuggee,
        `(() => { const doc = ${FOCUSED_DOCUMENT}; for (const name of ${JSON.stringify(commands)}) doc?.execCommand(name); return 0; })()`,
      );
      return {};
    }
    default:
      throw new Error(`${method} needs the preview to have focus.`);
  }
};
