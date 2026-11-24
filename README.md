# TMDL Description Editor

Aplikasi web **satu file HTML, offline, tanpa dependency** untuk mengisi atau mengubah deskripsi
**tabel, kolom, dan measure** pada script TMDL dari Power BI Desktop.

Output-nya identik byte-per-byte dengan input **kecuali baris deskripsi `///`**. Hal ini dijamin oleh
validator: kalau ada perubahan di luar baris deskripsi, tombol Copy dan Download diblokir.

## Cara pakai (pengguna)

1. Buka `dist/tmdl-description-editor.html` dengan double-click. Tidak perlu internet, server, atau instalasi.
2. Di Power BI Desktop, buka **TMDL view**, lalu seret node **Semantic model** (atau tabel tertentu) dari
   Data pane ke editor. Bisa juga klik kanan → *Script TMDL* → *Clipboard*.
3. Salin seluruh script, tempel di aplikasi, lalu klik **Parse**. File `.tmdl` dari folder PBIP juga bisa
   di-drag. Beberapa file sekaligus diperbolehkan, dan tiap file punya output sendiri.
4. Isi deskripsi di langkah **Edit**:
   - `Enter` menyimpan dan pindah ke baris berikutnya, `Shift+Enter` membuat baris baru,
     `Esc` membatalkan perubahan sel, dan `Ctrl+F` membuka pencarian.
   - Filter status (Semua / Kosong / Terisi / Diubah) dan filter tipe (Semua tipe / Hanya Kolom / Hanya Measure)
     bekerja bersamaan, misalnya Hanya Kolom + Terisi. Ada juga opsi sembunyikan objek hidden dan progres per tabel.
   - Paginasi di bawah grid: 10, 25 (default), atau 50 baris per halaman; pilihan diingat browser.
   - Sidebar dikelompokkan otomatis (bisa di-expand/collapse): **Special Table** (kalender: nama seperti Calendar/DimDate/
     Date Table, `dataCategory: Time`, tabel tanggal otomatis; tabel measure: nama seperti Measures Table/_Measures, atau
     tabel yang hanya berisi measure), **Fact Table** (`Fact…`), **Dimension Table** (`Dim…`), **Lainnya**. Huruf setelah
     awalan tidak boleh huruf kecil (`Factory`, `Dimonitor` masuk Lainnya). Di mode Power Query ditambah **Staging**
     (`Staging…`/`stg…` atau query group "Staging") dan **Fungsi & Parameter** (`fn…`/`fx…`, `PBI_ResultType = Function`,
     fungsi `(x) =>`, atau `meta [IsParameterQuery = true]`). Query yang tidak dimuat ke model ditulis *miring*.
   - **✨ Saran AI** per objek (tombol ✨ di setiap baris) atau sekaligus lewat **✨ Isi dengan AI…**
     (hanya yang kosong, atau semua objek). Deskripsi yang sudah terisi tidak ditimpa tanpa konfirmasi.
   - Isi massal dengan template `{name}`, `{table}`, `{type}`, cari & ganti, serta **export/import Excel (.xlsx)** untuk SME.
   - Draft tersimpan otomatis di browser (localStorage) dan ditawarkan kembali saat script yang sama di-parse lagi.
   - Mode **Power Query (M)** (tombol di atas grid): deskripsi **per step** M dan **deskripsi query**, termasuk ✨ AI.
     Lihat bagian di bawah.
5. Di langkah **Output**, periksa diff dan status validasi, lalu **Copy to clipboard**. Di TMDL view, buka tab baru,
   paste, lalu klik **Apply**. Simpan PBIP atau commit git dulu sebelum Apply. Untuk script seluruh model, simpan juga
   salinan aslinya lewat **Download original**.

Catatan:
- Hanya `table`, `column`, dan `measure` yang bisa diedit. Deskripsi milik `expression`, `queryGroup`, dan objek
  lain dibiarkan apa adanya.
- `ref table X` (script parsial) ditampilkan read-only. Measure dan kolom di bawahnya tetap bisa diedit.
- Teks yang **ditempel** ke textarea selalu dinormalkan browser ke line ending LF (aturan standar `<textarea>`).
  TMDL view menerima LF. File yang di-drag mempertahankan CRLF dan BOM persis.
- Halaman memasang Content-Security-Policy yang hanya mengizinkan koneksi ke `generativelanguage.googleapis.com`,
  `api.anthropic.com`, dan `batik-copilotku-proxy.ivan-saja.workers.dev`, dan itu pun hanya dipakai saat tombol ✨
  ditekan. Selain itu tidak ada request jaringan.

### Saran AI (opsional, BYOK)

- Buka **⚙ AI** di toolbar, isi API key **Google Gemini**, **Anthropic Claude**, dan/atau **Copilotku** milik Anda sendiri, klik
  *Muat daftar model*, lalu pilih model, bahasa deskripsi, dan (opsional) konteks bisnis.
- Key disimpan di `sessionStorage` (hilang saat tab ditutup), atau di `localStorage` jika *Ingat key* dicentang.
  Key hanya dikirim ke API provider-nya.
- **Data yang dikirim:** untuk objek yang diminta saja: nama, tipe, tabel, data type, ekspresi DAX (dipotong),
  deskripsi yang ada, nama kolom/measure lain di tabel yang sama, dan konteks bisnis. Script lengkap, partition/M,
  dan objek lain tidak dikirim. Fitur ini perlu persetujuan eksplisit di pengaturan.
