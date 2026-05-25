#!/usr/bin/env node
/**
 * VuGen Script Bulk Indexer
 * Normalizes transaction and web request names across all BP* script folders.
 *
 * Rules:
 *  1. lr_start_transaction names get sequential 2-digit step numbers:
 *       BP001_Login  →  BP001_01_Login
 *     (already-numbered names are also re-sequenced for consistency)
 *  2. lr_end_transaction, lr_get_transaction_status, and lr_error_message
 *     are updated to match the new transaction names.
 *  3. Web requests (web_custom_request, web_url, web_submit_data, web_submit_form)
 *     inside each transaction block are renamed:
 *       web_custom_request("old_name", "URL=.../endpoint", ...)
 *     → web_custom_request("RPS_BP001_01_01_endpoint", "URL=.../endpoint", ...)
 *     The last counter resets per transaction and increments per request.
 *
 * Usage:
 *   node vugen_indexer.js [--dry-run]  [--folder BP001_WEB_Splash]
 */

const fs   = require("fs");
const path = require("path");

// ─── KONFIGURASI ──────────────────────────────────────────────────────────────
// Edit variabel di bawah ini sesuai lokasi folder script VuGen Anda.
const SCRIPTS_DIR = "D:\\github-repos\\perf-toolbox\\lr-bulk-indexer\\script";
// ─────────────────────────────────────────────────────────────────────────────

// ─── constants ────────────────────────────────────────────────────────────────

const WEB_REQUEST_FUNCS = new Set([
  "web_custom_request",
  "web_url",
  "web_submit_data",
  "web_submit_form",
]);

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Return a timestamp string like "20260521_143022" for use in backup filenames. */
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Return the path to BPxxx.c or Action.c inside a folder, or null. */
function findMainScript(folderPath) {
  const name = path.basename(folderPath);
  const bpMatch = name.match(/^(BP\d+)/i);
  if (bpMatch) {
    const candidate = path.join(folderPath, `${bpMatch[1]}.c`);
    if (fs.existsSync(candidate)) return candidate;
  }
  const action = path.join(folderPath, "Action.c");
  if (fs.existsSync(action)) return action;
  return null;
}

/**
 * Extract the last meaningful path segment of a URL as a clean snake_case token.
 * "https://{HOST}/service/v1/login/create-session" → "create_session"
 */
function extractEndpoint(url) {
  // Strip protocol + host (host may be a {param})
  let p = url.replace(/^https?:\/\/[^/]*/, "");
  p = p.split("?")[0];
  const segments = p
    .split("/")
    .filter((s) => s && !(s.startsWith("{") && s.endsWith("}")));
  if (!segments.length) return "unknown";
  const raw = segments[segments.length - 1];
  let clean = raw.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
  clean = clean.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return clean || "unknown";
}

/**
 * Look ahead in `lines` from `startIdx` for a URL= or Action= parameter
 * within a web request call. Stops at LAST) (end of call) or after 30 lines.
 */
function findUrlEndpoint(lines, startIdx) {
  for (let i = startIdx + 1; i < Math.min(startIdx + 30, lines.length); i++) {
    let m = lines[i].match(/"URL=([^"]+)"/);
    if (m) return extractEndpoint(m[1]);
    m = lines[i].match(/"Action=([^"]+)"/);
    if (m) return extractEndpoint(m[1]);
    if (/\bLAST\b/.test(lines[i]) && lines[i].includes(")")) break;
  }
  return "unknown";
}

// ─── core processing ──────────────────────────────────────────────────────────

/**
 * Scan content for transaction names from all patterns:
 *   A: lr_start_transaction("BP...")
 *   B: lr_save_string("BP...", "varName")
 *   C: Login("BP...")
 *   D: Logout("BP...")
 * Returns Map { oldName → newName } with sequential 2-digit step numbers.
 */
