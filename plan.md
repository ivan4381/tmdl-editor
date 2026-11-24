# plan.md — TMDL Description Editor

> Dokumen kerja untuk dilanjutkan di Claude Code. Baca seluruh file ini sebelum menulis kode.
> Status: **Milestone 0–2 dan 4 selesai; Milestone 3 selesai kecuali uji Apply manual di Power BI Desktop.** Lihat §10 dan catatan implementasi di §12.

---

## 1. Tujuan

Membuat aplikasi web **satu file HTML, offline, tanpa server dan tanpa dependency** untuk:

1. Menerima script TMDL yang di-copy dari **TMDL view** di Power BI Desktop (atau file `.tmdl` dari folder PBIP).
2. Menampilkan daftar **tabel, kolom, dan measure** beserta deskripsinya (kalau sudah ada).
3. Membiarkan pengguna mengisi atau mengubah deskripsi dengan cepat.
4. Menghasilkan TMDL yang **identik dengan aslinya kecuali baris deskripsi**, siap di-paste kembali ke TMDL view lalu di-**Apply**.

### Hasil akhir (deliverable)

**Satu file saja: `dist/tmdl-description-editor.html`.** File ini dibuka langsung dengan double-click di browser, tanpa server, tanpa internet, dan tanpa instalasi apa pun. Semua CSS dan JS di-inline di dalamnya.

Yang **tidak** ikut ke hasil akhir:
- `reference/proto_parse.py`, yang hanya berfungsi sebagai acuan logika selama development.
- `src/`, `test/`, `build.mjs`, `package.json`, yang hanya dipakai developer.

Node.js hanya dibutuhkan developer untuk menjalankan test dan build. Pengguna akhir tidak membutuhkannya.

### Prinsip yang tidak boleh dilanggar

- **Hanya baris deskripsi yang berubah.** Jangan pernah serialize ulang TMDL dari model objek. Writer hanya menyisipkan, mengganti, atau menghapus baris deskripsi `///` milik objek yang dikenali, dan baris komentar `//` utuh tepat di atas step Power Query yang dikenali (§7.6). Semua byte lain dibiarkan apa adanya: tab, spasi, line ending, DAX, M, annotation, dan blank line.
- **Offline.** Tidak ada request jaringan, CDN, atau font eksternal. Metadata model tidak boleh keluar dari browser. **Satu-satunya pengecualian** adalah fitur Saran AI (opt-in, BYOK, persetujuan eksplisit): hanya data objek yang diminta yang dikirim ke Gemini/Claude/Copilotku, dan CSP hanya mengizinkan tiga host itu (Copilotku lewat Worker proxy BATIK).
- **Gagal dengan aman.** Kalau validator menemukan perubahan di luar baris deskripsi, tombol Copy diblokir.

---

## 2. Fakta TMDL yang relevan (sudah diverifikasi)

Sumber: Microsoft Learn, *Tabular Model Definition Language (TMDL)* — https://learn.microsoft.com/analysis-services/tmdl/tmdl-overview ; *Work with TMDL view* — https://learn.microsoft.com/power-bi/transform-model/desktop-tmdl-view ; *TMDL scripts* — https://learn.microsoft.com/analysis-services/tmdl/tmdl-scripts

| Topik | Aturan |
|---|---|
| Deskripsi | Ditulis sebagai baris `///` tepat di atas deklarasi objek, dengan indentasi yang sama. Multi-baris berarti beberapa baris `///` berurutan |
| Indentasi | Default **satu tab** per level. Strukturnya: level 1 deklarasi objek → level 2 properti → level 3 ekspresi multi-baris |
| Deklarasi | `<tipeObjek> <nama>` dengan `= <ekspresi>` opsional, contoh `measure 'Sales Amount' = SUM(...)` |
| Nama berkutip | Nama wajib diapit kutip tunggal `'...'` jika mengandung `.` `=` `:` `'` atau spasi. Kutip di dalam nama ditulis ganda `''` |
| Ekspresi multi-baris | Dimulai di baris setelah deklarasi dan diindentasi satu level lebih dalam dari properti objek (objek+2). Blank line di dalamnya termasuk bagian ekspresi |
| Ekspresi ber-backtick | `= ```` ` membuka blok; isinya dibaca verbatim (indentasi bebas, bisa lebih dangkal) sampai baris ```` ``` ```` penutup. **Parser wajib melacak state fence** |
| Case | Saat dibaca, keyword bersifat case-insensitive. Serializer menulis camelCase |
| Partial declaration | Satu tabel boleh dideklarasikan di beberapa segmen. Satu properti tidak boleh dideklarasikan dua kali |
| `ref` | `ref table X` mereferensikan objek tanpa mendefinisikannya ulang. Muncul di file `model.tmdl` (urutan koleksi) dan pada **script objek parsial**, misalnya saat hanya satu measure yang di-drag ke TMDL view |
| Script dari TMDL view | Diawali `createOrReplace`, lalu objek diindentasi satu level. Drag atau klik kanan → *Script TMDL* (ke tab baru atau clipboard). Mendukung multi-select dengan Ctrl, dan seluruh section (misalnya folder Tables) bisa di-drag sekaligus |
| Script seluruh model | Node **Semantic model** di Data pane bisa di-drag ke editor untuk men-script **seluruh model**. Ini adalah **skenario utama** app ini. Strukturnya sudah dikonfirmasi dari sampel asli, lihat §2.1 |
| Apply | Tombol **Apply** menjalankan script. `createOrReplace` mengganti objek beserta turunannya. Tidak memicu refresh data |
| Status | TMDL view di Power BI Desktop sudah **GA**. TMDL view di web masih Preview |

### 2.1 Struktur script seluruh model (dikonfirmasi dari sampel asli, 3.137 baris)

Hasil drag node *Semantic model* di Power BI Desktop:

```
createOrReplace                      ← depth 0
	model Model                      ← depth 1 (TIDAK ada `database`, TIDAK ada `ref`)
		culture: en-US               ← properti model (depth 2)
		dataAccessOptions            ← blok properti, anaknya di depth 3 (fastCombine, ...)
		/// deskripsi tabel
		table Calendar               ← objek level model di depth 2
			/// deskripsi kolom
			column Date              ← anak tabel di depth 3
				formatString: ...    ← properti di depth 4
				annotation ...       ← juga depth 4
			measure 'X' = ```        ← ekspresi ber-fence; isinya depth 5, campuran tab + spasi
					...
				```
			partition Calendar = calculated
				source =             ← ekspresi multi-baris di depth 6
		relationship <guid>          ← depth 2
		cultureInfo en-US
			linguisticMetadata = {...}   ← SATU baris JSON ±160.000 karakter
		/// deskripsi expression
		expression RootFolder = "..." meta [...]   ← shared query/parameter, depth 2
		expression 'Fn Transform DOT' = ```        ← fence di level expression
		/// deskripsi query group
		queryGroup 'Functions & Parameters'
		annotation PBI_QueryOrder = [...]
```