- Hasil AI ditandai **✨ saran AI** dan bergaris putus-putus di grid sampai Anda menyuntingnya. Validator tetap berlaku.
- **Pemakaian token** ditampilkan setelah setiap pemanggilan AI: notifikasi untuk ✨ satu objek/step dan refactor,
  ringkasan akhir untuk isi massal, dan total sejak halaman dibuka di ⚙ AI. Angka berasal dari laporan provider
  (token keluar termasuk token "berpikir" bila ada); bila provider tidak melaporkan, ditulis "tidak dilaporkan".
- **Copilotku** dipanggil lewat Cloudflare Worker yang sama dengan BATIK web (`batik-copilotku-proxy`), karena API
  Copilotku tidak mendukung CORS. Worker hanya meneruskan `GET /v1/models` dan `POST /v1/chat/completions` dan tidak
  menyimpan key. **Syarat:** `ALLOWED_ORIGINS` di `web/copilotku-proxy/wrangler.toml` (repo dama-explorer) harus
  memuat `null` (origin halaman `file://`), lalu `npx wrangler deploy`. Tanpa itu, Copilotku gagal dengan pesan yang
  menjelaskan langkah ini.

### Power Query (M): deskripsi step dan query

- Deskripsi step ditulis sebagai komentar `//` tepat di atas baris step pada `let … in` tingkat atas. Power Query
  menampilkannya sebagai deskripsi step (ikon dan tooltip di Applied Steps), sama seperti deskripsi yang diisi lewat
  klik kanan step → Properties. Komentar yang sudah ada di atas step terbaca sebagai deskripsi.
- Deskripsi query tabel = deskripsi tabel (tampil di Data pane, tooltip, dan Query properties). Deskripsi
  parameter/fungsi/staging = `///` di atas `expression`.
- Mencakup partition `= m` dan semua `expression` (termasuk yang ber-fence ```). Step yang berbagi baris dengan
  step lain, atau query yang strukturnya tidak dikenali, tidak bisa diberi komentar (ditandai di layar).
- AI tidak pernah mengubah kode M: ia hanya memberi teks deskripsi, dan validator memastikan kode M (selain komentar
  deskripsi step) tetap identik byte-per-byte. Opsi **sensor** di ⚙ AI mengganti URL, server, path, dan email di kode M
  dengan placeholder (`<URL_1>`, `<SERVER_1>`, …) sebelum dikirim.
- Diuji manual di Power BI Desktop: komentar step tampil sebagai deskripsi step; Apply tidak menghapus data dan tidak
  meminta refresh; deskripsi tabel dan expression tampil di Query properties.

### Refactor query M dengan AI

- Tombol **🛠 Refactor dengan AI** di mode Power Query (M), aktif hanya jika API key dan model AI sudah diatur di ⚙ AI.
  Satu refactor untuk satu query; bahasa komentar (Bahasa Indonesia / English) dipilih setiap kali.
- Prompt refactor tertanam di aplikasi (`src/core/refactor.js`, `REFACTOR_PROMPT`; terbaca di source HTML), ditambah aturan
  pengaman (kolom output, sumber data, referensi query, RangeStart/RangeEnd tidak boleh berubah) dan format jawaban JSON.
- Hasil tampil di sub-tab **Hasil refactor** (query diberi tanda 🛠 di sidebar): kode refactor, versi alternatif (jika
  ada), perbandingan dengan kode asli, jumlah baris kode dan step sebelum → sesudah (tanpa komentar dan baris kosong),
  pemeriksaan otomatis, dan penjelasan perubahan. **Copy** atau **Download .pq** untuk ditempel sendiri di Advanced Editor.
- Hasil refactor **tidak pernah mengubah script TMDL** dan hanya disimpan selama tab terbuka. Belum diuji: refresh dan
  bandingkan hasil di Power BI setelah menempel.

## Pengembangan

Butuh Node.js ≥ 18. Tidak ada `npm install` karena tidak ada dependency.

```bash
npm test         # node --test: parser, writer, validator, diff, xlsx/sheet, items, AI (fetch tiruan, tanpa jaringan)
npm run build    # menghasilkan dist/tmdl-description-editor.html
```

Struktur:

```
src/core/   pure functions tanpa DOM: text, names, parser, mquery, refactor, writer, validator, diff, zip, xlsx, sheet, bulk, items, ai-prompt
src/ai/     klien AI BYOK (Gemini, Claude, Copilotku via Worker) lewat fetch; dipanggil hanya dari src/ui/ai.js
src/ui/     DOM: app (state), input-panel, grid, mquery-panel, tools (Excel/bulk/replace), ai (pengaturan, ✨, isi massal), output-panel, storage, dom
src/index.html, src/styles.css   template; build.mjs meng-inline CSS dan JS ke satu file
test/       node:test + fixtures (TAB asli, lihat .editorconfig dan .gitattributes)
reference/  prototipe Python algoritma parser (hanya acuan, tidak ikut build)
```

- `build.mjs` membundel modul ES (import/export bernama) menjadi registry modul di dalam satu IIFE.
- Fixture 18 (model sintetis 200 tabel / 5.000 kolom + baris JSON 200.000 karakter) dibuat di memori oleh
  `test/gen-full-model-large.mjs`. Jalankan `node test/gen-full-model-large.mjs out.tmdl` untuk menulisnya ke file.
- Sampel model asli jangan di-commit. Simpan di `local-samples/` (sudah ada di `.gitignore`).

Detail algoritma dan keputusan desain ada di [`plan.md`](plan.md).
