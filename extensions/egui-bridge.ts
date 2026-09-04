/**
 * egui GUI inspection bridge for pi.
 *
 * Talks the egui_inspection wire protocol (length-prefixed MessagePack over
 * TCP, `eins` handshake) directly to a running azparam-agent-harness built
 * with `--features inspection` and launched with EGUI_INSPECTION=1.
 *
 * Tools registered:
 *   egui_attach / egui_status / egui_disconnect — connection lifecycle
 *   egui_tree      — flattened AccessKit tree (role, label, bounds, value)
 *   egui_screenshot — PNG capture, saved to a file and returned as image
 *   egui_click / egui_hover / egui_scroll — pointer interaction
 *   egui_type / egui_key — text input / key press
 *   egui_resize / egui_settle — window resize / wait for idle
 *   egui_batch     — multiple events in one frame
 */
import { Socket } from "node:net";
import { Type } from "typebox";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resizeImage, formatDimensionNote } from "@earendil-works/pi-coding-agent";

const PROTOCOL_MAGIC = Buffer.from("eins");
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
// Default per-request timeout: tools must not hang pi forever when the app
// stops responding (user request 2026-09-04).
const REQUEST_TIMEOUT_MS = 30_000;
// Valid egui_inspection request kinds (single-key tagged enum). Sending an
// unknown kind makes the server never answer, so the request hangs until the
// 30s timeout and desyncs the connection (root cause of the 2026-09-04
// egui_type_into outage). Validate eagerly instead.
const VALID_REQUEST_KINDS = new Set([
  "GetInfo",
  "GetTree",
  "GetScreenshot",
  "ApplyEvents",
  "Settle",
  "Resize",
]);
// Cumulative inline-image budget for the whole session (user instruction
// 2026-09-04): pi resends the full history every turn and provider request-body
// limits (e.g. 4.5 MiB) are byte-based, while pi's auto-compaction is
// token-based and never fires for image-heavy sessions. Once too many
// screenshots accumulate, every message fails with a 413 and the session is
// unrecoverable. Track total inline base64 bytes across egui_screenshot calls
// and stop inlining once the budget is exhausted (full PNGs stay on disk).
const INLINE_IMAGE_BUDGET_BYTES = 1_500_000;
let inlineImageBytesUsed = 0;
// Valid egui Key enum names (egui 0.36: letters + named keys). Unknown names
// are rejected before sending so a typo cannot produce a protocol error that
// never answers.
const VALID_EGUI_KEYS = new Set([
  "Escape",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Space",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  ...Array.from({ length: 20 }, (_, i) => `F${i + 1}`),
]);

// ---------------------------------------------------------------------------
// Minimal MessagePack encoder (msgpack is not a built-in)
// ---------------------------------------------------------------------------

function mpEncode(value) {
  const parts = [];
  encode(value);
  return Buffer.concat(parts);

  function encode(v) {
    if (v === null) return parts.push(Buffer.from([0xc0]));
    if (v === undefined) return parts.push(Buffer.from([0xc0]));
    if (v === true) return parts.push(Buffer.from([0xc3]));
    if (v === false) return parts.push(Buffer.from([0xc2]));
    if (typeof v === "number") return encodeNumber(v);
    if (typeof v === "string") return encodeString(v);
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return encodeBin(v);
    if (Array.isArray(v)) return encodeArray(v);
    // plain object (f64 buffers stay Buffers)
    return encodeMap(v);
  }

  function encodeNumber(n) {
    if (Number.isInteger(n)) {
      if (n >= 0) {
        if (n < 128) return parts.push(Buffer.from([n]));
        if (n <= 0xff) return parts.push(Buffer.from([0xcc, n]));
        if (n <= 0xffff)
          return parts.push(Buffer.from([0xcd, n >> 8, n & 0xff]));
        if (n <= 0xffffffff)
          return parts.push(
            Buffer.from([
              0xce,
              n >>> 24,
              (n >> 16) & 0xff,
              (n >> 8) & 0xff,
              n & 0xff,
            ]),
          );
        parts.push(Buffer.from([0xcf]), writeUInt64(n));
        return;
      }
      if (n >= -32) return parts.push(Buffer.from([n & 0xff]));
      if (n >= -128) return parts.push(Buffer.from([0xd0, n & 0xff]));
      if (n >= -32768)
        return parts.push(Buffer.from([0xd1, (n >> 8) & 0xff, n & 0xff]));
      if (n >= -2147483648)
        return parts.push(
          Buffer.from([
            0xd2,
            n >>> 24,
            (n >> 16) & 0xff,
            (n >> 8) & 0xff,
            n & 0xff,
          ]),
        );
      parts.push(Buffer.from([0xd3]), writeInt64(n));
      return;
    }
    const buf = Buffer.alloc(9);
    buf[0] = 0xcb;
    buf.writeDoubleBE(n, 1);
    parts.push(buf);
  }

  function encodeString(str) {
    const utf8 = Buffer.from(str, "utf8");
    const len = utf8.length;
    if (len < 32) parts.push(Buffer.from([0xa0 | len]));
    else if (len <= 0xff) parts.push(Buffer.from([0xd9, len]));
    else if (len <= 0xffff)
      parts.push(Buffer.from([0xda, len >> 8, len & 0xff]));
    else
      parts.push(
        Buffer.from([
          0xdb,
          len >>> 24,
          (len >> 16) & 0xff,
          (len >> 8) & 0xff,
          len & 0xff,
        ]),
      );
    parts.push(utf8);
  }

  function encodeBin(data) {
    const len = data.length;
    if (len <= 0xff) parts.push(Buffer.from([0xc4, len]));
    else if (len <= 0xffff)
      parts.push(Buffer.from([0xc5, len >> 8, len & 0xff]));
    else
      parts.push(
        Buffer.from([
          0xc6,
          len >>> 24,
          (len >> 16) & 0xff,
          (len >> 8) & 0xff,
          len & 0xff,
        ]),
      );
    parts.push(Buffer.from(data));
  }

  function encodeArray(arr) {
    const len = arr.length;
    if (len < 16) parts.push(Buffer.from([0x90 | len]));
    else if (len <= 0xffff)
      parts.push(Buffer.from([0xdc, len >> 8, len & 0xff]));
    else
      parts.push(
        Buffer.from([
          0xdd,
          len >>> 24,
          (len >> 16) & 0xff,
          (len >> 8) & 0xff,
          len & 0xff,
        ]),
      );
    for (const item of arr) encode(item);
  }

  function encodeMap(obj) {
    const keys = Object.keys(obj);
    const len = keys.length;
    if (len < 16) parts.push(Buffer.from([0x80 | len]));
    else if (len <= 0xffff)
      parts.push(Buffer.from([0xde, len >> 8, len & 0xff]));
    else
      parts.push(
        Buffer.from([
          0xdf,
          len >>> 24,
          (len >> 16) & 0xff,
          (len >> 8) & 0xff,
          len & 0xff,
        ]),
      );
    for (const key of keys) {
      encodeString(key);
      encode(obj[key]);
    }
  }

  function writeUInt64(n) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(n));
    return buf;
  }
  function writeInt64(n) {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(BigInt(n));
    return buf;
  }
}