Temuan penting dari sampel:

- Line ending **CRLF**, **tanpa BOM**, file diakhiri CRLF. Indentasi **tab murni**; spasi hanya muncul di dalam isi ekspresi.
- Isi sampel: 11 tabel, 66 kolom, 57 measure, 13 expression, 5 queryGroup, 11 relationship, 13 blok fence. Tidak ada hierarchy atau calculation group.
- `expression` dan `queryGroup` juga bisa punya deskripsi `///` (6 dan 1 di sampel). Keduanya **di luar lingkup**: parser mengenalinya sebagai objek non-editable supaya isinya tidak salah terbaca, dan baris `///` miliknya dibiarkan utuh di output.
- Nama tanpa kutip bisa mengandung `+` dan `\`, contohnya `table VL06F+MB51` dan `queryGroup Staging\VL06F`. Jangan batasi nama tanpa kutip ke `[A-Za-z0-9_]`.
- Fence (```` ``` ````) umum dipakai untuk measure, kolom kalkulasi, dan expression. Penutup fence berada di indentasi properti, misalnya `\t\t\t\t\t```` ` untuk measure di depth 3.
- Ada baris yang sangat panjang (linguisticMetadata). Jangan render baris mentah di diff/preview tanpa dipotong.
- **Prototipe Python dari algoritma §7.1–7.3 sudah diuji pada sampel penuh.** Hasil jumlah objek cocok persis dengan hitungan manual, apply tanpa edit menghasilkan output identik byte-per-byte, dan 4 edit campuran (tambah, multi-baris dengan baris kosong, hapus, ganti) lolos validator skeleton.

### Contoh input realistis

> Ditampilkan dengan 4 spasi untuk keterbacaan. **File fixture asli wajib memakai tab.**

```
createOrReplace

    /// Tabel fakta penjualan harian
    table Sales
        lineageTag: 1111

        /// Total nilai penjualan setelah diskon
        measure 'Total Sales' = SUM(Sales[Amount])
            formatString: #,0
            lineageTag: 2222

        measure 'Sales YTD' =
                /// komentar DAX, BUKAN deskripsi
                TOTALYTD([Total Sales], 'Date'[Date])
            lineageTag: 3333

        column CustomerKey
            dataType: int64
            sourceColumn: CustomerKey

        partition Sales = m
            mode: import
            source =
                    let
                        Source = ...
                    in
                        Source
```

Contoh script parsial, misalnya saat hanya satu measure yang di-drag:

```
createOrReplace

    ref table Sales

        measure 'Total Sales' = SUM(Sales[Amount])
            formatString: #,0
```

---

## 3. Ruang lingkup

### MVP (Milestone 1–3)

- Objek yang bisa diberi deskripsi **hanya**: `table`, `column`, `measure`. Objek lain (termasuk `expression`, `queryGroup`, `partition`, dan `relationship`) tidak ditampilkan, tapi tetap utuh di output, termasuk deskripsi yang sudah ada padanya.
- Input dari paste atau drag-drop satu atau beberapa file `.tmdl`.
- Mendukung input dengan atau tanpa `createOrReplace`, mendukung `ref table`, dan mendukung CRLF/LF serta BOM.
- Editor grid, filter, progres, autosave, diff, validasi, dan Copy/Download.

### v1.1 (Milestone 4)

- Export/import CSV untuk diisi oleh SME.
- Bulk fill, cari-ganti di deskripsi, dan template sederhana.

### v2 (backlog, jangan dikerjakan sebelum diminta)

- `expression`, `queryGroup`, `hierarchy`, `level`, `calculationGroup`/`calculationItem`, `partition`, `function` (DAX UDF), `relationship`, dan `role`.
- Mode folder PBIP (banyak file → unduh ZIP).
- ~~Saran deskripsi via LLM API (opt-in eksplisit karena data keluar dari browser).~~ Selesai (Gemini, Claude, Copilotku via Worker BATIK; BYOK).
- Virtualisasi list untuk model yang sangat besar.

### Di luar lingkup

- Mengedit properti lain (nama, DAX, formatString, dan sebagainya).
- Menulis langsung ke file `.pbix` atau ke model.

---

## 4. Keputusan teknis

