# perf-toolbox

Kumpulan tools untuk performance testing — dimulai dari VuGen/LoadRunner scripting.

---

## Tools

| Folder | Tool | Deskripsi |
|---|---|---|
| `lr-bulk-indexer/` | `vugen_indexer.js` | Normalisasi nama transaksi & web request secara bulk (semua folder `BP*`) |
| `lr-raw-indexer/` | `raw_indexer.js` | Normalisasi satu file script hasil copy-paste |

---

## Kebutuhan

- [Node.js](https://nodejs.org/) (versi 14 ke atas, tidak perlu install package tambahan)

---

---

# lr-bulk-indexer

Tool untuk normalisasi nama transaksi dan web request secara bulk pada semua folder script LoadRunner VuGen.

## Konfigurasi

Buka `lr-bulk-indexer/vugen_indexer.js`, edit variabel berikut:

```js
const SCRIPTS_DIR = "D:\\github-repos\\perf-toolbox\\lr-bulk-indexer\\script";
```

Ganti path tersebut dengan lokasi folder `script` milik Anda.

## Struktur Folder yang Didukung

```
lr-bulk-indexer/
├── vugen_indexer.js
└── script/
    ├── BP001_WEB_Splash/
    │   └── BP001.c          ← file utama (atau Action.c)
    ├── BP002_WEB_Login/
    │   └── BP002.c
    └── BP027_WEB_Portfolio/
        └── Action.c
```

Tool membaca folder bernama `BP<nomor>_<nama>` dan mencari file script utama dengan prioritas:
1. `BP<nomor>.c` (misal `BP001.c`)
2. `Action.c`

## Cara Penggunaan

```bash
cd lr-bulk-indexer

# Preview perubahan tanpa menyentuh file
node vugen_indexer.js --dry-run

# Jalankan untuk semua folder BP*
node vugen_indexer.js

# Jalankan untuk satu folder saja
node vugen_indexer.js --folder BP001_WEB_Splash

# Rollback ke backup terbaru
node vugen_indexer.js --restore

# Rollback satu folder saja
node vugen_indexer.js --restore --folder BP001_WEB_Splash
```

| Flag | Singkat | Keterangan |
|---|---|---|
| `--dry-run` | `-n` | Preview perubahan, tidak ada file yang ditulis |
| `--restore` | `-r` | Rollback ke backup timestamped paling baru |
| `--folder <nama>` | `-f <nama>` | Proses satu folder saja |

## Rules Pemrosesan

### Rule 1 — Penomoran Transaksi

Setiap `lr_start_transaction` dalam satu file diberi nomor step 2 digit secara berurutan.

**Kondisi A** — Nama belum punya nomor step:
```c
// Sebelum
lr_start_transaction("BP001_Splash_Screen");
lr_start_transaction("BP001_Login");

// Sesudah
lr_start_transaction("BP001_01_Splash_Screen");
lr_start_transaction("BP001_02_Login");
```

**Kondisi B** — Nama sudah punya nomor step (di-resequence untuk konsistensi):
```c
// Sebelum (misalnya urutan tidak konsisten)
lr_start_transaction("BP001_03_Splash_Screen");
lr_start_transaction("BP001_01_Login");

// Sesudah (dinomori ulang dari 01 sesuai urutan kemunculan)
lr_start_transaction("BP001_01_Splash_Screen");
lr_start_transaction("BP001_02_Login");
```

### Rule 2 — Update Referensi Transaksi

Setelah nama transaksi berubah, semua baris yang merujuk nama lama ikut diperbarui otomatis:

```c
lr_end_transaction("BP001_01_Splash_Screen", LR_AUTO);
if (lr_get_transaction_status("BP001_01_Splash_Screen") == LR_FAIL) {
lr_error_message("BP001_01_Splash_Screen error: [%s]", ...);
```

### Rule 3 — Penamaan Web Request

Setiap web request di dalam blok transaksi di-rename mengikuti format:

```
RPS_<BP>_<step>_<urutan>_<endpoint>
```

| Bagian | Keterangan |
|---|---|
| `RPS` | Prefix tetap |
| `<BP>` | Nomor BP dari nama folder, misal `BP001` |
| `<step>` | Nomor step 2 digit dari transaksi aktif |
| `<urutan>` | Urutan request dalam step ini, 2 digit, reset tiap step baru |
| `<endpoint>` | Segmen terakhir URL (`URL=` atau `Action=`), dibersihkan ke snake_case |

```c
// Sebelum
web_custom_request("summary_41",
    "URL=https://{URL}/funding/v1/portfolio/dpk/summary", ...

// Sesudah
web_custom_request("RPS_BP027_01_01_summary",
    "URL=https://{URL}/funding/v1/portfolio/dpk/summary", ...
```

Fungsi yang dicakup: `web_custom_request`, `web_url`, `web_submit_data`, `web_submit_form`.
Baris komentar (`//`) tidak disentuh oleh semua rule.

## Backup & Restore

Setiap kali file dimodifikasi (mode LIVE), backup otomatis dibuat:

```
BP001.c.bak.20260521_143022
```

Untuk rollback, jalankan `--restore` — tool mengambil file `.bak.*` dengan timestamp terbaru.

## Contoh Output

**Dry-run:**
```
VuGen Script Indexer  [DRY RUN (no files changed)]
Directory : D:\github-repos\perf-toolbox\lr-bulk-indexer\script
Folders   : 3 found
============================================================

  [BP027_WEB_Portfolio_Dana_DIR]  file: Action.c
    - lr_start_transaction("BP027_Portfolio_Dana_DIR");
    + lr_start_transaction("BP027_01_Portfolio_Dana_DIR");
    - web_custom_request("summary_41",
    + web_custom_request("RPS_BP027_01_01_summary",
    ... and 18 more line(s)
    [DRY RUN] tx:1 renamed, web:14 renamed, 22 line(s) total
```

**Live:**
```
VuGen Script Indexer  [LIVE]
Directory : D:\github-repos\perf-toolbox\lr-bulk-indexer\script
Folders   : 3 found
============================================================

  [BP027_WEB_Portfolio_Dana_DIR]  file: Action.c
    tx:1 renamed, web:14 renamed, 22 line(s) changed
    Backup → Action.c.bak.20260521_143022

============================================================
Ringkasan   : 1 file diubah
Transaksi   : 1 di-rename
Web request : 14 di-rename
Selesai.
```

---

---

# lr-raw-indexer

Tool untuk normalisasi satu file script VuGen hasil copy-paste, tanpa perlu menyentuh folder script asli.

## Konfigurasi

Buka `lr-raw-indexer/raw_indexer.js`, edit variabel berikut:

```js
const RAW_SCRIPT_DIR = "D:\\github-repos\\perf-toolbox\\lr-raw-indexer\\raw-script";
const START_STEP     = 1;  // nomor step awal
```

## Struktur Folder

```
lr-raw-indexer/
├── raw_indexer.js
└── raw-script/
    ├── input.c    ← paste script VuGen di sini
    └── output.c   ← hasil normalisasi
```

## Cara Penggunaan

```bash
cd lr-raw-indexer

# 1. Paste isi script VuGen ke raw-script/input.c
# 2. Jalankan:
node raw_indexer.js
# 3. Ambil hasilnya dari raw-script/output.c
```

BP number dideteksi otomatis dari isi `input.c` (dari `lr_start_transaction`, `lr_save_string`, atau nama fungsi `BP\d+()`).

## Contoh Output

```
Input     : D:\github-repos\perf-toolbox\lr-raw-indexer\raw-script\input.c
Output    : D:\github-repos\perf-toolbox\lr-raw-indexer\raw-script\output.c
BP        : BP001 (terdeteksi otomatis)
Start step: 1
──────────────────────────────────────────────────
Transaksi   : 3 di-rename
Web request : 7 di-rename

Output tersimpan → output.c
```
