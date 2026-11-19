# Roadmap Audit, Pengembangan, dan Perbaikan FMart

Tanggal pembaruan: 19 November 2026  
Repository: https://github.com/appfathanmubina/fmart  
Branch produksi sumber: `main`

## Prinsip pelaksanaan

1. Perubahan dilakukan bertahap, terfokus, dan menjaga fitur serta tampilan yang sudah baik.
2. Perubahan masuk ke `main` setelah pemeriksaan kode, regresi, dan CI berhasil.
3. Tahap 16–31 adalah penyelesaian audit/pengembangan berbasis repository.
4. Pengujian runtime Apps Script, akun nyata, perangkat, transaksi nyata, Drive, dan notifikasi nyata dilakukan setelah Tahap 31 selesai.
5. Tidak mengubah database produksi selama audit berbasis repository.
6. Nilai modal persediaan tidak boleh disimpulkan dari harga jual. Fitur valuasi memerlukan data harga perolehan dan metode penilaian biaya yang disepakati.

## Status tahapan

| Tahap | Ruang lingkup | Status |
|---|---|---|
| 16 | Pemisahan stok Gudang dan Kasir | Selesai |
| 17 | Mesin pesanan Wali ketika stok kurang | Selesai |
| 18 | Pengantaran oleh Gudang | Selesai |
| 19 | Privasi informasi stok bagi Wali | Selesai |
| 20 | Konsistensi snapshot penerima pesanan | Selesai |
| 21 | Integritas hubungan resmi Wali–Santri dan privasi data Santri | Selesai |
| 22 | Login, OTP, session, dan hak akses | Selesai |
| 23 | Integritas database dan kompatibilitas data lama | Selesai |
| 24 | Checkout, pembayaran, dan transaksi | Selesai |
| 25 | Stok, penerimaan, mutasi, dan pengeluaran | Selesai |
| 26 | Laporan, kartu persediaan, dan pengamanan valuasi | Selesai dengan batasan valuasi |
| 27 | Notifikasi, pengantaran, dan riwayat aktivitas | Selesai |
| 28 | Audit tampilan PWA Admin dan Wali | Selesai secara statis; visual perangkat menunggu runtime |
| 29 | Performa, cache, service worker, dan instalasi PWA | Selesai |
| 30 | Audit matriks endpoint dan alur per role | Selesai secara statis/regresi |
| 31 | Audit akhir kode dan kesiapan produksi | Selesai secara statis; produksi belum dinyatakan siap sebelum runtime |
| 32 | Gerbang audit runtime: entry point aman dan instruksi eksekusi | Selesai pada source/dokumentasi; runtime menunggu eksekusi operator |

## Ringkasan perbaikan tahap 22–30

- **Tahap 22:** penggantian email staf tidak mengubah data akun jika pengiriman verifikasi gagal; sesi tetap terikat pada status akun, role, dan timestamp keamanan.
- **Tahap 23:** referensi Santri pada keranjang/pesanan menjadi opsional sesuai model penerima manual; referensi pemilik tetap wajib dan referensi legacy tetap divalidasi.
- **Tahap 24:** pemulihan verifikasi pembayaran yang terputus dapat dilanjutkan tanpa mengulang efek samping atau menggandakan notifikasi/audit.
- **Tahap 25:** mutasi stok dan transfer Gudang–Kasir menggunakan request key, jurnal, dan pemulihan saldo yang fail-closed.
- **Tahap 26:** kartu persediaan diurutkan berdasarkan waktu dan memvalidasi rantai saldo, duplikasi, timestamp, serta saldo fisik. Nilai modal tetap tidak dihitung tanpa harga perolehan.
- **Tahap 27:** mulai pengantaran dan pelaporan gagal dapat dipulihkan setelah proses terputus dengan deduplikasi notifikasi, riwayat, dan audit.
- **Tahap 28:** pemeriksaan CSS menemukan aturan responsif ponsel/tablet/desktop, modal, navigasi, dan tabel. Tidak ada perubahan visual spekulatif tanpa pemeriksaan perangkat.
- **Tahap 29:** service worker lebih tahan terhadap kegagalan CDN OneSignal, cache shell tidak all-or-nothing, dan aset same-origin disimpan pada permintaan pertama.
- **Tahap 30:** entry point hapus keranjang Wali memiliki guard eksplisit dan regresi matriks role utama ditambahkan.

