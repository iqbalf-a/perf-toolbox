#!/usr/bin/env node
/**
 * LR Action Renamer
 * Renames Action.c to BP<num>.c in each BP* folder, and updates
 * all text file references from "Action" to "BP<num>".
 *
 * Usage:
 *   node action_renamer.js [--dry-run] [--folder BP001_WEB_Splash]
 */

const fs   = require("fs");
const path = require("path");

// ─── KONFIGURASI ──────────────────────────────────────────────────────────────
const SCRIPTS_DIR = "D:\\github-repos\\perf-toolbox\\lr-action-renamer\\script";
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_EXTENSIONS = new Set([
  ".idx", ".dat", ".db", ".pickle", ".ico", ".qtp",
  ".bak", ".log", ".html", ".gif", ".png", ".jpg",
]);

// ─── helpers ──────────────────────────────────────────────────────────────────

function timestamp() {
  const d   = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function getAllFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...getAllFiles(fullPath));
    else results.push(fullPath);
  }
  return results;
}

// ─── core ─────────────────────────────────────────────────────────────────────

function processFolder(folderPath, dryRun) {
  const folderName = path.basename(folderPath);
  const bpMatch    = folderName.match(/^(BP\d+)/i);
  if (!bpMatch) return;

  const bpNum      = bpMatch[1].toUpperCase();
  const actionFile = path.join(folderPath, "Action.c");

  if (!fs.existsSync(actionFile)) {
    console.log(`  [${folderName}] SKIP — Action.c tidak ditemukan`);
    return;
  }

  console.log(`\n  [${folderName}]  ${bpNum}.c`);

  const uspFile = path.join(folderPath, "default.usp");
  if (!fs.existsSync(uspFile))
    console.warn(`    WARN    : default.usp tidak ditemukan`);

  const pattern = /\bAction\b/g;
  let contentUpdated = 0;

  for (const filePath of getAllFiles(folderPath)) {
    const ext      = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath);

    if (SKIP_EXTENSIONS.has(ext)) continue;
    if (basename === "Action.c") continue;

    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    pattern.lastIndex = 0;
    if (!pattern.test(content)) continue;

    const updated = content.replace(/\bAction\b/g, bpNum);
    const relPath = path.relative(folderPath, filePath);

    if (dryRun) {
      console.log(`    [DRY RUN] refs: ${relPath}`);
    } else {
      fs.copyFileSync(filePath, `${filePath}.bak.${timestamp()}`);
      fs.writeFileSync(filePath, updated, "utf8");
      console.log(`    updated : ${relPath}`);
    }
    contentUpdated++;
  }

  const newFilePath = path.join(folderPath, `${bpNum}.c`);
  if (dryRun) {
    console.log(`    [DRY RUN] rename: Action.c → ${bpNum}.c`);
  } else {
    fs.copyFileSync(actionFile, `${actionFile}.bak.${timestamp()}`);
    fs.renameSync(actionFile, newFilePath);
    console.log(`    rename  : Action.c → ${bpNum}.c`);
  }

  console.log(`    ${contentUpdated} file(s) referensi diupdate`);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let dryRun     = false;
  let onlyFolder = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run" || args[i] === "-n") dryRun = true;
    else if ((args[i] === "--folder" || args[i] === "-f") && args[i + 1]) onlyFolder = args[++i];
  }

  if (!fs.existsSync(SCRIPTS_DIR) || !fs.statSync(SCRIPTS_DIR).isDirectory()) {
    console.error(`Error: '${SCRIPTS_DIR}' tidak ditemukan.`);
    process.exit(1);
  }

  console.log(`LR Action Renamer  [${dryRun ? "DRY RUN (no files changed)" : "LIVE"}]`);
  console.log(`Directory : ${SCRIPTS_DIR}`);

  let folders;
  if (onlyFolder) {
    const target = path.join(SCRIPTS_DIR, onlyFolder);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      console.error(`Error: folder '${target}' tidak ditemukan.`);
      process.exit(1);
    }
    folders = [target];
  } else {
    folders = fs
      .readdirSync(SCRIPTS_DIR)
      .filter((name) => /^BP\d+/i.test(name))
      .sort()
      .map((name) => path.join(SCRIPTS_DIR, name))
      .filter((p) => fs.statSync(p).isDirectory());
  }

  console.log(`Folders   : ${folders.length} found`);
  console.log("=".repeat(60));

  for (const folder of folders) processFolder(folder, dryRun);

  console.log("\n" + "=".repeat(60));
  console.log("Selesai.");
}

main();
