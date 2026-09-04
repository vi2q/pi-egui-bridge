/**
 * Integration smoke test for the egui-bridge extension.
 *
 * Runs a FAKE egui_inspection TCP server that speaks the real wire protocol
 * (8-byte `eins` handshake, length-prefixed MessagePack frames) and STRICTLY
 * validates request kinds — the 2026-09-04 egui_type_into outage (a request
 * kind that does not exist → 30s hang → connection desync) was invisible to
 * permissive mock stubs. This server rejects unknown kinds with an Error
 * response, and the test fails if any tool ever sends one.
 *
 * Run: npm test  (node --experimental-strip-types test/smoke.mjs)
 */
import { createServer } from "node:net";
import mod, { _mpEncode, _mpDecode } from "../extensions/egui-bridge.ts";

const PORT = 5799;
const MAGIC = Buffer.from("eins");

// --- strict request kind registry (mirrors VALID_REQUEST_KINDS + server) ---
const SERVER_KNOWN_KINDS = new Set([
  "GetInfo",
  "GetTree",
  "GetScreenshot",
  "ApplyEvents",
  "Settle",
  "Resize",
]);
const violations = [];
let seenKinds = new Set();

// --- fake server ---
const cannedTree = [
  42,
  1,
  [
    [
      ["111", ["window", 0, [], null, { children: ["a1", "b1", "c1", "d1"] }]],
      ["a1", ["button", 3, [], null, { label: "Ground", bounds: [1006, 304, 1098, 336] }]],
      ["b1", ["button", 3, [], null, { label: "Hierarchy", bounds: [1096, 94, 1161, 122] }]],
      ["c1", ["spinButton", 0, [], null, { value: "4.0", bounds: [1280, 166, 1318, 194] }]],
      ["d1", ["button", 3, [], null, { label: "Inspector", bounds: [1195, 94, 1260, 122] }]],
    ],
  ],
];

function handleRequest(request) {
  const kind = typeof request === "string" ? request : Object.keys(request)[0];
  seenKinds.add(kind);
  if (!SERVER_KNOWN_KINDS.has(kind)) {
    violations.push(`tool sent UNKNOWN request kind: ${kind}`);
    return { Error: `unknown request kind: ${kind}` };
  }
  switch (kind) {
    case "GetInfo":
      return { Info: { protocolVersion: 1 } };
    case "GetTree":
      return { Tree: cannedTree };
    case "Settle":
      return { Settled: 2 };
    case "GetScreenshot":
      return { Screenshot: [[1440, 900], [137, 80, 78, 71]] };
    case "Resize":
      return { Done: true };
    case "ApplyEvents": {
      // Validate the events payload is an object array (catches invented
      // event shapes too).
      const events = request.ApplyEvents?.events;
      if (!Array.isArray(events)) {
        violations.push(`ApplyEvents.events is not an array: ${JSON.stringify(events)?.slice(0, 80)}`);
        return { Error: "ApplyEvents.events must be an array" };
      }
      for (const ev of events) {
        const k = Object.keys(ev)[0];
        if (!["PointerMoved", "PointerButton", "MouseWheel", "Text", "Key", "WindowFocused"].includes(k)) {
          violations.push(`unknown event kind in ApplyEvents: ${k}`);
          return { Error: `unknown event kind: ${k}` };
        }
      }
      return { Done: true };
    }
    default:
      violations.push(`unhandled known kind: ${kind}`);
      return { Error: "not implemented in fake server" };
  }
}

let buffer = Buffer.alloc(0);
const server = createServer((socket) => {
  socket.write(Buffer.concat([MAGIC, (() => { const v = Buffer.alloc(4); v.writeUInt32BE(1); return v; })()]));
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const len = buffer.readUInt32BE(0);
      if (buffer.length < 4 + len) return;
      const body = buffer.subarray(4, 4 + len);
      buffer = buffer.subarray(4 + len);
      let request;
      try {
        [request] = _mpDecode(body, 0);
      } catch (e) {
        violations.push(`server failed to decode request frame: ${e}`);
        continue;
      }
      socket.write(frame(handleRequest(request)));
    }
  });
});