## Hasil CI terbaru

Commit `a98c2a5f75086d7818ad0aafb9bbe106e1cc917a` pada `main`:
- 58 pengujian lulus, 0 gagal.
- Sintaks backend lulus.
- Sintaks service worker lulus.
- Pemeriksaan whitespace lulus.

Hasil tersebut adalah pemeriksaan kode otomatis, bukan bukti bahwa deployment Apps Script, akun, Drive, trigger, push notification, atau perangkat sudah berjalan benar.

## Batasan dan keputusan yang masih diperlukan

### 1. Valuasi persediaan

Database saat ini belum memiliki harga pokok/biaya perolehan yang cukup untuk menghitung nilai modal persediaan secara akuntabel. Sebelum mengembangkan fitur ini, pemilik proses perlu memilih metode penilaian biaya, misalnya:
- rata-rata bergerak (moving weighted average); atau
- FIFO.

Setelah metode dipilih, perlu dirancang pencatatan biaya per baris penerimaan, transfer Gudang–Kasir, penjualan, retur, dan koreksi stok. Jangan memakai harga jual sebagai harga pokok.

### 2. Runtime dan kesiapan produksi

Tahap berikutnya setelah audit repository adalah pemeriksaan runtime terkontrol:
1. Pastikan proyek Apps Script yang dideploy berisi file `Code.gs`, `SetupDatabase.gs`, dan `Index.html` yang sama dengan `main`.
2. Jalankan fungsi audit read-only `auditFMartRuntime_()` dan `auditFMartDatabaseIntegrity_()` dari Apps Script Editor.
3. Periksa Spreadsheet ID/Script Properties dan akses folder Drive tanpa membagikan kredensial atau ID sensitif.
4. Periksa trigger `processDeliveryAutoConfirmation_` dan riwayat **Executions**.
5. Uji login dan alur Wali, Kasir, Gudang, Petugas Pengantar, Admin, dan Superadmin dengan akun masing-masing.
6. Uji checkout, pembayaran, stok kurang, penerimaan, mutasi, transfer, penjualan Kasir, pengantaran, bukti foto, komplain, notifikasi, laporan, dan logout.
7. Uji PWA Wali dan Admin pada desktop serta ponsel, termasuk pemasangan, pembaruan cache, koneksi terputus, dan pemulihan koneksi.
8. Cocokkan transaksi, saldo stok, bukti pembayaran/Drive, laporan, dan audit log.
9. Perbaiki setiap temuan runtime, jalankan CI lagi, lalu lakukan audit akhir produksi.

Jangan jalankan setup/migrasi atau fungsi yang mengubah struktur/trigger hanya sebagai pemeriksaan. Lakukan perubahan data hanya setelah target dan dampaknya dipastikan.

## Keputusan status produksi

**Status: belum dinyatakan siap produksi.**  
Audit source dan CI selesai, tetapi validasi runtime, perangkat, akun nyata, rekonsiliasi data aktual, serta keputusan metode valuasi masih menjadi prasyarat.


## Tahap 32 — Gerbang audit runtime dan instruksi eksekusi

**Status repository: selesai. Status runtime: belum dijalankan.**

Audit source menemukan ketidaksesuaian penting: dokumentasi meminta operator menjalankan `runFMartReadinessAudit()`, tetapi implementasi yang tersedia hanya bernama internal `runFMartReadinessAudit_()`. Fungsi dengan akhiran underscore tidak ditampilkan sebagai entry point publik di Apps Script Editor. Kondisi ini berisiko membuat operator tidak menemukan fungsi audit yang harus dijalankan.

Perbaikan Tahap 32:
- Memastikan audit gabungan tetap menggunakan fungsi privat `runFMartReadinessAudit_()`, yang dapat dijalankan manual dari Apps Script Editor tetapi tidak diekspos sebagai endpoint `google.script.run`.
- Memperbaiki `docs/UAT-TAHAP-4-FMART.md` agar operator menjalankan fungsi privat `runFMartReadinessAudit_()` dari daftar fungsi editor. Wrapper publik tanpa underscore sengaja tidak dibuat demi mencegah eksposur sebagai endpoint browser.
- Menghapus instruksi menjalankan setup database sebagai prasyarat audit read-only. Setup/migrasi hanya boleh dilakukan sebagai pekerjaan terpisah setelah hasil audit membuktikan perlu, target database dipastikan, dan backup tersedia.
- Audit gabungan tetap memanggil pemeriksaan database, runtime, sinkronisasi operasional, stok/POS, penerimaan, dan pemulihan transaksi. Hasil dicatat ke Execution log.

