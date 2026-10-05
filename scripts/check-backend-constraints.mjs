#!/usr/bin/env node
/**
 * Backend constraint guard for src-tauri/.
 *
 * Baseline mode: only NEW violations fail the check, so the guard is safe to
 * land on an existing codebase without blocking unrelated work.
 *
 *   node scripts/check-backend-constraints.mjs                 # check
 *   node scripts/check-backend-constraints.mjs --report        # distribution only
 *   node scripts/check-backend-constraints.mjs --update-baseline
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "scripts", "backend-constraints-baseline.json");
const RUST_DIR = join(ROOT, "src-tauri");

const args = process.argv.slice(2);
const REPORT_ONLY = args.includes("--report");
const UPDATE_BASELINE = args.includes("--update-baseline");
const SELF_TEST = args.includes("--self-test");

function isNumericDurationLiteral(line) {
  return /Duration::from_(?:secs|millis)\(\s*\d[\d_]*(?:\s*(?:u|i)\d+)?\s*\)/.test(line);
}

if (SELF_TEST) {
  assert.equal(isNumericDurationLiteral("Duration::from_secs(30)"), true);
  assert.equal(isNumericDurationLiteral("Duration::from_millis(1_000)"), true);
  assert.equal(isNumericDurationLiteral("Duration::from_millis(timeout_ms)"), false);
  assert.equal(isNumericDurationLiteral("Duration::from_secs(24 * 60 * 60)"), false);
  console.log("backend constraint rule tests passed");
  process.exit(0);
}

/** Collect .rs files, skipping build output. */
function rustFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "target" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) rustFiles(p, acc);
    else if (entry.name.endsWith(".rs")) acc.push(p);
  }
  return acc;
}

const files = rustFiles(RUST_DIR);

/**
 * Files whose entire body is test code.
 *
 * `productionOnly()` strips an in-file `#[cfg(test)] mod tests` block, but that
 * only works for unit tests. Cargo integration tests under `tests/` have no
 * such marker — every line is test code, so `unwrap()` there is idiomatic and
 * must not be reported as a production violation.
 */
const TEST_ONLY_FILES = new Set(
  files
    .map((f) => f.replace(ROOT + "/", ""))
    .filter((f) => f.includes("/tests/") || f.endsWith("/tests.rs"))
);

const sources = new Map(
  files
    .map((f) => [f.replace(ROOT + "/", ""), readFileSync(f, "utf8")])
    .filter(([f]) => !TEST_ONLY_FILES.has(f))
);

/** Strip `#[cfg(test)] mod tests { ... }` so test code never trips production rules. */
function productionOnly(text) {
  const marker = text.indexOf("#[cfg(test)]");
  return marker === -1 ? text : text.slice(0, marker);
}

const violations = {};

function record(rule, file, line, detail) {
  if (!violations[rule]) violations[rule] = [];
  violations[rule].push({ file, line, detail });
}

// ── Rule 1: timeout literals outside the constants block ──────────────
for (const [file, raw] of sources) {
  const text = productionOnly(raw);
  const lines = text.split("\n");
  let inConstants = true;
  lines.forEach((line, i) => {
    if (/^const\s+\w+/.test(line)) inConstants = true;
    if (/^(pub\s+)?(async\s+)?fn\s/.test(line)) inConstants = false;
    if (inConstants) return;
    if (isNumericDurationLiteral(line) && !/^\s*\/\//.test(line)) {
      record("timeout-literal", file, i + 1, line.trim().slice(0, 80));
    }
  });
}

// ── Rule 2: polling loops (loop block containing sleep) ───────────────
// Matches `tokio::sleep` / `std::thread::sleep` / `time::sleep`, not just
// `.sleep(` — Rust paths use `::`, so a `\.sleep\(` pattern silently never
// matches real async code.
const SLEEP_RE = /(?:::|\.)sleep\s*\(/;
for (const [file, raw] of sources) {
  const text = productionOnly(raw);
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (/\bloop\s*\{/.test(line)) {
      const window = lines.slice(i, i + 8).join("\n");
      if (SLEEP_RE.test(window)) {
        record("polling-loop", file, i + 1, line.trim().slice(0, 80));
      }
    }
  });
}