function buildTxRenameMap(content, bpNum) {
  const map     = new Map();
  const entries = [];

  const reA = /^(?!\s*\/\/).*?lr_start_transaction\s*\(\s*"(BP[^"]+)"\s*\)/gm;
  const reB = /^(?!\s*\/\/).*?lr_save_string\s*\(\s*"(BP[^"]+)"\s*,/gm;
  const reC = /^(?!\s*\/\/).*?Login\s*\(\s*"?(BP[^")\s]+)"?\s*\)/gm;
  const reD = /^(?!\s*\/\/).*?Logout\s*\(\s*"?(BP[^")\s]+)"?\s*\)/gm;

  let m;
  while ((m = reA.exec(content)) !== null) entries.push({ idx: m.index, name: m[1] });
  while ((m = reB.exec(content)) !== null) entries.push({ idx: m.index, name: m[1] });
  while ((m = reC.exec(content)) !== null) entries.push({ idx: m.index, name: m[1] });
  while ((m = reD.exec(content)) !== null) entries.push({ idx: m.index, name: m[1] });
  entries.sort((a, b) => a.idx - b.idx);

  let step = 1;
  for (const { name } of entries) {
    if (map.has(name)) continue;
    let sem;
    let sm = name.match(/^BP\d+_\d+_(.+)/i);
    if (sm) { sem = sm[1]; }
    else { sm = name.match(/^BP\d+_(.+)/i); sem = sm ? sm[1] : name; }
    map.set(name, `${bpNum}_${String(step).padStart(2, "0")}_${sem}`);
    step++;
  }
  return map;
}

/**
 * Apply all renaming rules to file content.
 * Returns { content, txRenamed, webRenamed }.
 */
