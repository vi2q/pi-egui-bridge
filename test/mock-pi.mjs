/**
 * Loader hook for the smoke test: maps the pi peer dependency
 * (`@earendil-works/pi-coding-agent`) to a local stub so the test does not
 * depend on the globally installed pi package (pi 0.85.0 no longer resolves
 * standalone: dist/index.js pulls dist/experimental/server.js which requires
 * @earendil-works/pi-server, absent outside the pi runtime).
 *
 * Usage: node --experimental-strip-types --import ./test/mock-pi.mjs test/smoke.mjs
 */
import { register } from "node:module";

register(
  new URL("./pi-coding-agent-resolve.mjs", import.meta.url).href,
  new URL(".", import.meta.url).href,
);