// ── Rule 3: extension allow-list logic spread across functions ────────
// Matches both `ensure_*_extension` and `ensure_allowed_*_write_path`, since
// the latter are the same kind of allow-list check under a different name.
for (const [file, raw] of sources) {
  productionOnly(raw)
    .split("\n")
    .forEach((line, i) => {
      const isAllowListFn =
        (/fn\s+ensure_\w*extension\w*\s*\(/.test(line) &&
          !/fn\s+ensure_extension_allowed\s*\(/.test(line)) ||
        /fn\s+ensure_allowed_\w+_path\s*\(/.test(line);
      if (isAllowListFn) {
        record("extension-family", file, i + 1, line.trim().slice(0, 80));
      }
    });
}

// ── Rule 4: oversized files ───────────────────────────────────────────
const MAX_LINES = 1200;
for (const [file, raw] of sources) {
  const count = raw.split("\n").length;
  if (count > MAX_LINES) {
    record("oversized-file", file, 0, `${count} lines > ${MAX_LINES}`);
  }
}

// ── Rule 5: duplicated streaming-body chunk loops ─────────────────────
// Max 2 per file: one inside the shared capped-read helper, one in the
// stream-to-disk path (which deliberately buffers only a 1 KiB header
// prefix). A third means another hand-rolled copy appeared.
for (const [file, raw] of sources) {
  const count = (productionOnly(raw).match(/\.chunk\(\)/g) || []).length;
  if (count > 2) {
    record("chunk-loop", file, 0, `${count} occurrences (max 2: helper + streaming-to-disk)`);
  }
}

// ── Rule 6: hand-written header parsing ───────────────────────────────
for (const [file, raw] of sources) {
  productionOnly(raw)
    .split("\n")
    .forEach((line, i) => {
      if (/split_once\('='\)|split\(';\'\)/.test(line)) {
        record("handwritten-header-parse", file, i + 1, line.trim().slice(0, 80));
      }
    });
}

// ── Rule 7: unwrap/expect in production code ──────────────────────────
// Excluded: the `main()` bootstrap in main.rs — `.expect("error while running
// tauri application")` on `Builder::run` is the idiomatic and only sensible
// place to abort a Tauri app, and it cannot be handled gracefully anyway.
for (const [file, raw] of sources) {
  productionOnly(raw)
    .split("\n")
    .forEach((line, i) => {
      const isBootstrapExpect =
        file === "src-tauri/src/main.rs" && /\.expect\("error while running tauri application"\)/.test(line);
      if ((/\.unwrap\(\)|\.expect\(/.test(line) && !/^\s*\/\//.test(line)) && !isBootstrapExpect) {
        record("production-unwrap", file, i + 1, line.trim().slice(0, 80));
      }
    });
}

// ── Rule 8: IPC contract drift ────────────────────────────────────────
{
  const cmdSrc = sources.get("src-tauri/src/tauri_commands.rs") || "";
  const declared = [...cmdSrc.matchAll(/#\[tauri::command\][\s\S]{0,200}?fn\s+(\w+)/g)].map(
    (m) => m[1]
  );
  const mainSrc = sources.get("src-tauri/src/main.rs") || "";
  const block = mainSrc.match(/generate_handler!\[([\s\S]*?)\]\)/);
  const registered = block
    ? [...block[1].matchAll(/tauri_commands::(\w+)/g)].map((m) => m[1])
    : [];
  for (const name of declared) {
    if (!registered.includes(name)) {
      record("ipc-drift", "src-tauri/src/main.rs", 0, `declared but not registered: ${name}`);
    }
  }
  for (const name of registered) {
    if (!declared.includes(name)) {
      record("ipc-drift", "src-tauri/src/tauri_commands.rs", 0, `registered but not declared: ${name}`);
    }
  }
  const dup = declared.filter((n, i) => declared.indexOf(n) !== i);
  for (const name of new Set(dup)) {
    record("ipc-drift", "src-tauri/src/tauri_commands.rs", 0, `duplicate command name: ${name}`);
  }
}

// ── Report ────────────────────────────────────────────────────────────
const summary = Object.fromEntries(
  Object.entries(violations).map(([rule, items]) => [rule, items.length])
);
const total = Object.values(summary).reduce((a, b) => a + b, 0);

console.log("backend constraint guard");
console.log("─".repeat(46));
for (const [rule, count] of Object.entries(summary)) {
  console.log(`  ${rule.padEnd(26)} ${count}`);
}
console.log("─".repeat(46));
console.log(`  ${"TOTAL".padEnd(26)} ${total}`);

if (REPORT_ONLY) process.exit(0);

if (UPDATE_BASELINE) {
  writeFileSync(BASELINE, JSON.stringify(summary, null, 2) + "\n");
  console.log(`\nbaseline written → ${BASELINE.replace(ROOT + "/", "")}`);
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
let regressions = 0;
for (const [rule, items] of Object.entries(violations)) {
  const allowed = baseline[rule] ?? 0;
  if (items.length > allowed) {
    regressions += items.length - allowed;
    console.log(`\n✗ ${rule}: ${items.length} (baseline allows ${allowed})`);
    for (const item of items.slice(0, 5)) {
      console.log(`    ${item.file}:${item.line}  ${item.detail}`);
    }
    if (items.length > 5) console.log(`    … and ${items.length - 5} more`);
  }
}

if (regressions > 0) {
  console.log(
    `\n${regressions} new violation(s). Fix them, or freeze with --update-baseline if intentional.`
  );
  process.exit(1);
}
console.log("\n✓ no new violations");