**Batasan:** perubahan ini menyiapkan jalur audit; tidak menjalankan Apps Script, tidak membaca database produksi, tidak mengubah Spreadsheet/Drive, dan tidak menguji akun/perangkat. Operator tetap perlu menjalankan `runFMartReadinessAudit_` di Apps Script Editor dan mengirimkan hasil yang telah disamarkan. Jangan mengirim password, OTP, token, Spreadsheet ID, folder ID, atau data pribadi.


## Tahap 33 — Tindak lanjut temuan runtime pertama

**Status: audit runtime pertama diterima; perbaikan audit source ditindaklanjuti. Data produksi belum diubah.**

Temuan aktual dari eksekusi 19 November 2026:
- Master Santri memiliki tiga baris duplikat ID dan NIS (baris 142–144 merujuk baris pertama 139–141). Perlu verifikasi data sumber dan seluruh referensi sebelum koreksi.
- Runtime tidak menemukan akun aktif role ADMIN dan PETUGAS_PENGANTAR.
- Folder Drive bukti pengantaran belum dikonfigurasi; folder bukti pembayaran tersedia dan aksesnya privat.
- Mutasi stok masuk manual baris 2 tidak ditemukan pasangan AuditLog oleh pemeriksaan saat ini.
- Pemeriksaan stok/POS dan pemulihan transaksi tidak melaporkan issue.
- Spreadsheet dan trigger auto-confirm ditemukan.

Perbaikan source yang dibuat pada tindak lanjut Tahap 33:
1. Memperbaiki pencocokan AuditLog mutasi masuk manual. Kolom EntityId pada `writeAudit_()` berisi request key, bukan ProdukId; payload AuditLog menyimpan ProdukId, variasi, tipe, qty, dan saldo sebelum/sesudah. Pemeriksaan kini mencocokkan request key (dengan kompatibilitas ID produk legacy), payload lengkap, dan timestamp yang sama.
2. Memperluas audit sinkronisasi agar produk aktif tanpa variasi yang belum memiliki baris saldo kanonis di sheet `Stok` ikut terdeteksi. Pemeriksaan sebelumnya hanya mendeteksi baris stok yang hilang untuk variasi atau item yang sudah memiliki histori mutasi.
3. Menambahkan regresi untuk kedua kondisi tersebut.

**Batasan:** tidak mengubah data Santri, akun, Script Properties, folder Drive, stok, atau AuditLog produksi. Temuan data/configuration harus ditangani terpisah setelah verifikasi pemilik data.


## Pembaruan tindak lanjut operator — 19 November 2026

Operator melaporkan tindak lanjut atas temuan Tahap 33:
- Baris duplikat master Santri sudah dihapus oleh operator. Status integritas belum ditandai bersih sampai audit read-only dijalankan ulang.
- Akun role `ADMIN` dan `PETUGAS_PENGANTAR` memang belum dibuat dan akan dibuat kemudian oleh operator. Ini adalah keputusan operasional yang disengaja; aplikasi tidak boleh membuat atau mengaktifkan akun tersebut otomatis.
- Script Property `FMART_DELIVERY_PROOF_FOLDER_ID` sudah ditambahkan oleh operator. Akses folder dan pembacaan konfigurasi masih perlu dikonfirmasi oleh audit runtime ulang.
- Tidak ada perubahan data produksi yang dilakukan oleh pekerjaan repository ini.

## Status tindak lanjut runtime Tahap 33

**Menunggu audit read-only ulang dari operator.** Setelah sinkronisasi source Tahap 33 ke Apps Script, jalankan `runFMartReadinessAudit_()` sekali lagi dan bagikan hasil yang sudah disamarkan.