| Keputusan | Pilihan | Alasan |
|---|---|---|
| Bahasa | JavaScript ES2020, vanilla, JSDoc untuk tipe | Tanpa build toolchain berat |
| Dependency | **Nol** (runtime maupun dev) | Bisa jalan offline dan di laptop kantor |
| Struktur kode | Modul ES di `src/`, lalu digabung jadi satu file `dist/tmdl-description-editor.html` oleh `build.mjs` (Node murni) | Core bisa di-unit-test, hasil akhir tetap satu file |
| Test | `node --test` (built-in Node ≥ 18) | Tanpa Jest/Vitest |
| Core vs UI | `src/core/*` adalah **pure function, tanpa DOM**. UI ada di `src/ui/*` | Testable, dan aturan round-trip terkunci di core |
| Line ending | Dideteksi dari input (`\r\n` atau `\n`) dan dipakai lagi saat menulis. BOM dipertahankan | Hasil identik dengan aslinya |
| Indentasi | Unit indentasi dideteksi (tab, atau spasi dengan lebar tertentu). Writer menyalin **prefix whitespace persis** dari baris deklarasi | Aman untuk input non-standar |

---

## 5. Struktur repo

```
tmdl-description-editor/
├─ plan.md
├─ README.md
├─ package.json            # hanya "type": "module" + scripts: test, build. Tanpa dependencies
├─ build.mjs               # inline src/**/*.js + styles.css ke dist/*.html
├─ src/
│  ├─ index.html           # template; <!--INLINE_CSS--> dan <!--INLINE_JS--> diganti saat build
│  ├─ styles.css
│  ├─ core/
│  │  ├─ text.js           # detectEol, splitLines, joinLines, BOM, measureIndent
│  │  ├─ names.js          # parseObjectName, quoteName (kutip, escape '')
│  │  ├─ parser.js         # parseTmdl(text) -> ParseResult
│  │  ├─ writer.js         # applyDescriptions(parseResult, edits) -> string
│  │  ├─ validator.js      # validateRoundTrip(original, output) -> ValidationResult
│  │  ├─ diff.js           # lineDiff sederhana untuk preview
│  │  └─ csv.js            # toCsv / fromCsv (RFC 4180, BOM, ; atau ,)
│  └─ ui/
│     ├─ app.js            # bootstrap, state store
│     ├─ input-panel.js
│     ├─ grid.js
│     ├─ output-panel.js
│     └─ storage.js        # draft di localStorage (try/catch)
├─ test/
│  ├─ fixtures/            # *.tmdl dengan TAB asli, plus *.expected.tmdl
│  ├─ parser.test.js
│  ├─ writer.test.js
│  ├─ validator.test.js
│  ├─ names.test.js
│  └─ csv.test.js
└─ dist/
   └─ tmdl-description-editor.html
```

---

## 6. Model data

```js
/** @typedef {'table'|'column'|'measure'} ObjType */

/**
 * @typedef {Object} TmdlObject
 * @property {string}  key          // `${type}|${tableName}|${name}` (lowercase untuk lookup)
 * @property {ObjType} type
 * @property {string}  table        // nama tabel induk (untuk table = namanya sendiri)
 * @property {string}  name         // nama tanpa kutip, '' sudah di-unescape
 * @property {number}  declLine     // index baris deklarasi (0-based)
 * @property {number}  descStart    // index baris /// pertama; = declLine jika tidak ada deskripsi
 * @property {string}  indent       // prefix whitespace persis dari baris deklarasi
 * @property {string}  originalDesc // isi deskripsi asli, digabung dengan '\n'
 * @property {string=} expression   // ringkasan ekspresi (measure/kolom kalkulasi) untuk konteks UI
 * @property {string=} dataType
 * @property {boolean} isHidden
 * @property {boolean} editable     // false untuk `ref table`
 */

/**
 * @typedef {Object} ParseResult
 * @property {string[]} lines
 * @property {'\n'|'\r\n'} eol
 * @property {boolean} hasBom
 * @property {boolean} trailingNewline
 * @property {TmdlObject[]} objects
 * @property {{line:number, message:string}[]} warnings
 */
```

`edits` adalah `Map<key, string>` berisi deskripsi baru. String kosong berarti hapus deskripsi.

---

## 7. Algoritma

### 7.1 Parser (`parseTmdl`)

Parser bekerja per baris dalam satu pass, dengan stack konteks berbasis indentasi.

