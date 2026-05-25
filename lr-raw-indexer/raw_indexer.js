#!/usr/bin/env node
/**
 * VuGen Raw Script Indexer
 * Baca satu file input (hasil copy-paste), terapkan rules normalisasi,
 * lalu tulis hasilnya ke file output.
 *
 * Cara pakai:
 *   1. Copy-paste isi script VuGen (Action.c / BPxxx.c) ke file input.c
 *   2. Jalankan:  node raw_indexer.js
 *   3. Hasil ada di output.c — siap di-copy balik ke VuGen
 */

const fs   = require("fs");
const path = require("path");

// ─── KONFIGURASI ──────────────────────────────────────────────────────────────
const INPUT_FILE  = path.join(__dirname, "input.c");
const OUTPUT_FILE = path.join(__dirname, "output.c");
const START_STEP  = 1;  // nomor step awal, ubah misal ke 10 → step pertama jadi BP001_10_...
// ─────────────────────────────────────────────────────────────────────────────

const WEB_REQUEST_FUNCS = new Set([
  "web_custom_request",
  "web_url",
  "web_submit_data",
  "web_submit_form",
]);

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Deteksi BP number dari isi file.
 * Cari di lr_start_transaction dulu, fallback ke nama fungsi BP\d+().
 */
function detectBpNum(content) {
  let m = content.match(/lr_start_transaction\s*\(\s*"(BP\d+)/i);
  if (m) return m[1].toUpperCase();
  m = content.match(/lr_save_string\s*\(\s*"(BP\d+)/i);
  if (m) return m[1].toUpperCase();
  m = content.match(/Login\s*\(\s*"(BP\d+)/i);
  if (m) return m[1].toUpperCase();
  m = content.match(/Logout\s*\(\s*"(BP\d+)/i);
  if (m) return m[1].toUpperCase();
  // Fallback: nama fungsi BP001()
  m = content.match(/\b(BP\d+)\s*\(\s*\)/i);
  if (m) return m[1].toUpperCase();
  return null;
}

function extractEndpoint(url) {
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

function buildTxRenameMap(content, bpNum) {
  const map     = new Map();
  const entries = [];

  // Pattern A: lr_start_transaction("BP...")
  const reA = /^(?!\s*\/\/).*?lr_start_transaction\s*\(\s*"(BP[^"]+)"\s*\)/gm;
  // Pattern B: lr_save_string("BP...", "varName")
  const reB = /^(?!\s*\/\/).*?lr_save_string\s*\(\s*"(BP[^"]+)"\s*,/gm;
  // Pattern C: Login("BP...") or Login(BP...)
  const reC = /^(?!\s*\/\/).*?Login\s*\(\s*"?(BP[^")\s]+)"?\s*\)/gm;
  // Pattern D: Logout("BP...") or Logout(BP...)
  const reD = /^(?!\s*\/\/).*?Logout\s*\(\s*"?(BP[^")\s]+)"?\s*\)/gm;

  let m;
  while ((m = reA.exec(content)) !== null) entries.push({ idx: m.index, name: m[1] });
  while ((m = reB.exec(content)) !== null) entries.push({ idx: m.index, name: m[1] });
  while ((m = reC.exec(content)) !== null) entries.push({ idx: m.index, name: m[1] });
  while ((m = reD.exec(content)) !== null) entries.push({ idx: m.index, name: m[1] });
  entries.sort((a, b) => a.idx - b.idx);

  let step = START_STEP;
  for (const { name } of entries) {
    if (map.has(name)) continue; // hindari duplikat (A dan B untuk nama yang sama)
    let sem;
    let sm = name.match(/^BP\d+_\d+_(.+)/i);
    if (sm) { sem = sm[1]; }
    else { sm = name.match(/^BP\d+_(.+)/i); sem = sm ? sm[1] : name; }
    map.set(name, `${bpNum}_${String(step).padStart(2, "0")}_${sem}`);
    step++;
  }
  return map;
}

function processContent(content, bpNum) {
  const txMap = buildTxRenameMap(content, bpNum);
  if (!txMap.size) return { content, txRenamed: 0, webRenamed: 0 };

  const lines = content.split(/(?<=\n)/);

  let currentTxOld = null;
  let currentTxNew = null;
  let stepNumStr   = null;
  let webCounter   = 0;
  let txRenamed    = 0;
  let webRenamed   = 0;

  const result = [];

  for (let idx = 0; idx < lines.length; idx++) {
    let line = lines[idx];

    if (line.trimStart().startsWith("//")) {
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
        stepNumStr   = sn ? sn[1].padStart(2, "0") : "00";
        webCounter   = 0;
        if (oldName !== newName) txRenamed++;
        result.push(line.replace(re, `$1${newName}$3`));
        continue;
      }
    }

    // ── lr_save_string (Pattern B: nama transaksi disimpan ke variabel) ──────
    // Ini adalah satu-satunya tempat nama literal muncul pada Pattern B.
    // Sekaligus set currentTx state agar web request di bawahnya bisa dinomori.
    {
      const re = /(lr_save_string\s*\(\s*")([^"]+)(")/;
      const m  = line.match(re);
      if (m && /^BP\d+/i.test(m[2])) {
        const oldName = m[2];
        const newName = txMap.get(oldName) ?? oldName;
        currentTxOld = oldName;
        currentTxNew = newName;
        const sn = newName.match(/_(\d+)_/);
        stepNumStr   = sn ? sn[1].padStart(2, "0") : "00";
        webCounter   = 0;
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
        stepNumStr   = sn ? sn[1].padStart(2, "0") : "00";
        webCounter   = 0;
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
          // Pattern A: first arg adalah nama BP literal → rename
          const newName = currentTxNew ?? txMap.get(oldName) ?? oldName;
          result.push(line.replace(re, `$1${newName}$3`));
        } else {
          // Pattern B: first arg adalah "%s" atau lainnya → biarkan as-is
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
    // Cocokkan berdasarkan bagian semantik (setelah BPxxx_NN_) agar tetap
    // bekerja meski nama di file tidak konsisten dengan lr_start.
    if (currentTxNew) {
      const semNew = (currentTxNew.match(/^BP\d+_\d+_(.+)/i) || [])[1];
      const txNameRe = /\b(BP\d+_\d+_[A-Za-z][A-Za-z0-9_]*)\b/g;
      const replaced = line.replace(txNameRe, (match) => {
        if (txMap.has(match)) return txMap.get(match);
        const semMatch = (match.match(/^BP\d+_\d+_(.+)/i) || [])[1];
        return semNew && semMatch === semNew ? currentTxNew : match;
      });
      if (replaced !== line) {
        result.push(replaced);
        continue;
      }
    }

    // ── web request functions (hanya di dalam blok transaksi) ───────────────
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

// ─── entry point ──────────────────────────────────────────────────────────────

function main() {
  const inputPath  = INPUT_FILE;
  const outputPath = OUTPUT_FILE;

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: input file tidak ditemukan → ${inputPath}`);
    process.exit(1);
  }

  const original = fs.readFileSync(inputPath, "utf-8");

  if (!original.trim()) {
    console.error("Error: input.c kosong. Paste isi script VuGen terlebih dahulu.");
    process.exit(1);
  }

  const bpNum = detectBpNum(original);
  if (!bpNum) {
    console.error("Error: BP number tidak terdeteksi. Pastikan ada lr_start_transaction(\"BP001_...\") di dalam file.");
    process.exit(1);
  }

  console.log(`Input     : ${inputPath}`);
  console.log(`Output    : ${outputPath}`);
  console.log(`BP        : ${bpNum} (terdeteksi otomatis)`);
  console.log(`Start step: ${START_STEP}`);
  console.log("─".repeat(50));

  const { content: updated, txRenamed, webRenamed } = processContent(original, bpNum);

  if (updated === original) {
    console.log("Tidak ada perubahan — file sudah dalam format yang benar.");
    fs.writeFileSync(outputPath, updated, "utf-8");
  } else {
    fs.writeFileSync(outputPath, updated, "utf-8");
    console.log(`Transaksi   : ${txRenamed} di-rename`);
    console.log(`Web request : ${webRenamed} di-rename`);
    console.log(`\nOutput tersimpan → ${OUTPUT_FILE}`);
  }
}

main();