Kriteria pemeriksaan ulang:
1. Temuan duplikasi `SantriId` dan NIS sudah tidak muncul.
2. Folder `deliveryProof` terdeteksi configured, accessible, dan private.
3. Pemeriksaan manual inbound audit tidak lagi menghasilkan false positive.
4. Pemeriksaan stok produk aktif menunjukkan kondisi master stok aktual. Jika ada `PRODUCT_STOCK_ROW_MISSING`, jumlah dan daftar ID internal harus ditinjau; jangan menjalankan perbaikan massal tanpa rekonsiliasi.
5. Role ADMIN dan PETUGAS_PENGANTAR yang belum dibuat tetap boleh muncul sebagai peringatan konfigurasi. Tidak dibuat otomatis.

Audit read-only ulang tidak menguji transaksi, tidak membuat akun, tidak membuat folder, dan tidak mengubah data. Jangan lanjut ke uji transaksi end-to-end sebelum integritas data dan konfigurasi dasar terkonfirmasi.

## Roadmap lanjutan Tahap 34–40

| Tahap | Ruang lingkup | Kegiatan utama | Kriteria selesai |
|---|---|---|---|
| 34 | Rekonsiliasi master Santri dan integritas data aktual | Jalankan ulang audit; verifikasi duplikasi, NIS, SantriId, relasi Wali–Santri, dan referensi transaksi lama | Tidak ada duplikasi/relasi ambigu; semua temuan dijelaskan dan disetujui sebelum perubahan data |
| 35 | Validasi akun, role, dan konfigurasi Drive | Konfirmasi role yang memang akan dioperasikan; uji akses folder bukti pembayaran/pengantaran; periksa trigger dan Executions | Hak akses sesuai desain; folder bukti tetap privat; trigger terbukti berjalan atau temuan tercatat |
| 36 | Rekonsiliasi stok Gudang, Kasir, dan penerimaan | Cocokkan master produk/variasi, saldo stok kanonis, mutasi, penerimaan, transfer, reservasi, dan saldo fisik | Tidak ada saldo ganda/negatif atau selisih tak terjelaskan; stok Wali tetap tersembunyi |
| 37 | Validasi transaksi dan pemulihan | Uji keranjang, checkout, pembayaran, verifikasi, stok kurang, POS Kasir, pembatalan, retry/idempotency, dan pemulihan proses terputus | Tidak ada transaksi ganda, saldo salah, status saling bertentangan, atau notifikasi ganda |
| 38 | Validasi PWA, tampilan, dan perangkat | Uji jalur Wali/Admin pada desktop dan HP; navigasi, modal, gambar, cache, instalasi, jaringan putus/pulih, dan sesi | Alur inti dapat digunakan pada perangkat sasaran tanpa regresi visual/fungsional yang menghambat |
| 39 | Perbaikan temuan akhir dan audit kesiapan produksi | Perbaiki temuan Tahap 34–38; jalankan regresi penuh, audit keamanan endpoint, dan rekonsiliasi akhir | Semua temuan kritis/tinggi ditutup; CI lulus; checklist produksi ditandatangani |
| 40 | Dokumentasi operasional dan serah-terima produksi | Finalisasi SOP akun, katalog, stok, penerimaan, transaksi, pengantaran, backup, pemulihan, dan prosedur insiden | Dokumen operasional lengkap; status produksi diputuskan berdasarkan bukti audit, bukan hanya CI |

### Pengembangan katalog foto produk

**Kondisi saat ini:** formulir Produk menyediakan kolom `URL foto (opsional)`; backend menyimpan URL HTTP/HTTPS pada kolom `FotoUrl`. URL tersebut dipakai oleh katalog Wali, detail produk, dan keranjang. Belum ada kontrol unggah file langsung pada formulir.

**Peningkatan yang direncanakan sebagai Tahap 41 (fitur pengembangan setelah gerbang audit runtime):**
- Tombol pilih/ambil foto dari perangkat pada form Tambah/Edit Produk.
- Upload melalui backend Apps Script ke folder khusus `FMART_PRODUCT_IMAGE_FOLDER_ID`, terpisah dari folder bukti pembayaran dan pengantaran.
- Validasi MIME, ukuran, nama file, dan kepemilikan file terhadap folder khusus.
- Simpan referensi file yang stabil pada master Produk; jangan membuka folder bukti transaksi kepada publik.
- Sajikan foto ke katalog melalui jalur yang aman dan efisien, dengan fallback gambar kosong bila file hilang/tidak dapat diakses.
- Saat foto diganti, lakukan penghapusan file lama hanya setelah referensi baru berhasil tersimpan dan tidak ada produk lain yang menggunakannya.
- Tambahkan regresi untuk upload gagal, file tidak valid, file tidak berada di folder, foto lama, dan foto tanpa akses.
- Pertahankan dukungan URL foto lama agar data produk yang sudah ada tetap kompatibel.