1. Buang BOM dan catat. Deteksi EOL. Split baris. Catat apakah teks diakhiri newline.
2. **Fence state.** Jika sebuah baris berakhiran `= ```` ` (setelah trim kanan), masuk ke mode fence. Semua baris berikutnya diabaikan sampai ketemu baris yang isinya (setelah trim) tepat ```` ``` ````. Isi fence tidak pernah dianggap deklarasi atau deskripsi.
3. Untuk baris di luar fence, hitung `depth` dari prefix whitespace. Unit indentasi dideteksi dari baris pertama yang terindentasi (tab = 1; jika spasi, pakai lebar spasi itu).
4. Kenali deklarasi dengan regex case-insensitive pada isi baris setelah indentasi:
   - `^(ref\s+)?table\s+(<nama>)\s*$`
   - Tidak ada regex untuk `expression`/`queryGroup`. Keduanya cukup ditangani oleh aturan "objek lain" di langkah 5: di-push sebagai non-container, isinya diabaikan.
   - `^(column|measure)\s+(<nama>)(\s*=.*)?$`
   - `<nama>` = `'(?:[^']|'')+'` atau `[^\s=:'.]+` (karakter seperti `+`, `\`, `&`, `-` boleh muncul tanpa kutip)
   - Satu baris bisa membuka fence sekaligus menjadi deklarasi (`measure 'X' = ```` `). Proses deklarasinya dulu, baru masuk ke mode fence.
5. Aturan konteks memakai **stack container**, bukan kedalaman tetap. Tujuannya supaya script satu tabel, multi-tabel, file PBIP, dan script **seluruh semantic model** semuanya tertangani:
   - Kelola stack `{keyword, depth}`. Setiap baris non-blank di luar fence akan mem-pop entri yang `depth >= depth baris`.
   - Keyword container: `createOrReplace`, `database`, `model` (dengan atau tanpa nama). Saat ditemukan, push ke stack.
   - `table` / `ref table` **hanya diterima jika semua entri di stack adalah container** (atau stack kosong). Jadi tabel di kedalaman 0, 1, 2, maupun 3 tetap dikenali selama induknya `createOrReplace`/`database`/`model`.
   - `column`/`measure` hanya diterima di `tableDepth + 1` saat tabel berada di puncak stack.
   - Objek lain di level model (`relationship`, `role`, `culture`, `perspective`, `expression`, `dataSource`, `queryGroup`, `function`, `annotation`, `ref ...`) di-push sebagai *non-container*. Isinya diabaikan, tapi tetap dibiarkan utuh di output.
   - Baris di kedalaman ≤ `tableDepth` yang bukan deskripsi atau blank akan menutup konteks tabel.
   - Baris yang lebih dalam (properti, ekspresi tanpa fence) diabaikan. Karena itu teks `column`/`measure` di dalam DAX tidak salah terdeteksi.
6. **Deskripsi.** Saat deklarasi yang valid ditemukan, telusuri mundur dari `declLine - 1` selama barisnya berbentuk `^<indent yang sama>///`. Rentang yang ditemukan menjadi `descStart..declLine-1`. Ambil isinya dengan menghapus `///` dan satu spasi pertama (jika ada). **Blank line memutus rangkaian deskripsi.**
7. `ref table X` membuat konteks tabel dengan `editable: false`. Anaknya tetap bisa diedit. Untuk `ref` yang lain (`ref culture`, `ref role`), baris diabaikan.
8. Kumpulkan metadata ringan untuk UI dari baris properti anak langsung: `dataType:`, `isHidden` (bentuk shortcut maupun `isHidden: true`), dan ringkasan ekspresi (sisa teks setelah `=` atau maksimal 3 baris ekspresi berikutnya).
9. Duplikat `key` (partial declaration atau `ref` lalu `table` penuh) ditandai sebagai warning. Ini bukan error, dan semua kemunculannya ikut di-update oleh writer.

### 7.2 Writer (`applyDescriptions`)

1. Salin `lines`.
2. Urutkan objek yang punya edit **berdasarkan `declLine` menurun**, supaya index baris di atasnya tidak bergeser.
3. Untuk tiap objek:
   - `newDesc = edit.replace(/\r\n?/g,'\n')`, lalu trim spasi kanan per baris dan buang blank line di awal dan akhir.
   - Jika `newDesc` sama dengan `originalDesc`, lewati (tidak ada perubahan byte).
   - `newLines = newDesc === '' ? [] : newDesc.split('\n').map(l => l === '' ? indent + '///' : indent + '/// ' + l)`
   - `lines.splice(descStart, declLine - descStart, ...newLines)`
4. Gabungkan dengan EOL asli, tambahkan newline akhir dan BOM sesuai kondisi aslinya.

### 7.3 Validator (`validateRoundTrip`)

Validator tidak sekadar menghapus semua baris `///`, karena komentar DAX `///` di dalam ekspresi harus tetap utuh.

1. `a = parseTmdl(original)`, `b = parseTmdl(output)`.
2. Untuk masing-masing, buat `skeleton` = semua baris **kecuali** baris dalam rentang deskripsi objek yang dikenali.
3. Syarat lolos:
   - `skeleton(a)` identik dengan `skeleton(b)`, baris per baris dan termasuk whitespace.
   - Himpunan `key` objek sama, dan urutannya sama.
   - Tidak ada baris deskripsi yang berisi CR atau LF di tengahnya.
   - EOL, BOM, dan newline akhir sama.
4. Jika gagal, kembalikan daftar `{line, expected, actual}` untuk ditampilkan di UI.

### 7.4 Excel (`xlsx.js`, `sheet.js`, `zip.js`)

> Sebelumnya CSV. Diganti Excel atas permintaan pengguna; CSV dihapus.

- Kolom: `Table, Type, Name, DataType, IsHidden, Expression, Description`. Satu sheet ("Deskripsi"), header tebal dan dibekukan, autofilter, lebar kolom, wrap untuk Expression/Description.
- Ditulis tanpa library: ZIP *stored* + SpreadsheetML minimal. Semua teks ditulis sebagai *inline string*, jadi nilai seperti `=SUM(...)` tidak pernah dianggap rumus. Batas 32.767 karakter per sel.
- Import: sheet pertama (lewat workbook.xml + rels), shared strings (rich text, abaikan phonetic), inline string, angka/boolean, prefix namespace, ZIP deflate via `DecompressionStream`. Header boleh Inggris atau Indonesia (Tabel/Tipe/Nama/Deskripsi); tipe boleh `kolom`/`tabel`.
- Baris dicocokkan lewat `Type|Table|Name` (case-insensitive). Ringkasan: N cocok, M tidak ditemukan, K berubah, lalu konfirmasi sebelum diterapkan.

### 7.5 Saran AI (`ai-prompt.js`, `src/ai/providers.js`, `src/ui/ai.js`)