function processContent(content, bpNum) {
  const txMap = buildTxRenameMap(content, bpNum);
  if (!txMap.size) return { content, txRenamed: 0, webRenamed: 0 };

  const lines = content.split(/(?<=\n)/); // split but keep line endings

  let currentTxOld  = null;
  let currentTxNew  = null;
  let stepNumStr    = null;
  let webCounter    = 0;
  let txRenamed     = 0;
  let webRenamed    = 0;

  const result = [];

  for (let idx = 0; idx < lines.length; idx++) {
    let line = lines[idx];
    const stripped = line.trimStart();

    // Leave comment lines untouched
    if (stripped.startsWith("//")) {
      result.push(line);
      continue;
    }

    // ── lr_start_transaction ────────────────────────────────────────────────
    {
      const re = /(lr_start_transaction\s*\(\s*")([^"]+)(")/;
      const m  = line.match(re);
      if (m) {
        const oldName = m[2];
        const newName = txMap.get(oldName) ?? oldName;
        currentTxOld = oldName;
        currentTxNew = newName;
        const sn = newName.match(/_(\d+)_/);
        stepNumStr = sn ? sn[1].padStart(2, "0") : "00";
        webCounter = 0;
        if (oldName !== newName) txRenamed++;
        result.push(line.replace(re, `$1${newName}$3`));
        continue;
      }
    }

    // ── lr_save_string (Pattern B: sumber nama transaksi) ───────────────────
    {
      const re = /(lr_save_string\s*\(\s*")([^"]+)(")/;
      const m  = line.match(re);
      if (m && /^BP\d+/i.test(m[2])) {
        const oldName = m[2];
        const newName = txMap.get(oldName) ?? oldName;
        currentTxOld = oldName;
        currentTxNew = newName;
        const sn = newName.match(/_(\d+)_/);
        stepNumStr = sn ? sn[1].padStart(2, "0") : "00";
        webCounter = 0;
        if (oldName !== newName) txRenamed++;
        result.push(line.replace(re, `$1${newName}$3`));
        continue;
      }
    }

    // ── Login / Logout (Pattern C/D: quoted or unquoted) ───────────────────
    {
      const reQ  = /((?:Login|Logout)\s*\(\s*")([^"]+)(")/;
      const reUQ = /((?:Login|Logout)\s*\()(BP[^)\s]+)(\s*\))/;
      let m = line.match(reQ);
      let re = reQ;
      if (!m) { m = line.match(reUQ); re = reUQ; }
      if (m && /^BP\d+/i.test(m[2])) {
        const oldName = m[2];
        const newName = txMap.get(oldName) ?? oldName;
        currentTxOld = oldName;
        currentTxNew = newName;
        const sn = newName.match(/_(\d+)_/);
        stepNumStr = sn ? sn[1].padStart(2, "0") : "00";
        webCounter = 0;
        if (oldName !== newName) txRenamed++;
        result.push(line.replace(re, `$1${newName}$3`));
        continue;
      }
    }

    // ── lr_end_transaction ──────────────────────────────────────────────────
    {
      const re = /(lr_end_transaction\s*\(\s*")([^"]+)(")/;
      const m  = line.match(re);
      if (m) {
        const oldName = m[2];
        if (/^BP\d+/i.test(oldName)) {
          // Pattern A: literal BP name → rename
          const newName = currentTxNew ?? txMap.get(oldName) ?? oldName;
          result.push(line.replace(re, `$1${newName}$3`));
        } else {
          // Pattern B: "%s" atau lainnya → biarkan as-is
          result.push(line);
        }
        currentTxOld = currentTxNew = stepNumStr = null;
        continue;
      }
    }

    // ── lr_get_transaction_status ───────────────────────────────────────────
    {
      const re = /(lr_get_transaction_status\s*\(\s*")([^"]+)(")/;
      const m  = line.match(re);
      if (m) {
        const oldName = m[2];
        if (/^BP\d+/i.test(oldName)) {
          // Pattern A: literal → rename
          const newName = currentTxNew ?? txMap.get(oldName) ?? oldName;
          result.push(line.replace(re, `$1${newName}$3`));
        } else {
          // Pattern B: lr_eval_string → biarkan as-is
          result.push(line);
        }
        continue;
      }
    }

    // ── lr_error_message dan baris lain yang masih pakai nama transaksi ─────
    if (currentTxOld && currentTxNew && currentTxOld !== currentTxNew) {
      if (line.includes(currentTxOld)) {
        result.push(line.split(currentTxOld).join(currentTxNew));
        continue;
      }
    }

    // ── web request functions (only inside a transaction) ───────────────────
    if (currentTxNew && stepNumStr) {
      let handled = false;
      for (const func of WEB_REQUEST_FUNCS) {
        const re = new RegExp(
          `(${func.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(\\s*")([^"]+)(")`
        );
        const m = line.match(re);
        if (m) {
          webCounter++;
          const endpoint   = findUrlEndpoint(lines, idx);
          const newReqName = `RPS_${bpNum}_${stepNumStr}_${String(webCounter).padStart(2, "0")}_${endpoint}`;
          if (m[2] !== newReqName) webRenamed++;
          result.push(line.replace(re, `$1${newReqName}$3`));
          handled = true;
          break;
        }
      }
      if (handled) continue;
    }

    result.push(line);
  }

  return { content: result.join(""), txRenamed, webRenamed };
}

// ─── folder processing ────────────────────────────────────────────────────────

/**
 * Process one BP* folder.
 * Returns { skipped, txRenamed, webRenamed } for summary accumulation.
 */
function processFolder(folderPath, dryRun) {
  const folderName = path.basename(folderPath);
  const bpMatch    = folderName.match(/^(BP\d+)/i);
  const bpNum      = bpMatch ? bpMatch[1].toUpperCase() : folderName;

  const scriptFile = findMainScript(folderPath);
  if (!scriptFile) {
    console.log(`  [${folderName}] SKIP — no .c script file found`);
    return { skipped: true, txRenamed: 0, webRenamed: 0 };
  }

  console.log(`\n  [${folderName}]  file: ${path.basename(scriptFile)}`);

  const original = fs.readFileSync(scriptFile, "utf-8");
  const { content: updated, txRenamed, webRenamed } = processContent(original, bpNum);

  if (updated === original) {
    console.log("    No changes needed.");
    return { skipped: false, txRenamed: 0, webRenamed: 0 };
  }

  // Diff summary
  const origLines    = original.split("\n");
  const updatedLines = updated.split("\n");
  const changed      = origLines.reduce((n, l, i) => n + (l !== updatedLines[i] ? 1 : 0), 0);
  const extra        = Math.abs(origLines.length - updatedLines.length);
  const totalChanges = changed + extra;

  if (dryRun) {
    let shown = 0;
    for (let i = 0; i < Math.min(origLines.length, updatedLines.length); i++) {
      if (origLines[i] !== updatedLines[i]) {
        if (shown < 15) {
          console.log(`    - ${origLines[i].trim()}`);
          console.log(`    + ${updatedLines[i].trim()}`);
        }
        shown++;
      }
    }
    if (totalChanges > 15) console.log(`    ... and ${totalChanges - 15} more line(s)`);
    console.log(`    [DRY RUN] tx:${txRenamed} renamed, web:${webRenamed} renamed, ${totalChanges} line(s) total`);
    return { skipped: false, txRenamed: 0, webRenamed: 0 };
  } else {
    const backup = `${scriptFile}.bak.${timestamp()}`;
    fs.copyFileSync(scriptFile, backup);
    fs.writeFileSync(scriptFile, updated, "utf-8");
    console.log(`    tx:${txRenamed} renamed, web:${webRenamed} renamed, ${totalChanges} line(s) changed`);
    console.log(`    Backup → ${path.basename(backup)}`);
    return { skipped: false, txRenamed, webRenamed };
  }
}

/**
 * Restore a BP* folder's script file from its most recent timestamped backup.
 */
function restoreFolder(folderPath) {
  const folderName = path.basename(folderPath);
  const scriptFile = findMainScript(folderPath);
  if (!scriptFile) {
    console.log(`  [${folderName}] SKIP — no .c script file found`);
    return;
  }

  const scriptBase = path.basename(scriptFile);
  // Find all backup files: e.g. BP001.c.bak.20260521_143022
  const backups = fs
    .readdirSync(folderPath)
    .filter((f) => f.startsWith(scriptBase + ".bak."))
    .sort(); // alphabetical = chronological for YYYYMMDD_HHmmss

  if (!backups.length) {
    console.log(`  [${folderName}] No backup found for ${scriptBase}`);
    return;
  }

  const latest = backups[backups.length - 1];
  const backupPath = path.join(folderPath, latest);
  fs.copyFileSync(backupPath, scriptFile);
  console.log(`  [${folderName}] Restored from ${latest}`);
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

function main() {
  const args        = process.argv.slice(2);
  let dryRun        = false;
  let restore       = false;
  let onlyFolder    = null;
  let scriptsDirArg = SCRIPTS_DIR;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run" || args[i] === "-n") {
      dryRun = true;
    } else if (args[i] === "--restore" || args[i] === "-r") {
      restore = true;
    } else if ((args[i] === "--folder" || args[i] === "-f") && args[i + 1]) {
      onlyFolder = args[++i];
    } else if (!args[i].startsWith("-")) {
      scriptsDirArg = args[i];
    }
  }

  const scriptsDir = path.isAbsolute(scriptsDirArg)
    ? scriptsDirArg
    : path.join(process.cwd(), scriptsDirArg);

  if (!fs.existsSync(scriptsDir) || !fs.statSync(scriptsDir).isDirectory()) {
    console.error(`Error: '${scriptsDir}' is not a directory.`);
    process.exit(1);
  }

  let modeLabel;
  if (restore)      modeLabel = "RESTORE";
  else if (dryRun)  modeLabel = "DRY RUN (no files changed)";
  else              modeLabel = "LIVE";

  console.log(`VuGen Script Indexer  [${modeLabel}]`);
  console.log(`Directory : ${scriptsDir}`);

  let folders;
  if (onlyFolder) {
    const target = path.join(scriptsDir, onlyFolder);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      console.error(`Error: folder '${target}' not found.`);
      process.exit(1);
    }
    folders = [target];
  } else {
    folders = fs
      .readdirSync(scriptsDir)
      .filter((name) => /^BP\d+/i.test(name))
      .sort()
      .map((name) => path.join(scriptsDir, name))
      .filter((p) => fs.statSync(p).isDirectory());
  }

  console.log(`Folders   : ${folders.length} found`);
  console.log("=".repeat(60));

  if (restore) {
    for (const folder of folders) restoreFolder(folder);
    console.log("\nRestore selesai.");
    return;
  }

  let totalTx  = 0;
  let totalWeb = 0;
  let totalChanged = 0;

  for (const folder of folders) {
    const { skipped, txRenamed, webRenamed } = processFolder(folder, dryRun);
    if (!skipped && !dryRun) {
      totalTx  += txRenamed;
      totalWeb += webRenamed;
      if (txRenamed > 0 || webRenamed > 0) totalChanged++;
    }
  }

  console.log("\n" + "=".repeat(60));
  if (!dryRun) {
    console.log(`Ringkasan   : ${totalChanged} file diubah`);
    console.log(`Transaksi   : ${totalTx} di-rename`);
    console.log(`Web request : ${totalWeb} di-rename`);
  }
  console.log("Selesai.");
}

main();