**Kriteria selesai:** Admin dapat menambah/mengganti foto dari HP maupun desktop; Wali dapat melihat foto tanpa memperoleh akses ke folder bukti transaksi; kegagalan upload tidak merusak data produk atau foto sebelumnya.

### Keputusan valuasi persediaan — masih terbuka

Sebelum fitur nilai modal persediaan dikembangkan, pemilik proses perlu memilih metode biaya: rata-rata bergerak atau FIFO. Desain harus mencatat harga perolehan pada detail penerimaan dan mengalirkannya secara konsisten pada transfer, penjualan, retur, dan koreksi stok. Harga jual tidak boleh dipakai sebagai pengganti harga pokok.

## Gerbang kelulusan akhir

FMart belum boleh dinyatakan siap produksi hanya karena semua PR sudah merge atau CI lulus. Status siap produksi baru dapat diputuskan setelah:
- audit integritas aktual dan konfigurasi runtime selesai;
- akun yang diperlukan tersedia dan berhasil diuji oleh pemilik masing-masing;
- seluruh alur transaksi dan pemulihannya lulus pada runtime terkontrol;
- PWA diuji pada perangkat sasaran;
- bukti transaksi, Drive, stok, laporan, dan AuditLog direkonsiliasi;
- temuan kritis/tinggi ditutup dan SOP operasional tersedia.

Pekerjaan repository dapat diselesaikan lebih dahulu, tetapi gerbang runtime tetap memerlukan eksekusi dan bukti dari Apps Script serta perangkat yang dikelola operator.


## Hasil audit runtime ulang — 19 November 2026, 09:32 WIB

Operator mengirimkan Execution log baru setelah membersihkan duplikasi Santri dan menambahkan Script Property folder pengantaran. Hasil yang terbaca:
- Pemeriksaan database: **0 issue**; jumlah Santri 708.
- Total gabungan: **297 issue**.
- Runtime: 2 issue, hanya role ADMIN dan PETUGAS_PENGANTAR yang belum aktif (sesuai rencana operator).
- Operational sync: 294 issue `PRODUCT_STOCK_ROW_MISSING`, pada baris Produk 3–296; jumlah produk 295, variasi 0, baris Stok 1.
- Stock/POS, Cashier POS, dan Transaction Recovery: 0 issue.
- Warehouse receiving: 1 issue `MANUAL_INBOUND_AUDIT_MISSING` pada MutasiStok baris 2.
- Folder pembayaran dan folder pengantaran keduanya terbaca accessible/private, tetapi **keduanya bernama "FMart - Bukti Pembayaran"**. Ini menunjukkan kemungkinan besar Script Property folder pengantaran menunjuk folder pembayaran yang sama. Perlu dipisahkan; jangan mengunggah bukti pengantaran ke folder pembayaran.

### Tindak lanjut berdasarkan bukti

1. **Master Santri (Tahap 34):** pemeriksaan database kini bersih. Tahap 34 masih memerlukan pengecekan referensi relasi/pesanan dan dapat ditutup setelah konfirmasi tidak ada referensi yatim dari baris yang dihapus.
2. **Folder Drive (Tahap 35):** perlu folder khusus bernama `FMart - Bukti Pengantaran`, dengan sharing PRIVATE/NONE, lalu Script Property `FMART_DELIVERY_PROOF_FOLDER_ID` diarahkan ke folder tersebut. Jangan kirim ID folder ke chat.
3. **Akun:** ADMIN dan PETUGAS_PENGANTAR belum dibuat sesuai keputusan operator. Tidak dibuat otomatis; ini menjadi prasyarat operasional sebelum pengujian role terkait.
4. **Produk/Stok (Tahap 36):** 294 produk aktif tanpa variasi tidak memiliki baris stok kanonis. Jangan mengisi 294 baris dengan saldo nol secara massal sebelum memastikan semua produk tersebut memang dikelola sebagai barang persediaan dan bukan item katalog/nonstok. Saldo awal harus mengikuti bukti stok fisik atau dokumen penerimaan; tidak boleh mengasumsikan nol.
5. **Mutasi masuk manual:** MutasiStok baris 2 perlu ditelusuri ke AuditLog dan dokumen sumber. Tidak boleh menghapus/mengubah mutasi lama atau membuat AuditLog pengganti tanpa bukti yang sesuai.

