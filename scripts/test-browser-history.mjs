import assert from "node:assert/strict";
import { appendBrowserHistory } from "../src/services/browserHistory.ts";

let state = appendBrowserHistory(["https://a.test", "https://b.test"], 1, "https://c.test");
assert.deepEqual(state, { entries: ["https://a.test", "https://b.test", "https://c.test"], index: 2 });
state = appendBrowserHistory(state.entries, 0, "https://d.test");
assert.deepEqual(state, { entries: ["https://a.test", "https://d.test"], index: 1 });
assert.deepEqual(appendBrowserHistory(state.entries, state.index, "https://d.test"), state);
console.log("browser history tests passed");
