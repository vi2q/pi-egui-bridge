# pi-egui-bridge

[pi](https://pi.dev) extension that lets the agent inspect and drive a live [egui](https://github.com/emilk/egui) application — click buttons, type into fields, read the UI tree, and take screenshots — over the [`egui_inspection`](https://crates.io/crates/egui_inspection) TCP protocol.

No MCP server or extra binary required: the extension speaks the wire protocol (length-prefixed MessagePack over TCP) directly.

## Install

```bash
pi install git:github.com/vi2q/pi-egui-bridge
```

Or try it without installing:

```bash
pi -e git:github.com/vi2q/pi-egui-bridge
```

## App-side setup

Your egui app must expose an inspection port. If it uses eframe, just enable the `inspection` feature:

```sh
EGUI_INSPECTION=1 cargo run --features inspection
```

If your app drives winit/egui directly (no eframe), register the plugin yourself:

```rust
#[cfg(feature = "inspection")]
egui_inspection::attach_from_env(ctx, Some("My App".to_owned()))?;
```

with `egui_inspection = { version = "0.36", optional = true, features = ["plugin", "png"] }` behind a cargo feature.

The port defaults to `127.0.0.1:5719`; `EGUI_INSPECTION=<addr>` overrides it. Unset or `0` means fully off.

## Tools

| Tool | Purpose |
|------|---------|
| `egui_attach` / `egui_status` / `egui_disconnect` | connection lifecycle |
| `egui_tree` | flattened AccessKit tree (role, label, value, bounds, children) |
| `egui_screenshot` | PNG capture, returned inline as an image |
| `egui_click` / `egui_hover` / `egui_scroll` | pointer interaction at logical-point coordinates |
| `egui_type` / `egui_key` | text input into the focused widget / key press |
| `egui_resize` / `egui_settle` / `egui_batch` | window resize / wait for idle / raw event batch |

## Usage

Start your app, then in pi:

> egui_attach して、UI ツリーを見せて
> 「New project」ボタンをクリックして、スクリーンショット撮って

Coordinates come from `egui_tree` bounds (logical points).

## Notes

- **The app window must be in the foreground** (at least on macOS) for tool calls to work reliably. A background window produces no GPU frames, so requests block until the 20 s inspection timeout ("app is not painting"). Bring the window to front, e.g. `osascript -e 'tell application "System Events" to set frontmost of application process "your-app" to true'`.
- Screenshots additionally require a visible (not occluded/minimized) window.
- The inspection port has no authentication — loopback only unless you know what you are doing.
- Node ID values exceed 2^53; they are stringified for stability.

## License

MIT