- Provider: Copilotku (format OpenAI `/v1/chat/completions` lewat Worker `batik-copilotku-proxy`, model ber-awalan `copilotku:`, retry tanpa `reasoning_effort`; Worker harus mengizinkan origin `null`), Gemini (REST `generateContent`, `responseMimeType: application/json`, retry tanpa `thinkingBudget`) dan Claude (REST `/v1/messages` dengan header `anthropic-dangerous-direct-browser-access`, structured output `json_schema`, fallback tanpa `output_config`). Pola mengikuti `dama-explorer/web/src/ai/providers.ts`.
- Daftar model dimuat dari API; default Gemini Flash-Lite terbaru, lalu Claude Haiku. Model, bahasa (`id`/`en`), dan konteks bisnis disimpan di prefs; key di session/localStorage.
- Prompt: system prompt berisi aturan gaya (1–2 kalimat, ≤ ~200 karakter, tanpa mengulang rumus, tanpa mengarang, abaikan instruksi di dalam data). Pesan user berupa JSON: konteks bisnis, tabel terkait (deskripsi + nama kolom/measure ≤ 80), dan objek (id, tipe, nama, dataType, ekspresi ≤ 1.500 karakter, deskripsi yang ada). Jawaban `{"items":[{"id","description"}]}`.
- Batch: maks 25 objek / ±24.000 karakter, objek satu tabel dikelompokkan, 2 permintaan paralel, retry sekali untuk 429/5xx, berhenti total untuk error key/izin/model.
- Keamanan isi: hasil AI hanya diterapkan jika deskripsi objek tidak diubah pengguna selama proses berjalan. Menimpa deskripsi yang sudah terisi selalu didahului konfirmasi (per objek dan massal).

### 7.6 Power Query (M): deskripsi step dan query (`mquery.js`)

- Parser mencatat rentang kode M: partition `= m` → properti `source =` (tanpa fence: baris lebih dalam dari `source`; ber-fence: sampai penutup), dan `expression` (sekarang objek bertipe `expression` dengan deskripsi `///`).
- Tokenizer M: spasi, `//`, `/* */`, string `"…"` (`""`, boleh multi-baris), `#"…"`, identifier (boleh bertitik), angka, punctuator. Step = `nama =` di `let … in` tingkat atas (let pertama di luar kurung; header fungsi boleh). Koma pemisah dihitung hanya di luar kurung dan let bersarang. Gagal tokenisasi/struktur → query ditandai, tidak pernah ditulis.
- Deskripsi step = blok baris yang hanya berisi komentar `//` (token komentar baris yang dimulai di karakter non-spasi pertama) tepat di atas baris nama step; baris kosong memutus. Step yang namanya tidak di awal baris (mis. `A = 1, B = 2`, atau `let` sebaris) tidak bisa dikomentari.
- Key: `step|<queryKey>|<nama step mentah>` (case-sensitive), queryKey `partition|tabel|partition` atau `expression||nama`. Deskripsi query tabel = key tabel; expression = key expression.
- Writer menulis `indent + '// ' + teks` (baris kosong → `indent + '//'`) dengan indent persis baris step. Validator: skeleton juga mengecualikan rentang deskripsi step; daftar query/step (termasuk status bisa-dikomentari) harus sama dan berurutan.
- AI: satu permintaan per query (kode M ≤ 16.000 karakter, opsi sensor literal URL/server/path/email), jawaban `{"queryDescription","steps":[{id,description}]}`; AI tidak pernah menulis kode.

### 7.7 Refactor query M dengan AI (`refactor.js`)

- Artefak terpisah: hasil tidak pernah ditulis ke script TMDL (prinsip §1 tetap utuh). Disimpan di `doc.refactors` selama sesi.
- Prompt dari pemilik produk (`REFACTOR_PROMPT`) dengan parameter bahasa (`{LANG}`, `{SUMMARY}`), ditambah aturan aplikasi: kolom output/sumber data/referensi query/RangeStart-RangeEnd tidak boleh berubah, placeholder sensor dipertahankan, baris kosong antara ringkasan dan komentar step pertama (supaya Power Query tidak menggabungkannya ke deskripsi step pertama), jawaban JSON `{refactoredCode, alternativeCode, explanation}` (fallback: blok kode markdown).
- Pemanggilan: Claude effort `medium` + skema `refactor`; Gemini boleh berpikir; Copilotku `reasoning_effort: medium`; maks 16.000 token.
- Pemeriksaan (peringatan, tidak memblokir): bisa diurai + `let … in`; fungsi konektor dan literal URL/server/path sama; referensi ke query lain tidak hilang; RangeStart/RangeEnd tetap; placeholder sensor dikembalikan. Statistik baris kode (tanpa komentar/baris kosong; baris di string multi-baris dihitung) dan jumlah step.
- Output: Copy dan Download `.pq` (CRLF).

---

## 8. Spesifikasi UI

Tata letak tiga langkah dalam satu halaman, dengan tab/stepper: **1. Input → 2. Edit → 3. Output**.

**Input**
- Textarea besar dengan placeholder berisi langkah singkat dari Power BI Desktop.
- Zona drag-drop untuk file `.tmdl` (beberapa file sekaligus diperbolehkan; tiap file diproses dan di-output terpisah).
- Tombol **Parse**. Setelah parse, tampilkan ringkasan: "3 tabel, 48 kolom, 21 measure, 12 deskripsi sudah ada", ditambah warning jika ada.
- Jika ada draft di localStorage untuk input yang sama (dicocokkan lewat hash teks), tampilkan tawaran untuk memulihkannya.

