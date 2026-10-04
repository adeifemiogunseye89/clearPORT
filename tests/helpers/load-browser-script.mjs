// Loads a plain, non-module browser script — one loaded via
// <script src> in production, deliberately NOT an ES module, to keep
// this app's no-build-step architecture — into an isolated VM
// context, and returns that context's globals.
//
// This tests the REAL shipped file directly, not a hand-copied mirror
// of its logic. The only reason this exists at all is that classic
// <script> files attach their top-level functions to the global
// object rather than exporting them — vm.runInContext reproduces
// exactly that behavior in an isolated sandbox, so a passing test is
// a genuine guarantee about the file the browser actually loads.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadBrowserScript(path, extraGlobals = {}) {
  const code = readFileSync(path, 'utf8');
  const context = {
    console,
    window: { addEventListener: () => {} },
    document: {
      createElement: () => ({}),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    navigator: {
      onLine: true,
      serviceWorker: { register: () => Promise.resolve() }, // a real Promise — .catch() on the caller's side just never fires
      clipboard: undefined,
    },
    ...extraGlobals,
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: String(path) });
  return context;
}