function frame(body) {
  const encoded = _mpEncode(body);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(encoded.length, 0);
  return Buffer.concat([head, encoded]);
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function assert(cond, message) {
  if (!cond) fail(message);
}

// --- run the tools against the fake server ---
const registry = {};
mod({ registerTool: (t) => { registry[t.name] = t; }, on: () => {} });

server.listen(PORT, "127.0.0.1", async () => {
  // Hard deadline so a hang can never wedge CI/session.
  const abortTimer = setTimeout(() => {
    console.error(`TIMEOUT: smoke test did not finish in 20s; kinds seen so far: ${[...seenKinds].join(",") || "(none)"}`);
    for (const v of violations) console.error(`violation: ${v}`);
    process.exit(2);
  }, 20000);
  try {
    // attach
    const attached = await registry.egui_attach.execute("t1", { port: PORT, timeoutMs: 3000 });
    assert(String(attached.content[0].text).includes("attached"), "egui_attach should report attached");

    // egui_tree compact + filters
    const tree = await registry.egui_tree.execute("t2", { label: "ground" });
    assert(tree.content[0].text.includes('label="Ground"'), "egui_tree filter should match Ground");
    const verbose = await registry.egui_tree.execute("t3", { compact: false });
    assert(/"count": \d+/.test(verbose.content[0].text), "egui_tree verbose should report a node count");

    // egui_find
    const found = await registry.egui_find.execute("t4", { role: "spin" });
    assert(found.content[0].text.includes("spinButton"), "egui_find should find the spinButton");

    // egui_click_at (regression: locator center math)
    const clicked = await registry.egui_click_at.execute("t5", { label: "Ground", settle: false });
    assert(clicked.content[0].text.includes("(1052, 320)"), `click center should be (1052, 320), got: ${clicked.content[0].text}`);

    // egui_click_at verify option (act + re-check in one call)
    const verified = await registry.egui_click_at.execute("t5b", { label: "Ground", settle: false, verify: true });
    assert(verified.content[0].text.includes("verified after click: button label=\"Ground\""), `verify should re-report the node: ${verified.content[0].text}`);

    // egui_type_into (regression: must use ApplyEvents, not ApplyText)
    const typed = await registry.egui_type_into.execute("t6", { role: "spinButton", text: "7.0", submit: true });
    assert(typed.content[0].text.includes('typed "7.0" + Enter'), "egui_type_into should type with Enter");

    // egui_wait_for present / absent
    const wait = await registry.egui_wait_for.execute("t7", { label: "Ground", timeoutMs: 1000, intervalMs: 50 });
    assert(wait.content[0].text.includes("matched"), "egui_wait_for should match");
    const waitAbsent = await registry.egui_wait_for.execute("t8", { label: "Nonexistent", expect: "absent", timeoutMs: 500, intervalMs: 50 });
    assert(waitAbsent.content[0].text.includes("condition met (absent)"), "egui_wait_for absent should pass");

    // egui_screenshot (exercises the Screenshot request kind)
    const shot = await registry.egui_screenshot.execute("t9", { outputPath: "/tmp/egui_bridge_smoke.png" });
    assert(shot.content[0].text.includes("saved"), "egui_screenshot should save a file");

    // unknown kind must fail fast client-side
    let rejected = false;
    try {
      const c = globalThis.__eguiBridgeGetClient?.();
      await c.request({ ApplyText: { text: "x" } });
    } catch (e) {
      rejected = String(e).includes("unknown request kind");
    }
    assert(rejected, "request() should reject unknown kinds immediately (ApplyText regression)");

    if (violations.length > 0) {
      for (const v of violations) fail(v);
    } else {
      console.log(`smoke OK: ${[...seenKinds].sort().join(", ")}`);
    }
  } catch (e) {
    fail(e?.stack || String(e));
  } finally {
    clearTimeout(abortTimer);
    // Tear down the client socket, otherwise the open connection keeps the
    // event loop alive and the test never exits (observed as an endless run).
    try {
      await registry.egui_disconnect.execute("tx", {});
    } catch {}
    server.closeAllConnections?.();
    server.close();
    process.exit(process.exitCode ?? 0);
  }
});