**Edit**
- Karena skenario utama adalah script seluruh model (bisa ribuan objek), **grid hanya me-render satu tabel aktif** dalam satu waktu. Tampilan lintas tabel ("Semua kosong", hasil pencarian) dipaginasi, maksimal 200 baris per halaman. Jangan me-render ribuan textarea sekaligus.
- Sidebar daftar tabel dengan progres per tabel (contoh: `Sales 12/30`). Tabel bisa diurutkan berdasarkan nama atau "paling banyak yang kosong".
- Semua teks ekspresi atau baris yang ditampilkan dipotong (misalnya maksimal 300 karakter per baris di grid dan 2.000 di diff) karena ada baris JSON ±160.000 karakter.
- Grid berkolom: Tipe (ikon), Nama, DataType, Ekspresi (terpotong, lengkap saat hover/expand), dan **Deskripsi** (textarea auto-grow).
- Baris tabel itu sendiri ditampilkan paling atas di setiap grup.
- Filter: Semua / Kosong / Terisi / Diubah; sembunyikan objek `isHidden`; pencarian nama.
- Keyboard: `Enter` = simpan & pindah ke berikutnya, `Shift+Enter` = baris baru, `Esc` = batalkan perubahan sel, `Ctrl+F` = fokus pencarian.
- Penanda visual untuk deskripsi yang diubah dibanding aslinya, plus tombol reset per sel.
- Progres total di header.
- Autosave (debounce 500 ms) ke localStorage. Semua akses dibungkus try/catch.

**Output**
- Tampilan diff (hanya hunk yang berubah, dengan konteks ±2 baris).
- Status validator: hijau berarti siap dipakai; merah berarti Copy diblokir dan detail kesalahan ditampilkan.
- Tombol **Copy to clipboard** dan **Download .tmdl**.
- Panduan singkat: buka TMDL view → tab baru → paste → Apply. Sertakan saran backup (simpan PBIP / commit git sebelum Apply).
- Jika input adalah script seluruh model, tampilkan peringatan: Apply akan menjalankan `createOrReplace` untuk seluruh model. Validator menjamin hanya deskripsi yang berubah, tapi sebaiknya tetap simpan salinan script asli. Tambahkan tombol **Download original** sebagai backup.

**Gaya**
- CSS sendiri dengan variabel warna di `:root` supaya mudah di-theme. Mendukung light/dark mengikuti `prefers-color-scheme`.
- Font sistem, tanpa font eksternal.

---

## 9. Fixtures & kasus uji wajib

Setiap fixture punya `NN-nama.tmdl` (input) dan, bila relevan, `NN-nama.expected.tmdl` (output setelah edit tertentu yang didefinisikan di file test).

| # | Fixture | Yang diuji |
|---|---|---|
| 01 | `basic-table` | 1 tabel, 2 kolom, 1 measure, tanpa deskripsi. Tambah deskripsi ke semuanya |
| 02 | `existing-desc` | Deskripsi yang sudah ada dibaca dengan benar, lalu diubah, dihapus, dan dijadikan multi-baris |
| 03 | `quoted-names` | `'Total Sales'`, `'Cust''s Name'`, `'a.b'`, `'x=y'` |
| 04 | `multiline-dax` | Measure dengan DAX multi-baris yang berisi baris `column`, `measure`, dan `///` |
| 05 | `backtick-expr` | Ekspresi ```` ``` ```` yang indentasinya lebih dangkal dan berisi `table X` palsu |
| 06 | `partition-m` | Partition dengan M panjang, tidak ada objek palsu yang terdeteksi |
| 07 | `multi-table` | Beberapa tabel dalam satu script `createOrReplace` |
| 08 | `ref-table` | Script parsial `ref table Sales` + measure: tabel non-editable, measure editable |
| 09 | `no-wrapper` | File `.tmdl` mentah dari PBIP (root depth 0) |
| 10 | `crlf-bom` | CRLF + BOM dipertahankan persis |
| 11 | `spaces-indent` | Indentasi spasi; prefix ditiru persis |
| 12 | `blank-line-gap` | Ada blank line antara `///` dan deklarasi, sehingga bukan deskripsi milik objek itu |
| 13 | `calc-column` | Kolom kalkulasi `column X = ...` dengan ekspresi multi-baris |
| 14 | `unicode-desc` | Deskripsi berisi emoji, karakter `///`, tanda kutip, dan teks Indonesia |
| 15 | `idempotent` | Parse → apply tanpa edit menghasilkan output identik byte-per-byte dengan input |
| 16 | `case-insensitive` | Keyword `Table`, `MEASURE` tetap dikenali |
| 17 | `full-model` | **Sudah tersedia:** `17-full-model.tmdl` (313 baris, CRLF). Isinya potongan verbatim dari script seluruh model asli, dengan URL SharePoint diganti placeholder dan JSON linguisticMetadata dipersingkat. Hasil parse yang diharapkan ada di bawah tabel ini |
| 18 | `full-model-large` | Model sintetis ±200 tabel / ±5.000 kolom, ditambah satu baris JSON 200.000 karakter (dibuat oleh script generator di `test/`). Parse + write harus selesai < 1 detik di Node |
| 19 | `perspective-names` | `perspectiveTable Sales` / `perspectiveColumn X` tidak terdeteksi sebagai tabel atau kolom |

Setiap test writer juga menjalankan validator pada hasilnya, dan validator harus lolos.

**Expected parse untuk fixture 17** (urutan sesuai kemunculan; `✓` = sudah punya deskripsi):

| type | table | name | desc |
|---|---|---|---|
| table | Calendar | Calendar | ✓ |
| column | Calendar | Date | ✓ |
| column | Calendar | Month | ✓ |
| table | Measures Table | Measures Table | ✓ |
| measure | Measures Table | OT Terminal Not Adjusted | ✓ |
| measure | Measures Table | Label status pengisian realisasi | ✓ (fence) |
| measure | Measures Table | SPBE Performance Indicator | ✓ (fence) |
| table | Last Refresh | Last Refresh | ✓ |
| column | Last Refresh | Timestamp | — |
| table | VL06F+MB51 | VL06F+MB51 | ✓ |
| column | VL06F+MB51 | FlagSupplySPBE | ✓ (kolom kalkulasi, fence) |