// Minimal MessagePack decoder (streaming, buffer-based)
function mpDecode(buf, offset = 0) {
  const result = read();
  return [result, offset];

  function read() {
    const first = buf[offset++];
    if (first <= 0x7f) return first;
    if (first >= 0xe0) return first - 256;
    if ((first & 0xf0) === 0x80) return readMap(first & 0x0f);
    if ((first & 0xf0) === 0x90) return readArray(first & 0x0f);
    if ((first & 0xf0) === 0xa0 || (first & 0xf0) === 0xb0)
      return readStr(first & 0x1f, 0);
    switch (first) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return readBin(buf.readUInt8(offset), 1);
      case 0xc5:
        return readBin(buf.readUInt16BE(offset), 2);
      case 0xc6:
        return readBin(buf.readUInt32BE(offset), 4);
      case 0xca: {
        const f = buf.readFloatBE(offset);
        offset += 4;
        return f;
      }
      case 0xcb: {
        const d = buf.readDoubleBE(offset);
        offset += 8;
        return d;
      }
      case 0xcc:
        return buf.readUInt8(offset++);
      case 0xcd: {
        const v = buf.readUInt16BE(offset);
        offset += 2;
        return v;
      }
      case 0xce: {
        const v = buf.readUInt32BE(offset);
        offset += 4;
        return v;
      }
      case 0xcf: {
        const v = buf.readBigUInt64BE(offset);
        offset += 8;
        return Number(v);
      }
      case 0xd0: {
        const v = buf.readInt8(offset++);
        return v;
      }
      case 0xd1: {
        const v = buf.readInt16BE(offset);
        offset += 2;
        return v;
      }
      case 0xd2: {
        const v = buf.readInt32BE(offset);
        offset += 4;
        return v;
      }
      case 0xd3: {
        const v = buf.readBigInt64BE(offset);
        offset += 8;
        return Number(v);
      }
      case 0xd9:
        return readStr(buf.readUInt8(offset), 1);
      case 0xda: {
        const l = buf.readUInt16BE(offset);
        offset += 2;
        return readStr(l, 0);
      }
      case 0xdb: {
        const l = buf.readUInt32BE(offset);
        offset += 4;
        return readStr(l, 0);
      }
      case 0xdc: {
        const l = buf.readUInt16BE(offset);
        offset += 2;
        return readArray(l, 0);
      }
      case 0xdd: {
        const l = buf.readUInt32BE(offset);
        offset += 4;
        return readArray(l, 0);
      }
      case 0xde: {
        const l = buf.readUInt16BE(offset);
        offset += 2;
        return readMap(l, 0);
      }
      case 0xdf: {
        const l = buf.readUInt32BE(offset);
        offset += 4;
        return readMap(l, 0);
      }
      default:
        throw new Error(`unsupported msgpack byte 0x${first.toString(16)}`);
    }
  }

  function readBin(len, lenBytes) {
    offset += lenBytes;
    const d = buf.subarray(offset, offset + len);
    offset += len;
    return d;
  }
  function readStr(len, lenBytes) {
    if (lenBytes) offset += lenBytes;
    const s = buf.subarray(offset, offset + len).toString("utf8");
    offset += len;
    return s;
  }
  function readArray(len, lenBytes) {
    if (lenBytes) offset += lenBytes;
    const a = [];
    for (let i = 0; i < len; i++) a.push(read());
    return a;
  }
  function readMap(len, lenBytes) {
    if (lenBytes) offset += lenBytes;
    const m = {};
    for (let i = 0; i < len; i++) {
      const k = read();
      m[k] = read();
    }
    return m;
  }
}