### Perbaikan repository lanjutan dari temuan folder

Ditambahkan pengaman agar:
- audit runtime melaporkan `DRIVE_PROOF_FOLDERS_REUSED` jika kedua Script Property menggunakan ID folder yang sama;
- fungsi penyimpanan bukti pengantaran menolak penggunaan folder pembayaran yang sama, sehingga bukti pengantaran tidak tercampur dengan bukti pembayaran.

Perbaikan ini hanya mengubah source dan tes. Tidak mengubah Script Properties, Drive, Spreadsheet, akun, stok, maupun transaksi produksi.


## Konfirmasi operator dan tindak lanjut Tahap 35–36 — 19 November 2026

Operator mengonfirmasi:
- Folder khusus **FMart - Bukti Pengantaran** sudah dibuat dan Script Property `FMART_DELIVERY_PROOF_FOLDER_ID` sudah diarahkan ke folder tersebut. Konfirmasi akses aktual tetap menunggu audit runtime read-only berikutnya.
- Seluruh 294 produk aktif yang belum memiliki baris stok kanonis adalah barang persediaan yang memang dikelola Gudang. Saldo stok akan diinput oleh petugas Gudang; aplikasi/repository tidak boleh menginisialisasi saldo nol secara massal atau mengarang saldo awal.

### Hasil pemeriksaan source alur penerimaan Gudang

Source `createStockReceipt()` dan `completeStockReceipt_()` telah diperiksa:
- Penerimaan dapat dilakukan untuk produk aktif tanpa variasi maupun produk dengan variasi aktif.
- Jika baris stok kanonis belum ada, penyelesaian penerimaan membuat baris pada sheet `Stok` dengan saldo sesudah penerimaan.
- Penerimaan mencatat header, detail, mutasi `MASUK`, dan AuditLog; mekanisme request key/payload mendukung pemulihan tanpa menggandakan efek penerimaan.
- Karena itu, pengisian awal 294 produk dapat dilakukan melalui proses Penerimaan Barang Gudang berdasarkan hitung fisik/dokumen penerimaan, bukan dengan membuat saldo nol massal.

### Arahan operasional stok awal

1. Petugas Gudang melakukan hitung fisik dan/atau memeriksa dokumen sumber untuk setiap produk.
2. Catat jumlah yang benar melalui menu **Penerimaan Barang**. Gunakan pemasok/asal barang dan referensi dokumen yang sesuai; untuk hasil stock opname, tulis keterangan yang jelas dan dapat ditelusuri.
3. Jangan menginput angka perkiraan atau menganggap stok kosong hanya karena baris stok belum tersedia.
4. Setelah input bertahap selesai, jalankan kembali audit read-only. Temuan `PRODUCT_STOCK_ROW_MISSING` seharusnya berkurang sesuai produk yang sudah memiliki baris saldo kanonis.
5. Jika penerimaan gagal/terputus, gunakan mekanisme pemulihan dengan request key yang sama sesuai alur aplikasi; jangan mengulang sebagai penerimaan baru sebelum memeriksa riwayat penerimaan.

**Status Tahap 36:** kebijakan sumber saldo awal telah dikonfirmasi dan source penerimaan mendukung pembuatan baris stok kanonis. Rekonsiliasi aktual belum selesai sampai Gudang menginput saldo berdasarkan bukti dan audit ulang membuktikan konsistensinya.

**Catatan folder Drive:** source sudah memiliki pengaman ID folder pembayaran/pengantaran yang sama. Karena folder baru telah dibuat dan property diperbarui, audit runtime berikutnya harus memastikan kedua folder terdeteksi berbeda, accessible, dan private. Jangan membagikan ID folder ke chat.