Total: 4 table, 4 column, 3 measure. Tidak ada objek yang berasal dari `expression`, `queryGroup`, `relationship`, `cultureInfo`, `annotation`, `dataAccessOptions`, maupun isi fence/partition. Deskripsi `///` milik `expression RootFolder` dan `queryGroup 'Functions & Parameters'` harus tetap ada, tanpa perubahan, di output.

---

## 10. Milestone & tugas

Kerjakan berurutan. Centang `[x]` setelah selesai dan test hijau.

### Milestone 0 — Scaffold
- [x] `package.json` (`"type":"module"`, script `test` = `node --test test/*.test.js`, script `build` = `node build.mjs`), tanpa dependencies. *(`node --test test/` tidak menerima direktori di Node 22, lihat §12)*
- [x] Struktur folder sesuai §5
- [x] `build.mjs` meng-inline CSS dan JS ke `dist/tmdl-description-editor.html`. Modul digabung dalam urutan dependensi atau dibundel sederhana (hapus `import`/`export`, bungkus dalam IIFE)
- [x] README singkat (cara pakai dan cara build)
- **Selesai jika:** `npm test` berjalan (0 test) dan `npm run build` menghasilkan HTML kosong yang bisa dibuka di browser tanpa error console.

### Milestone 1 — Core parser
- [x] `text.js`, `names.js` beserta test
- [x] `parser.js` sesuai §7.1. Prototipe Python yang sudah lolos uji pada sampel asli tersedia di `reference/proto_parse.py` sebagai acuan logika. Jangan diport mentah: kode JS harus mengikuti model data §6 dan memakai prefix indent persis (bukan asumsi tab)
- [x] Fixture 01–16 (input) dan test parser: jumlah objek, key, `descStart`, `originalDesc`, `editable`, dan warning
- **Selesai jika:** semua test parser hijau, termasuk 04, 05, 06, dan 12 (tidak ada objek palsu).

### Milestone 2 — Writer & validator
- [x] `writer.js` sesuai §7.2
- [x] `validator.js` sesuai §7.3
- [x] `diff.js` (Myers O(ND) + hunk)
- [x] File `*.expected.tmdl` dan test writer
- **Selesai jika:** fixture 15 menghasilkan output identik byte-per-byte, semua expected cocok, dan validator lolos untuk semua hasil writer serta gagal untuk output yang sengaja dirusak (tambahkan test negatif).

### Milestone 3 — UI MVP
- [x] Panel input (paste dan drag-drop), ringkasan, dan warning
- [x] Grid editor, sidebar tabel, filter, pencarian, keyboard, dan progres
- [x] Panel output (diff, status validasi, Copy, Download)
- [x] Autosave dan pemulihan draft
- [x] Build ke satu file. E2E headless (Chromium/Playwright, di luar repo) dengan fixture 17: paste → edit → output identik dengan `17-full-model.expected.tmdl`, 0 request jaringan, 0 error console
- [ ] Uji manual dengan script asli dari Power BI Desktop (paste, isi, copy, **Apply di TMDL view**, lalu cek deskripsi muncul di Model view). **Perlu dilakukan pengguna**
- **Selesai jika:** alur end-to-end berhasil pada minimal satu model nyata, dan tidak ada request jaringan di DevTools.

### Milestone 4 — v1.1
- [x] `csv.js` beserta test (quoting, multi-baris, BOM, `;` dan `,`)
- [x] Export/import CSV dengan layar ringkasan pencocokan
- [x] Bulk fill untuk baris terpilih, dan cari-ganti di deskripsi
- [x] Template sederhana dengan placeholder `{name}` dan `{table}` (plus `{type}`)

### Backlog v2
Lihat §3. Jangan dikerjakan tanpa konfirmasi.

---

## 11. Aturan kerja untuk Claude Code

- Jangan menambah dependency apa pun (npm, CDN, atau font).
- Logika TMDL hanya boleh ada di `src/core/`, dan semuanya pure function. UI tidak boleh memanipulasi teks TMDL secara langsung.
- Setiap perubahan pada parser atau writer harus disertai test dan fixture baru jika menyangkut kasus baru.
- Fixture wajib memakai **tab asli**. Jangan biarkan editor mengubah tab menjadi spasi. Tambahkan `.editorconfig` dengan aturan khusus untuk `test/fixtures/*.tmdl`: `indent_style = tab`, `trim_trailing_whitespace = false`, `insert_final_newline = false`.
- Jalankan `npm test` sebelum menyatakan sebuah tugas selesai. Jalankan `npm run build` setelah ada perubahan UI.
- Kalau menemukan sintaks TMDL yang belum tercakup, tambahkan sebagai fixture dan catat di §12. Jangan menebak.

---

## 12. Pertanyaan terbuka / catatan

- [x] ~~Konfirmasi struktur script seluruh model.~~ Selesai: `createOrReplace` → `model Model` → objek model di depth 2. Lihat §2.1 dan fixture 17.
- [x] Sampel asli lengkap (3.137 baris) **tidak** dimasukkan ke repo karena berisi logika bisnis. Simpan di luar repo (misalnya `local-samples/`, masukkan ke `.gitignore`) untuk uji manual atau smoke test lokal. *(`local-samples/` sudah ada di `.gitignore`.)*
- [ ] Apakah deskripsi tingkat `model` (`model Model`) perlu didukung? Untuk sementara tidak.
- [ ] Backlog: opsi output **"hanya tabel yang berubah"**, yaitu script `createOrReplace` yang lebih kecil berisi blok tabel yang diedit saja (disalin verbatim, indentasi disesuaikan). Tujuannya mengurangi cakupan Apply pada model besar. Harus divalidasi dengan uji Apply manual sebelum dijadikan default.
- [ ] Bagaimana perilaku TMDL view jika satu script berisi `ref table X` dan `table X` penuh sekaligus? Uji manual di Milestone 3.
- [ ] Apakah Power BI Desktop pernah menghasilkan indentasi selain tab saat scripting? Asumsinya selalu tab, tapi parser tetap toleran.
- [x] ~~Batas panjang deskripsi.~~ Diimplementasikan sebagai peringatan lunak di grid jika lebih dari 500 karakter (tidak memblokir).