// ---------------------------------------------------------------------------
// Inspection protocol client
// ---------------------------------------------------------------------------

class InspectionClient {
  constructor() {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.info = null;
  }

  static connect(host = "127.0.0.1", port = 5719, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const client = new InspectionClient();
      const socket = new Socket();
      client.socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error(`connect to ${host}:${port} timed out`));
        }
      }, timeoutMs);

      socket.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
      socket.on("data", (chunk) => client.onData(chunk));
      socket.on("close", () => {
        client.socket = null;
      });

      socket.connect(port, host, () => {
        // Server writes the 8-byte handshake first.
        client.expectHandshake = true;
      });
      client.onHandshake = (info) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          client.info = info;
          resolve(client);
        }
      };
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.expectHandshake) {
      if (this.buffer.length < 8) return;
      const head = this.buffer.subarray(0, 4);
      if (!head.equals(PROTOCOL_MAGIC))
        throw new Error(`bad protocol magic ${head}`);
      const version = this.buffer.readUInt32BE(4);
      this.buffer = this.buffer.subarray(8);
      this.expectHandshake = false;
      const cb = this.onHandshake;
      this.onHandshake = null;
      if (cb) cb({ protocolVersion: version });
      return;
    }
    // Frame loop
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (len > MAX_MESSAGE_BYTES) throw new Error(`frame too large: ${len}`);
      if (this.buffer.length < 4 + len) return;
      const body = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      const [message] = mpDecode(body, 0);
      const resolver = this.pending.shift();
      if (resolver) resolver(message);
    }
  }

  request(request, timeoutMs = REQUEST_TIMEOUT_MS) {
    const kind = typeof request === "string" ? request : Object.keys(request)[0];
    if (!VALID_REQUEST_KINDS.has(kind)) {
      return Promise.reject(
        new Error(
          `unknown request kind '${kind}' — valid kinds: ${[...VALID_REQUEST_KINDS].join(", ")} (this is an extension bug, not an app problem)`,
        ),
      );
    }
    if (!this.socket)
      return Promise.reject(
        new Error("not connected — call egui_attach first"),
      );
    return new Promise((resolve, reject) => {
      const body = mpEncode(request);
      const frame = Buffer.concat([Buffer.alloc(4), body]);
      frame.writeUInt32BE(body.length, 0);
      let settled = false;
      const wrapped = (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.pending.indexOf(wrapped);
        if (idx >= 0) this.pending.splice(idx, 1);
        // Destroy the socket: a late server response would otherwise resolve
        // the next request's resolver (FIFO desync) and poison the session.
        this.close();
        reject(
          new Error(
            `request timed out after ${timeoutMs}ms (socket closed; ${kind} will auto-reconnect on the next call)`,
          ),
        );
      }, timeoutMs);
      this.pending.push(wrapped);
      this.socket.write(frame, (err) => {
        if (err && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = Buffer.alloc(0);
  }
}

// ---------------------------------------------------------------------------
// Tree flattening
// ---------------------------------------------------------------------------

function unwrapResponse(response, toolName) {
  // Response variants: externally tagged maps like {Done: null}, {Info: {...}},
  // but bare unit variants like ApplyEvents' Done serialize as just a fixstr "Done".
  if (typeof response === "string") {
    if (response === "Done") return { done: true };
    throw new Error(`${toolName}: unexpected string response ${response}`);
  }
  // Response is a msgpack map with exactly one key: {Kind: payload}.
  const kind = Object.keys(response)[0];
  const payload = response[kind];
  switch (kind) {
    case "Error":
      throw new Error(`harness error: ${payload}`);
    case "Done":
      return { done: true };
    case "Settled":
      return payload;
    case "Info":
      return payload;
    case "Screenshot":
      return payload;
    case "Tree":
      return payload;
    default:
      throw new Error(`${toolName}: unexpected response kind ${kind}`);
  }
}

function flattenTree(treePayload) {
  const [step, pixelsPerPoint, accesskit] = treePayload;
  const nodesPart = accesskit?.[0] ?? [];
  const nodes = nodesPart.map(([id, node]) => {
    const [role, actions, _childActions, flags, props] = node;
    const out = { id: String(id), role };
    if (props?.label !== undefined) out.label = props.label;
    if (props?.value !== undefined) out.value = props.value;
    if (props?.children !== undefined)
      out.children = props.children.map(String);
    if (props?.bounds !== undefined) out.bounds = props.bounds; // [x0, y0, x1, y1] logical points
    if (props?.toggled !== undefined) out.toggled = props.toggled;
    if (props?.description !== undefined) out.description = props.description;
    if (flags) out.flags = flags;
    if (actions) out.actions = actions;
    return out;
  });
  return { step, pixelsPerPoint, nodes, count: nodes.length };
}

// --- Node query helpers (context-economy: filter instead of full dumps) ---

function nodeMatches(node, { role, label, at }) {
  if (role && !String(node.role ?? "").toLowerCase().includes(role.toLowerCase()))
    return false;
  if (label) {
    const hay = `${node.label ?? ""} ${node.value ?? ""}`.toLowerCase();
    if (!hay.includes(label.toLowerCase())) return false;
  }
  if (at) {
    // Defensive: pi may deliver array params as a JSON-encoded string
    // (observed with undeclared schema fields); parse instead of indexing
    // characters off a string.
    let point = at;
    if (typeof point === "string") {
      try {
        point = JSON.parse(point);
      } catch {
        return false;
      }
    }
    const b = node.bounds;
    if (!b || b.length !== 4 || !Array.isArray(point) || point.length < 2) return false;
    const [px, py] = [Number(point[0]), Number(point[1])];
    if (px < b[0] || px > b[2] || py < b[1] || py > b[3]) return false;
  }
  return true;
}

function filterNodes(nodes, filter) {
  return nodes.filter((node) => nodeMatches(node, filter));
}

function formatNodeCompact(node) {
  const parts = [String(node.role)];
  if (node.label !== undefined) parts.push(`label=${JSON.stringify(node.label)}`);
  if (node.value !== undefined) parts.push(`value=${JSON.stringify(node.value)}`);
  if (node.bounds) parts.push(`bounds=[${node.bounds.map((v) => Math.round(v * 10) / 10).join(",")}]`);
  if (node.toggled !== undefined) parts.push(`toggled=${node.toggled}`);
  return parts.join(" ");
}

async function fetchTree() {
  const c = await requireClient();
  const response = await c.request("GetTree");
  return flattenTree(unwrapResponse(response, "GetTree"));
}

function nodeCenter(node) {
  const b = node.bounds;
  return [Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2)];
}

// AccessKit node ids are regenerated every frame; this signature is the
// stable identity we can actually compare across tree snapshots.
function nodeSignature(node) {
  return [
    node.role,
    node.label ?? "",
    node.value ?? "",
    node.bounds ? node.bounds.map((v) => Math.round(v * 10) / 10).join(",") : "",
  ].join("|");
}

function pickNode(matches, index) {
  const pick = index < 0 ? matches.length + index : index;
  if (pick < 0 || pick >= matches.length) {
    throw new Error(
      `index ${index} out of range (${matches.length} matches). Matches:\n` +
        matches.map(formatNodeCompact).join("\n"),
    );
  }
  return matches[pick];
}

const locatorSchema = {
  role: Type.Optional(
    Type.String({ description: "Substring match on role (e.g. 'button', 'textInput')." }),
  ),
  label: Type.Optional(
    Type.String({
      description:
        "Substring match on label or value (case-insensitive).",
    }),
  ),
  at: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Only nodes whose bounds contain this [x, y] logical point.",
    }),
  ),
  index: Type.Optional(
    Type.Number({
      description:
        "Occurrence to use when several nodes match (0-based; negative counts from the end). Default 0.",
    }),
  ),
};

