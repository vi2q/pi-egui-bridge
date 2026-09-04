/**
 * Resolve hook: redirects `@earendil-works/pi-coding-agent` imports to the
 * local stub (test/pi-coding-agent-stub.mjs). Registered from mock-pi.mjs.
 */
const STUB = new URL("./pi-coding-agent-stub.mjs", import.meta.url).href;
const TARGET = "@earendil-works/pi-coding-agent";

export function resolve(specifier, context, nextResolve) {
  if (specifier === TARGET) {
    return { url: STUB, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