### Catatan implementasi (Milestone 0–4)

- **Script test:** `node --test test/` gagal di Node 22 (direktori tidak diterima), jadi diganti `node --test test/*.test.js`. Pola ini di-expand oleh shell di Node 18/20 dan didukung langsung oleh Node 21+.
- **Textarea → LF:** nilai `<textarea>` selalu dinormalkan browser ke LF, sehingga script yang ditempel dari clipboard menjadi LF dan output-nya juga LF (konsisten dengan input yang diterima app). File yang di-drag dibaca dengan `TextDecoder({ignoreBOM:true})`, jadi BOM dan CRLF tetap persis.
- **Clipboard tanpa BOM:** tombol Copy membuang BOM di awal teks, sedangkan Download mempertahankannya.
- **Fence:** pembuka adalah baris yang berakhiran `=` lalu tiga backtick atau lebih. Penutupnya baris yang isinya (setelah trim) tepat sama dengan deretan backtick pembuka. Baris `///` tidak pernah membuka fence, sehingga deskripsi yang berisi tiga backtick aman (fixture 14).
- **Kedalaman indentasi** dihitung dalam unit: tab = 1, spasi = lebar unit yang terdeteksi (4 untuk file bertab). `column`/`measure` wajib di `tableDepth + 1`.
- **Regex `table`** juga menerima `= ...` opsional (mengikuti prototipe) supaya tidak gagal diam-diam. Belum pernah terlihat di output Power BI.
- **Writer** memakai satu pass linear (map `declLine → baris baru`), hasilnya ekuivalen dengan splice bottom-up di §7.2 tapi O(n). Objek `editable: false` (`ref table`) tidak pernah ditulis. Duplikat key yang editable semuanya ikut di-update.
- **Validator** juga memeriksa bahwa deskripsi objek `ref` tidak berubah.
- **Ringkasan ekspresi** ikut menyertakan komentar `///` DAX yang dalam (hanya untuk konteks di UI), maksimal 40 baris / 4.000 karakter. Grid memotong per baris di 300 karakter, dan diff di 2.000.
- **Fixture 18** dibuat di memori oleh `test/gen-full-model-large.mjs` (±980 KB, 200 tabel, 5.000 kolom, 1.000 measure, JSON 200.000 karakter). Di Node: parse ±50 ms dan write ±20 ms. Di Chromium: parse + ringkasan ±0,6 detik, halaman Output (write + validate + diff) ±0,15 detik.
- **CSP** `connect-src 'none'` dipasang di HTML sebagai jaminan offline.
- **Duplikat key / partial declaration** digabung menjadi satu baris di grid (`items.js`), dengan penanda `×N`.
- **Bulk fill** tanpa baris tercentang menargetkan semua objek editable di tampilan aktif (dengan konfirmasi jumlah di modal).
- **Excel menggantikan CSV** (permintaan pengguna). Writer/reader `.xlsx` ditulis sendiri tanpa dependency; diverifikasi terbaca openpyxl, dan file yang disimpan ulang openpyxl terbaca kembali.
- **Saran AI (Gemini, Claude)** ditambahkan dengan persetujuan eksplisit.
- **Copilotku** memakai Worker BATIK yang sudah ada (`https://batik-copilotku-proxy.ivan-saja.workers.dev`), tanpa Worker baru. Syarat di sisi Worker: tambahkan `null` ke `ALLOWED_ORIGINS` (`web/copilotku-proxy/wrangler.toml`, repo dama-explorer) lalu deploy ulang. Konsekuensi: halaman `file://` mana pun bisa memakai Worker (tetap butuh key sendiri), dan kuota gratis 100.000 request/hari dipakai bersama BATIK. Worker yang menolak origin menjawab tanpa header CORS, sehingga browser hanya melaporkan error jaringan; pesan error editor menjelaskan langkah perbaikannya.
- **Uji manual Power Query (Milestone 0 fitur M), oleh pengguna di Power BI Desktop:** (1) komentar `//` di atas step tampil sebagai deskripsi step, (3) `///` di atas `expression` tampil di Query properties, (4) deskripsi step yang diubah lewat UI tetap berbentuk `//`; deskripsi tabel = deskripsi query tabel dua arah (Query properties diisi → `///` di atas `table`; `///` dari TMDL → tampil di Query properties dan tooltip); Close & Apply tanpa menyentuh Query properties tidak menimpa deskripsi tabel; mengubah komentar M lalu Apply tidak menghapus data dan tidak memunculkan peringatan refresh.
- **Bug diperbaiki:** jalur Claude selalu mengirim skema structured output milik fitur deskripsi objek, termasuk untuk saran deskripsi step M (jawaban dipaksa berbentuk `{items}` sehingga saran M gagal). Sekarang tiap fitur mengirim skemanya sendiri (`SCHEMAS.descriptions|mquery|refactor`).
- **Audit kontras (WCAG 2.1 AA, axe-core + hitungan token, 13 layar × terang/gelap):** diperbaiki toast sukses/error di mode gelap (teks gelap `--on-status`), label "diubah" (`--changed` terang `#8a5a00`), placeholder (pakai `--muted`), baris read-only (tanpa opacity seluruh baris), hijau OK terang (`#17703f`), tepi input/tombol (`--border-strong` `#8a94a3` / `#5d6878`, ≥ 3:1). Hasil pindai ulang: 0 pelanggaran.