// ---------------------------------------------------------------------------
// Event builders (match egui Event serde representation)
// ---------------------------------------------------------------------------

const NO_MODS = {
  alt: false,
  ctrl: false,
  shift: false,
  mac_cmd: false,
  command: false,
};

function pointerMoved([x, y]) {
  return { PointerMoved: [x, y] };
}
function pointerButton([x, y], pressed) {
  return {
    PointerButton: {
      pos: [x, y],
      button: "Primary",
      pressed,
      modifiers: NO_MODS,
    },
  };
}
function mouseWheel(deltaX, deltaY, [x, y]) {
  // serde: MouseWheel { unit, delta, phase, modifiers }. egui semantics:
  // positive delta moves the viewed content down (i.e. scrolls up);
  // pass negative deltaY to scroll down.
  return {
    MouseWheel: {
      unit: "Point",
      delta: [deltaX, deltaY],
      phase: "Move",
      modifiers: NO_MODS,
    },
  };
}
function textEvent(text) {
  return { Text: text };
}
function keyEvent(key, pressed, mods = NO_MODS) {
  return { Key: { key, pressed, repeat: false, modifiers: mods } };
}
function keyEventsForEnter() {
  return [keyEvent("Enter", true), keyEvent("Enter", false)];
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

let client = null;

// Test hook: inject a stub client (see _test_setClient below).
globalThis.__eguiBridgeSetClient = (c) => { client = c; };
globalThis.__eguiBridgeGetClient = () => client;

// Test-only exports: the fake-server smoke test (test/smoke.mjs) speaks the
// same wire protocol and reuses the extension's MessagePack codec.
export { mpEncode as _mpEncode, mpDecode as _mpDecode };

// Last successful attach endpoint — used for one-shot auto-reconnect after a
// timed-out/closed connection, so a single hiccup no longer wedges the session
// behind a manual egui_attach.
let lastEndpoint = { host: "127.0.0.1", port: 5719 };

async function requireClient() {
  if (!client || !client.socket) {
    // One-shot auto-reconnect to the last known endpoint.
    try {
      client = await InspectionClient.connect(lastEndpoint.host, lastEndpoint.port, 3000);
      const info = await client.request("GetInfo", 5000);
      client.info = unwrapResponse(info, "egui_attach:auto-reconnect");
    } catch {
      throw new Error(
        `not connected and auto-reconnect to ${lastEndpoint.host}:${lastEndpoint.port} failed — run egui_attach (check that the harness window is running and in the foreground)`,
      );
    }
  }
  return client;
}

export default function (pi) {
  pi.registerTool({
    name: "egui_attach",
    label: "EGUI Attach",
    description:
      "Connect to the azparam-agent-harness egui inspection port. Launch the harness with `EGUI_INSPECTION=1 cargo run -p azparam-agent-harness --features inspection` first.",
    parameters: Type.Object({
      host: Type.Optional(
        Type.String({ description: "Host, default 127.0.0.1" }),
      ),
      port: Type.Optional(Type.Number({ description: "Port, default 5719" })),
      timeoutMs: Type.Optional(
        Type.Number({ description: "Connect timeout in ms, default 10000" }),
      ),
    }),
    async execute(_id, params) {
      if (client) client.close();
      client = await InspectionClient.connect(
        params.host ?? "127.0.0.1",
        params.port ?? 5719,
        params.timeoutMs ?? 10000,
      );
      lastEndpoint = { host: params.host ?? "127.0.0.1", port: params.port ?? 5719 };
      const info = await client.request("GetInfo");
      const unwrapped = unwrapResponse(info, "egui_attach");
      return {
        content: [
          { type: "text", text: `attached: ${JSON.stringify(unwrapped)}` },
        ],
        details: unwrapped,
      };
    },
  });

  pi.registerTool({
    name: "egui_status",
    label: "EGUI Status",
    description: "Check whether the egui inspection bridge is connected.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: client
              ? `connected (${client.info ? JSON.stringify(client.info) : "handshake pending"})`
              : "not connected",
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "egui_disconnect",
    label: "EGUI Disconnect",
    description: "Disconnect the egui inspection bridge.",
    parameters: Type.Object({}),
    async execute() {
      if (!client)
        return {
          content: [{ type: "text", text: "not connected" }],
          details: {},
        };
      client.close();
      client = null;
      return { content: [{ type: "text", text: "disconnected" }], details: {} };
    },
  });

  pi.registerTool({
    name: "egui_tree",
    label: "EGUI Tree",
    description:
      "Read the harness UI tree (AccessKit snapshot flattened: role, label, value, bounds, children). Bounds are logical points [x0,y0,x1,y1]. Supports filters (role / label substring / at point) and a compact one-line-per-node format — prefer filters over full dumps to save context.",
    parameters: Type.Object({
      ...locatorSchema,
      compact: Type.Optional(
        Type.Boolean({ description: "One line per node (default true). false = full JSON with ids/children." }),
      ),
    }),
    async execute(_id, params) {
      let tree = await fetchTree();
      const filter = { role: params.role, label: params.label, at: params.at };
      if (params.role || params.label || params.at) {
        tree = { ...tree, nodes: filterNodes(tree.nodes, filter), count: undefined };
        tree.count = tree.nodes.length;
      }
      if (params.compact === false) {
        return {
          content: [{ type: "text", text: JSON.stringify(tree, null, 1) }],
          details: tree,
        };
      }
      const lines = tree.nodes.map(formatNodeCompact);
      const text = `step=${tree.step} ppp=${tree.pixelsPerPoint} nodes=${lines.length}\n${lines.join("\n")}`;
      return { content: [{ type: "text", text }], details: { count: lines.length } };
    },
  });

  pi.registerTool({
    name: "egui_find",
    label: "EGUI Find",
    description:
      "Find nodes matching role/label/at filters and return them in compact form. Cheap alternative to egui_tree dumps.",
    parameters: Type.Object({
      ...locatorSchema,
    }),
    async execute(_id, params) {
      const tree = await fetchTree();
      const matches = filterNodes(tree.nodes, params);
      const text = matches.length
        ? `${matches.length} match(es):\n${matches.map(formatNodeCompact).join("\n")}`
        : "no matches";
      return { content: [{ type: "text", text }], details: { count: matches.length } };
    },
  });

  pi.registerTool({
    name: "egui_click_at",
    label: "EGUI Click At (locator)",
    description:
      "Find a node by role/label substring and click its center. Replaces manual egui_tree + egui_click coordinate math and is robust against layout shifts. Requires an attached, foreground app window.",
    parameters: Type.Object({
      ...locatorSchema,
      clickCount: Type.Optional(
        Type.Number({ description: "1=single (default), 2=double" }),
      ),
      settle: Type.Optional(
        Type.Boolean({ description: "Wait for the app to go idle after the click (default true)." }),
      ),
    }),
    async execute(_id, params) {
      const c = await requireClient();
      const tree = await fetchTree();
      const matches = filterNodes(tree.nodes, params);
      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `no node matches role=${params.role ?? ""} label=${params.label ?? ""}` }],
          details: { found: 0 },
        };
      }
      const node = pickNode(matches, params.index ?? 0);
      const [x, y] = nodeCenter(node);
      const clickCount = params.clickCount ?? 1;
      const events = [];
      for (let i = 1; i <= clickCount; i++) {
        events.push(pointerMoved([x, y]));
        events.push(pointerButton([x, y], true));
        events.push(pointerButton([x, y], false));
        if (i < clickCount) {
          // egui needs separate frames for press/release to register the
          // click_count on the second press.
          await c.request({ ApplyEvents: { events: [pointerMoved([x, y])] } });
        }
      }
      const response = await c.request({ ApplyEvents: { events } });
      unwrapResponse(response, "egui_click_at");
      if (params.settle !== false) {
        const settleResponse = await c.request({ Settle: { max_steps: 30 } }, 8000);
        unwrapResponse(settleResponse, "egui_click_at:Settle");
      }
      return {
        content: [
          {
            type: "text",
            text: `clicked (${x}, ${y}) x${clickCount} on ${formatNodeCompact(node)}`,
          },
        ],
        details: { node, x, y },
      };
    },
  });

  pi.registerTool({
    name: "egui_type_into",
    label: "EGUI Type Into (locator)",
    description:
      "Find a widget by role/label substring, click it, and type text into it. Works for textInput widgets (appends; use submit to commit) and DragValue/spinButton widgets (click opens the inline editor and replaces the value). `submit` presses Enter after typing.",
    parameters: Type.Object({
      ...locatorSchema,
      text: Type.String({ description: "Text to type into the focused widget." }),
      submit: Type.Optional(
        Type.Boolean({ description: "Press Enter after typing (commits DragValue edits). Default false." }),
      ),
    }),
    async execute(_id, params) {
      const c = await requireClient();
      const tree = await fetchTree();
      const matches = filterNodes(tree.nodes, params);
      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `no node matches role=${params.role ?? ""} label=${params.label ?? ""}` }],
          details: { found: 0 },
        };
      }
      const node = pickNode(matches, params.index ?? 0);
      const [x, y] = nodeCenter(node);
      const clickEvents = [pointerMoved([x, y]), pointerButton([x, y], true), pointerButton([x, y], false)];
      const clickResponse = await c.request({ ApplyEvents: { events: clickEvents } });
      unwrapResponse(clickResponse, "egui_type_into:click");
      await c.request({ Settle: { max_steps: 10 } }, 8000).then((r) => unwrapResponse(r, "egui_type_into:settle"));
      const typeEvents = [textEvent(params.text)];
      if (params.submit) typeEvents.push(...keyEventsForEnter());
      const typeResponse = await c.request({ ApplyEvents: { events: typeEvents } });
      unwrapResponse(typeResponse, "egui_type_into:type");
      const submitted = params.submit ? " + Enter" : "";
      await c.request({ Settle: { max_steps: 10 } }, 8000).then((r) => unwrapResponse(r, "egui_type_into:settle2"));
      return {
        content: [{ type: "text", text: `typed ${JSON.stringify(params.text)}${submitted} into ${formatNodeCompact(node)}` }],
        details: { node, x, y },
      };
    },
  });

  pi.registerTool({
    name: "egui_wait_for",
    label: "EGUI Wait For",
    description:
      "Poll the UI tree until a node matching role/label appears (or disappears with expect='absent'). Avoids manual click→settle→tree retry loops. Requires an attached app.",
    parameters: Type.Object({
      ...locatorSchema,
      expect: Type.Optional(
        Type.String({ description: "'present' (default) or 'absent'." }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({ description: "Overall timeout in ms (default 5000)." }),
      ),
      intervalMs: Type.Optional(
        Type.Number({ description: "Poll interval in ms (default 250)." }),
      ),
      onlyNew: Type.Optional(
        Type.Boolean({
                  description:
                        "For expect='present': only report nodes that did NOT exist in the first snapshot (ignore pre-existing matches).",
        }),
      ),
}),
async execute(_id, params) {
      const c = await requireClient();
      const expectAbsent = params.expect === "absent";
      const deadline = Date.now() + (params.timeoutMs ?? 5000);
      const interval = params.intervalMs ?? 250;
      let lastError = "";
      let baselineSignatures = null;
      if (params.onlyNew && !expectAbsent) {
        try {
                  const initial = await fetchTree();
                  // AccessKit node ids are regenerated every frame, so compare by
                  // (role, label, value, bounds) signature instead.
                  baselineSignatures = new Set(initial.nodes.map(nodeSignature));
        } catch (error) {
                  lastError = String(error);
        }
      }
      for (;;) {
        let tree;
        try {
          tree = await fetchTree();
        } catch (error) {
          lastError = String(error);
        }
        if (tree) {
          let matches = filterNodes(tree.nodes, params);
          if (baselineSignatures) {
            matches = matches.filter((n) => !baselineSignatures.has(nodeSignature(n)));
          }
          const satisfied = expectAbsent ? matches.length === 0 : matches.length > 0;
          if (satisfied) {
            const elapsed = Date.now() - (deadline - (params.timeoutMs ?? 5000));
            const text = expectAbsent
              ? `condition met (absent) after ${elapsed} ms`
              : `matched after ${elapsed} ms${baselineSignatures ? " (new node)" : ""}:\n${matches.map(formatNodeCompact).join("\n")}`;
            return { content: [{ type: "text", text }], details: { count: matches.length } };
          }
        }
        if (Date.now() >= deadline) {
          return {
            content: [
              {
                type: "text",
                text: `timeout after ${params.timeoutMs ?? 5000} ms waiting for role=${params.role ?? ""} label=${params.label ?? ""} to become ${expectAbsent ? "absent" : "present"}${lastError ? ` (last error: ${lastError})` : ""}`,
              },
            ],
            details: { matched: false },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    },
  });

  pi.registerTool({
    name: "egui_screenshot",
    label: "EGUI Screenshot",
    description:
      "Capture the harness window as PNG (saved to a file) and return a compressed inline copy for viewing (subject to a cumulative session inline-image budget; once exhausted, only the file is saved — start a new session to reset). The window must be visible (not fully occluded/minimized). Avoid the read tool on the saved full-resolution PNG: inlining it at original size can exceed provider request-body limits and kill the session.",
    parameters: Type.Object({
      outputPath: Type.Optional(
        Type.String({
          description:
            "Optional output file path (default /tmp/egui_harness_<ts>.png)",
        }),
      ),
    }),
    async execute(_id, params) {
      const c = await requireClient();
      const response = await c.request({
        GetScreenshot: { pixels_per_point: null },
      });
      const payload = unwrapResponse(response, "egui_screenshot");
      // payload: [size, bytes] (msgpack struct as list) or {size, bytes}
      const size = Array.isArray(payload) ? payload[0] : payload.size;
      const bytes = Array.isArray(payload) ? payload[1] : payload.bytes;
      const raw = Buffer.from(bytes);
      const path =
        params.outputPath ?? join(tmpdir(), `egui_harness_${Date.now()}.png`);
      writeFileSync(path, raw);
      const text = `saved ${size[0]}x${size[1]} PNG to ${path}`;
      // Full-resolution PNGs (e.g. 1440x900+ windows) base64 to several MiB and
      // can exceed provider request-body limits (e.g. 4.5 MiB), killing the
      // session. Inline a compressed copy instead; the full PNG stays on disk.
      let image = null;
      let dims = "";
      let omittedReason = "";
      if (inlineImageBytesUsed >= INLINE_IMAGE_BUDGET_BYTES) {
        // Session budget exhausted: file-only result. Keep the wording away
        // from "read the file" — inlining the full PNG re-inflates the
        // request body and is what killed sessions before v0.2.2.
        omittedReason = ` Inline image omitted: session inline-image budget exhausted (${Math.round(inlineImageBytesUsed / 1000)} kB used of ${Math.round(INLINE_IMAGE_BUDGET_BYTES / 1000)} kB). Start a new session to reset it, or inspect the UI via egui_tree instead.`;
      } else {
        try {
          const resized = await resizeImage(raw, "image/png", {
            maxWidth: 1280,
            maxHeight: 1280,
            maxBytes: 250_000,
            jpegQuality: 75,
          });
          if (resized) {
            image = {
              type: "image",
              data: resized.data,
              mimeType: resized.mimeType,
            };
            inlineImageBytesUsed += resized.data.length;
            const note = formatDimensionNote(resized);
            if (note) dims = `\n${note}`;
            dims += `\n(session inline-image budget: ${Math.round(inlineImageBytesUsed / 1000)}/${Math.round(INLINE_IMAGE_BUDGET_BYTES / 1000)} kB used)`;
          } else {
            omittedReason = " Inline image omitted (compression failed).";
          }
        } catch {
          // fall through: file-only result
          omittedReason = " Inline image omitted (compression failed).";
        }
      }
      return {
        content: image
          ? [
              { type: "text", text: text + dims },
              image,
            ]
          : [
              {
                type: "text",
                // Do NOT suggest the read tool on `path`: reading the full-
                // resolution PNG inlines it at original size (several MiB for
                // 1440x900 windows) and can exceed provider request-body
                // limits, killing the session (root cause of the 2026-09-04
                // 413 failures alongside screenshot accumulation).
                text: `${text}.${omittedReason} To view the screen, run egui_screenshot again (a fresh capture may compress better), or inspect structure via egui_tree.`,
              },
            ],
        details: { path, size },
      };
    },
  });

  const pointerXY = {
    x: Type.Number({
      description: "X in logical points (from egui_tree bounds)",
    }),
    y: Type.Number({ description: "Y in logical points" }),
  };

  pi.registerTool({
    name: "egui_click",
    label: "EGUI Click",
    description:
      "Click the primary mouse button at the given position (logical points). Use egui_tree bounds to find targets.",
    parameters: Type.Object({
      ...pointerXY,
      clickCount: Type.Optional(
        Type.Number({ description: "1=single (default), 2=double" }),
      ),
    }),
    async execute(_id, params) {
      const c = await requireClient();
      const clickCount = params.clickCount ?? 1;
      const events = [];
      for (let i = 1; i <= clickCount; i++) {
        events.push(pointerMoved([params.x, params.y]));
        events.push(pointerButton([params.x, params.y], true));
        events.push(pointerButton([params.x, params.y], false));
      }
      const response = await c.request({ ApplyEvents: { events } });
      unwrapResponse(response, "egui_click");
      return {
        content: [
          {
            type: "text",
            text: `clicked (${params.x}, ${params.y}) x${clickCount}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "egui_hover",
    label: "EGUI Hover",
    description: "Move the pointer to the given position without clicking.",
    parameters: Type.Object({ ...pointerXY }),
    async execute(_id, params) {
      const c = await requireClient();
      const response = await c.request({
        ApplyEvents: { events: [pointerMoved([params.x, params.y])] },
      });
      unwrapResponse(response, "egui_hover");
      return {
        content: [{ type: "text", text: `hovered (${params.x}, ${params.y})` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "egui_scroll",
    label: "EGUI Scroll",
    description:
      "Scroll at the given position. Positive deltaY scrolls up (content moves down); use negative deltaY to scroll down. Units are egui points.",
    parameters: Type.Object({
      ...pointerXY,
      deltaX: Type.Optional(
        Type.Number({ description: "Horizontal delta (default 0)" }),
      ),
      deltaY: Type.Optional(
        Type.Number({
          description:
            "Vertical delta in points; negative scrolls down (default -40 ≈ 2 lines down)",
        }),
      ),
    }),
    async execute(_id, params) {
      const c = await requireClient();
      const events = [
        pointerMoved([params.x, params.y]),
        mouseWheel(params.deltaX ?? 0, params.deltaY ?? -40, [
          params.x,
          params.y,
        ]),
      ];
      const response = await c.request({ ApplyEvents: { events } });
      unwrapResponse(response, "egui_scroll");
      return {
        content: [
          {
            type: "text",
            text: `scrolled (${params.deltaX ?? 0}, ${params.deltaY ?? 1}) at (${params.x}, ${params.y})`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "egui_type",
    label: "EGUI Type",
    description:
      "Type text into the currently focused widget (click a text field first).",
    parameters: Type.Object({
      text: Type.String({ description: "Text to type" }),
    }),
    async execute(_id, params) {
      const c = await requireClient();
      const events = [textEvent(params.text)];
      const response = await c.request({ ApplyEvents: { events } });
      unwrapResponse(response, "egui_type");
      return {
        content: [{ type: "text", text: `typed ${params.text.length} chars` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "egui_key",
    label: "EGUI Key",
    description:
      "Press or release a key (e.g. 'Enter', 'Escape', 'ArrowDown'). Named per egui Key enum (camelCase like 'ArrowDown').",
    parameters: Type.Object({
      key: Type.String({
        description: "egui Key name, e.g. Enter, Escape, ArrowDown, A",
      }),
      pressed: Type.Optional(
        Type.Boolean({ description: "true=press (default), false=release" }),
      ),
    }),
    async execute(_id, params) {
      const c = await requireClient();
      const pressed = params.pressed ?? true;
      if (!VALID_EGUI_KEYS.has(params.key)) {
        throw new Error(
          `unknown egui key '${params.key}' — use camelCase egui Key names (e.g. Enter, Escape, ArrowDown, A)`,
        );
      }
      const response = await c.request({
        ApplyEvents: { events: [keyEvent(params.key, pressed)] },
      });
      unwrapResponse(response, "egui_key");
      return {
        content: [
          {
            type: "text",
            text: `${pressed ? "pressed" : "released"} ${params.key}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "egui_resize",
    label: "EGUI Resize",
    description: "Resize the harness window to the given logical size.",
    parameters: Type.Object({
      width: Type.Number({ description: "Width in logical points" }),
      height: Type.Number({ description: "Height in logical points" }),
    }),
    async execute(_id, params) {
      const c = await requireClient();
      const response = await c.request({
        Resize: {
          width: Math.round(params.width),
          height: Math.round(params.height),
        },
      });
      unwrapResponse(response, "egui_resize");
      return {
        content: [
          { type: "text", text: `resized to ${params.width}x${params.height}` },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "egui_settle",
    label: "EGUI Settle",
    description: "Wait until the app goes idle (async UI updates flushed).",
    parameters: Type.Object({
      maxSteps: Type.Optional(
        Type.Number({ description: "Max frames to wait (default 30)" }),
      ),
    }),
    async execute(_id, params) {
      const c = await requireClient();
      const response = await c.request({
        Settle: { max_steps: params.maxSteps ?? 30 },
      });
      const payload = unwrapResponse(response, "egui_settle");
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: payload,
      };
    },
  });

  pi.registerTool({
    name: "egui_drag",
    label: "EGUI Drag",
    description:
      "Drag from [x1,y1] to [x2,y2] in logical points (for splitters, sliders, drag handles). Sends press, then per-step move, then release as separate frames so egui's drag state machine engages. Each step is 10 points.",
    parameters: Type.Object({
      x1: Type.Number({ description: "Start X (on the drag handle)" }),
      y1: Type.Number({ description: "Start Y (on the drag handle)" }),
      x2: Type.Number({ description: "End X" }),
      y2: Type.Number({ description: "End Y" }),
      steps: Type.Optional(
        Type.Number({ description: "Number of move frames (default 10)" }),
      ),
      stepDelayMs: Type.Optional(
        Type.Number({ description: "Delay between frames in ms (default 120)" }),
      ),
    }),
    async execute(_id, params) {
      const c = await requireClient();
      const steps = params.steps ?? 10;
      const delay = params.stepDelayMs ?? 120;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // Frame 1: move + press.
      await c.request({
        ApplyEvents: {
          events: [
            pointerMoved([params.x1, params.y1]),
            pointerButton([params.x1, params.y1], true),
          ],
        },
      });
      await sleep(delay);
      // Move frames: one event per frame.
      for (let i = 1; i <= steps; i++) {
        const x = params.x1 + ((params.x2 - params.x1) * i) / steps;
        const y = params.y1 + ((params.y2 - params.y1) * i) / steps;
        await c.request({
          ApplyEvents: { events: [pointerMoved([x, y])] },
        });
        await sleep(delay);
      }
      // Release frame.
      const response = await c.request({
        ApplyEvents: {
          events: [pointerButton([params.x2, params.y2], false)],
        },
      });
      unwrapResponse(response, "egui_drag");
      return {
        content: [
          {
            type: "text",
            text: `dragged (${params.x1}, ${params.y1}) -> (${params.x2}, ${params.y2})`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "egui_batch",
    label: "EGUI Batch",
    description: "Send multiple raw egui events in a single frame (advanced).",
    parameters: Type.Object({
      events: Type.Array(Type.Unknown(), {
        description: "Raw egui Event objects (serde form)",
      }),
    }),
    async execute(_id, params) {
      const c = await requireClient();
      const response = await c.request({
        ApplyEvents: { events: params.events },
      });
      unwrapResponse(response, "egui_batch");
      return {
        content: [
          { type: "text", text: `applied ${params.events.length} events` },
        ],
        details: {},
      };
    },
  });

  pi.on("session_start", async () => {
    // Nothing yet; connection is lazy via egui_attach.
  });
}
