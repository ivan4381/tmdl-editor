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
   - Tersedia filter Semua / Kosong / Terisi / Diubah, opsi sembunyikan objek hidden, dan progres per tabel.
   - Isi massal dengan template `{name}`, `{table}`, `{type}`, cari & ganti, serta export/import CSV untuk SME.
   - Draft tersimpan otomatis di browser (localStorage) dan ditawarkan kembali saat script yang sama di-parse lagi.
5. Di langkah **Output**, periksa diff dan status validasi, lalu **Copy to clipboard**. Di TMDL view, buka tab baru,
   paste, lalu klik **Apply**. Simpan PBIP atau commit git dulu sebelum Apply. Untuk script seluruh model, simpan juga
   salinan aslinya lewat **Download original**.

Catatan:
- Hanya `table`, `column`, dan `measure` yang bisa diedit. Deskripsi milik `expression`, `queryGroup`, dan objek
  lain dibiarkan apa adanya.
- `ref table X` (script parsial) ditampilkan read-only. Measure dan kolom di bawahnya tetap bisa diedit.
- Teks yang **ditempel** ke textarea selalu dinormalkan browser ke line ending LF (aturan standar `<textarea>`).
  TMDL view menerima LF. File yang di-drag mempertahankan CRLF dan BOM persis.
- Halaman memasang Content-Security-Policy `connect-src 'none'`, sehingga browser sendiri memblokir request jaringan.

## Pengembangan

Butuh Node.js ≥ 18. Tidak ada `npm install` karena tidak ada dependency.

```bash
npm test         # node --test, semua test core (parser, writer, validator, diff, csv, items)
npm run build    # menghasilkan dist/tmdl-description-editor.html
```

Struktur:

```
src/core/   pure functions tanpa DOM: text, names, parser, writer, validator, diff, csv, bulk, items
src/ui/     DOM: app (state), input-panel, grid, tools (CSV/bulk/replace), output-panel, storage, dom
src/index.html, src/styles.css   template; build.mjs meng-inline CSS dan JS ke satu file
test/       node:test + fixtures (TAB asli, lihat .editorconfig dan .gitattributes)
reference/  prototipe Python algoritma parser (hanya acuan, tidak ikut build)
```

- `build.mjs` membundel modul ES (import/export bernama) menjadi registry modul di dalam satu IIFE.
- Fixture 18 (model sintetis 200 tabel / 5.000 kolom + baris JSON 200.000 karakter) dibuat di memori oleh
  `test/gen-full-model-large.mjs`. Jalankan `node test/gen-full-model-large.mjs out.tmdl` untuk menulisnya ke file.
- Sampel model asli jangan di-commit. Simpan di `local-samples/` (sudah ada di `.gitignore`).

Detail algoritma dan keputusan desain ada di [`plan.md`](plan.md).
