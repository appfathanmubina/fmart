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
| 38 | Validasi PWA, tampilan, dan perangkat | Audit login, dashboard, header, navigasi, sidebar Desktop/Tablet, katalog Wali, modal/form/tabel Admin, seluruh role, responsivitas, cache, instalasi, dan jaringan | Regresi visual/fungsional kritis ditutup; CI lulus; perangkat sasaran dan alur runtime tervalidasi |
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


## Pembaruan audit mutasi masuk manual — 19 November 2026

PR #52 telah memperbaiki audit penerimaan agar mengenali mutasi stok masuk manual dari `adjustStock()` yang memakai `requestKey` sebagai referensi. Audit kini memvalidasi AuditLog berdasarkan referensi (dengan kompatibilitas format legacy), ProdukId, VariasiId, tipe MASUK, qty, saldo sebelum/sesudah, dan timestamp yang sama. Referensi yang tidak dikenal tanpa AuditLog yang cocok tetap menjadi temuan; validasi penerimaan resmi dan stok awal variasi tetap terpisah.

- PR: https://github.com/appfathanmubina/fmart/pull/52
- CI: lulus; 63 pengujian regresi lulus.
- Merge commit: `4f0832571cc5f48720fc5c231366c27adb8e0972`
- Tidak ada data produksi yang diubah.

### Panduan pencatatan saldo awal oleh Gudang

- Barang yang benar-benar baru diterima dari pemasok dicatat melalui **Penerimaan Barang** dengan dokumen sumber.
- Saldo fisik barang yang sudah ada saat stock opname dapat dicatat melalui **Penyesuaian Stok** sebagai mutasi MASUK, dengan catatan yang menyebutkan hasil stock opname/tanggal dan bukti acuannya.
- Jangan menggunakan Penerimaan Barang untuk merekayasa penerimaan yang tidak terjadi; jangan pula memasukkan angka nol/perkiraan untuk melengkapi baris stok.
- Setelah pencatatan, jalankan audit read-only kembali untuk memastikan baris stok, mutasi, dan AuditLog saling cocok.

Temuan MutasiStok baris 2 dari audit sebelumnya masih menunggu penelusuran data sumber. Perbaikan source tidak membuat AuditLog pengganti dan tidak menghapus/mengubah mutasi lama.


## Konfirmasi operator dan perbaikan form pengguna — 19 November 2026

Operator mengonfirmasi bahwa:
- Folder khusus **FMart - Bukti Pengantaran** sudah dibuat dan Script Property sudah diarahkan ke folder tersebut. Pemeriksaan runtime ulang tidak perlu menjadi prasyarat untuk melanjutkan pekerjaan repository/UI.
- Akun role **ADMIN** sudah dibuat. Pembuatan akun tersebut tidak lagi menjadi pekerjaan tertunda.
- Akun **PETUGAS_PENGANTAR** belum dibuat karena pilihan role tersebut tidak tersedia pada form **Tambah Akun Petugas** milik Superadmin.

### Perbaikan terarah

Pemeriksaan source menemukan backend createStaffUser() dan FMART.ROLES sudah menerima PETUGAS_PENGANTAR; role tersebut juga sudah didukung pada portal admin, navigasi, dashboard pengantaran, dan endpoint terkait. Kekurangannya hanya pada daftar pilihan di form Tambah Akun Petugas yang belum menampilkan opsi role tersebut.

Perbaikan ditambahkan pada form dengan tetap memakai endpoint backend yang sama. Tes regresi memastikan opsi tersedia dan backend tetap menerima role tersebut. Tidak ada akun yang dibuat otomatis dan tidak ada data produksi yang diubah.

**Status:** konfirmasi operator dicatat; pembuatan akun Petugas Pengantar dapat dilakukan Superadmin setelah perbaikan source diterapkan pada Apps Script. Tahap 38 (validasi PWA/tampilan/perangkat) dapat dilanjutkan tanpa menunggu audit runtime ulang folder atau akun ADMIN. Validasi runtime yang tersisa tetap dilakukan pada tahap pemeriksaan role dan kesiapan produksi, bukan sebagai penghalang perubahan UI repository.


## Kemajuan Tahap 38 — 19 November 2026

### Tahap 38.2 — Sidebar Desktop/Tablet (perbaikan repository)

**Status: selesai pada repository; validasi perangkat fisik masih tertunda.**

PR #55 telah di-merge ke `main`:
- PR: https://github.com/appfathanmubina/fmart/pull/55
- Merge commit: `4e854866497e5462afb15704750572c2d0733fd6`
- Menambahkan accessible label untuk navigasi Wali dan petugas.
- Memperkuat perilaku scroll sidebar vertikal pada desktop dan tablet landscape, termasuk pembatasan scroll chaining dan scrollbar yang selaras tema.
- Mencegah label menu panjang mendorong lebar sidebar.
- Menyesuaikan kepadatan sidebar untuk viewport pendek (tinggi maksimal 640 px).
- Mempertahankan bottom navigation horizontal untuk tablet portrait (761–900 px) agar area konten tetap memadai.
- Tidak mengubah urutan menu, izin role, backend, transaksi, maupun data produksi.

**Validasi otomatis:**
- Regression tests: 67 lulus, 0 gagal.
- Pemeriksaan sintaks backend: lulus.
- Pemeriksaan sintaks service worker: lulus.
- Pemeriksaan patch whitespace: lulus.
- GitHub Pages build dan deployment setelah merge: berhasil.

**Batas validasi:** CI dan build tidak menggantikan pemeriksaan visual pada browser/perangkat fisik. Sidebar masih harus diperiksa pada desktop, tablet landscape, tablet portrait, dan tinggi layar pendek saat validasi perangkat Tahap 38.

### Tahap 38.1 — Header dan navigasi (perbaikan awal)

PR #57 telah di-merge ke `main`:
- PR: https://github.com/appfathanmubina/fmart/pull/57
- Merge commit: `471b8a6250117947fe78f3030a4ef993c3fb739b`
- Memperbaiki aksi klik brand/logo FMart yang sebelumnya selalu menuju Beranda Wali.
- Wali tetap menuju Beranda Wali; semua role staf kembali ke Dashboard Operasional sesuai role aktif.
- Klik mouse serta keyboard Enter/Space memakai jalur navigasi yang sama.
- Tidak mengubah backend, izin role, transaksi, maupun data.
- Regression tests: 68 lulus, 0 gagal; pemeriksaan sintaks dan patch whitespace lulus.

**Status Tahap 38.1:** perbaikan navigasi header ini sudah masuk `main`; audit login, dashboard, dan elemen header lainnya masih berlanjut.

### Tahap 38.3 — Pemulihan dua kolom Login Admin Desktop/Tablet

PR #59 telah di-merge ke `main`:
- PR: https://github.com/appfathanmubina/fmart/pull/59
- Merge commit: `30830b8905db5156bcdf73397cad390e2fdecef2`
- Memulihkan panel informasi kiri dan form kanan pada login Admin untuk Desktop/Tablet (mulai 761 px).
- Proporsi 6:4 untuk tablet/layar menengah dan 7:3 untuk desktop lebar.
- Layout satu kolom pada HP (maksimal 760 px) tetap dipertahankan.
- Copy panel kiri disesuaikan untuk petugas: operasional terpusat, data terpantau, dan akses berbasis peran.
- Tidak mengubah email/password, OTP, sesi, autentikasi, backend, izin role, atau data.
- Regression tests saat PR: 70 lulus, 0 gagal.

**Hotfix selector login:** PR #61 telah di-merge:
- https://github.com/appfathanmubina/fmart/pull/61
- Merge commit: `58fff58daab3a1aca349cf057660bb95643dc803`
- Menggunakan ID `loginShowcase` sesuai helper DOM berbasis ID; mencegah kegagalan inisialisasi JavaScript Admin.
- Regression tests: 71 lulus, 0 gagal.

### Tahap 38.4 — Pemulihan error Dashboard Operasional

PR #62 telah di-merge ke `main`:
- PR: https://github.com/appfathanmubina/fmart/pull/62
- Merge commit: `de28336f64aa6e2f09f5e8aa3df730037bdc45d2`
- Saat pemuatan awal ringkasan operasional gagal, Admin/Kasir/Gudang mendapatkan pesan yang jelas dan tombol coba muat ulang.
- Panel statistik kosong disembunyikan selama belum ada data.
- Jika refresh gagal setelah dashboard berhasil tampil, data sebelumnya dipertahankan dan error diberitahukan.
- Setelah request berhasil, panel statistik ditampilkan kembali.
- Tidak mengubah backend, perhitungan statistik, hak akses role, transaksi, atau data.
- Regression tests: 72 lulus, 0 gagal.

### Catatan keputusan Dashboard Wali

- Halaman awal Wali tetap menggunakan pola katalog produk (catalog-first).
- Ringkasan statistik Wali yang pernah ada sudah dinonaktifkan pada riwayat pengembangan sebelumnya karena tidak lagi sesuai alur; tidak dihidupkan kembali dalam Tahap 38.
- Pemeriksaan Tahap 38 untuk Wali difokuskan pada katalog, pencarian, kategori, kartu/detail produk, keranjang, checkout, dan navigasi.
- Tidak ada informasi stok atau antrean pemenuhan yang ditambahkan ke tampilan Wali.

### Tahap 38.5 — Aksesibilitas kartu dan detail produk Wali

PR #64 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/64
- Merge commit: `8194c069af38f5f9a18eef6f673b3c38f810ccb1`
- Label tombol pada kartu produk disesuaikan dengan aksi sebenarnya, yaitu membuka detail produk.
- Kegagalan pemuatan detail produk memakai notifikasi FMart non-blocking, bukan browser alert.
- Loading state tetap ditutup melalui `finally`.
- Tidak mengubah pilihan variasi, jumlah, keranjang, harga, stok, atau checkout.
- Regression tests: 74 lulus, 0 gagal.

### Tahap 38.6 — Aksesibilitas kontrol kuantitas keranjang Wali

PR #65 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/65
- Merge commit: `177158d45c199414578e42dd93bbbd7c2cf4c1fb`
- Tombol tambah/kurangi jumlah, input kuantitas, dan hapus item mendapat accessible label yang spesifik terhadap produk.
- Input menampilkan batas maksimum 10.000 unit dan tombol tambah dinonaktifkan saat batas tercapai.
- Tidak mengubah aturan keranjang atau validasi server.
- Regression tests: 75 lulus, 0 gagal.

### Tahap 38.7 — Asosiasi label dan required state formulir Admin/Gudang

PR #66 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/66
- Merge commit: `a89716d40ac8242fc9fad7cd0d6415a1131ff240`
- Menghubungkan label dengan input/select pada form kategori, produk, akun petugas, edit akun/Wali, QRIS, penerimaan barang, stok minimum, variasi, transfer Gudang→Kasir, dan mutasi stok.
- Form penerimaan memakai ID/label dinamis per baris.
- Field wajib ditandai sesuai validasi backend.
- Tidak mengubah handler, payload, endpoint, hak akses, atau aturan bisnis.
- Regression tests: 77 lulus, 0 gagal.

### Tahap 38.8 — Filter laporan/audit dan pemulihan pemuatan

PR #67 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/67
- Merge commit: `dc6948bf26bc619a7951c1647cfe23a0ebad813c`
- Label tanggal laporan/audit dan filter aktivitas dihubungkan ke kontrolnya.
- Status tab laporan diekspos melalui `aria-pressed`.
- Laporan, aktivitas audit, dan status integrasi memiliki tombol coba ulang saat pemuatan awal gagal.
- Jika refresh laporan/audit gagal, hasil sebelumnya tetap ditampilkan dan error diberitahukan.
- Tidak mengubah query backend, data audit, integrasi, atau izin Admin/Superadmin.
- Regression tests: 79 lulus, 0 gagal.

### Tahap 38.9 — Ringkasan antrean menunggu stok pada Dashboard Gudang

PR #69 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/69
- Merge commit: `50d8be4409be45b8d95d89d7bbde22387d3f3339`
- Menampilkan kartu **Menunggu stok** pada ringkasan Dashboard Gudang.
- Kartu membuka antrean pesanan dengan filter `MENUNGGU_STOK`.
- Enam tahap pemenuhan ditata dalam grid responsif.
- Informasi ini hanya ditampilkan di portal internal; tidak menambah informasi stok/kekurangan stok ke PWA Wali.
- Tidak mengubah data stok, reservasi, status pesanan, endpoint, atau hak akses.

### Tahap 38.10 — Aksesibilitas dialog operasional

PR #71 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/71
- Merge commit: `8bba8c9f31adc0ad27a195a722b151121021cb37`
- Tombol tutup dialog operasional diberi accessible name dan `type=button`.
- Tombol Escape kini menutup dialog operasional Admin/Gudang/Kasir.
- Tidak mengubah isi form, endpoint, role, atau data.
- Regression tests: 81 lulus, 0 gagal.

### Tahap 38.11 — Aksesibilitas pemilih Santri

PR #72 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/72
- Merge commit: `9e0c29a4b29584153d875fb1c4c713cdb2722f09`
- Menghubungkan enam label ke kontrol pencarian Santri, filter kelas, dan pilihan hubungan.
- Tidak mengubah pencarian, filter, persetujuan relasi, hak akses, atau data.
- Regression tests: 82 lulus, 0 gagal.

### Tahap 38.12 — Normalisasi filter status Dashboard Pengantaran

PR #74 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/74
- Merge commit: `9a57149c6fe73c93bcb6aa2b89701d383574520a`
- Filter status memetakan alias backend yang ekuivalen untuk status Ditugaskan, Diterima, dan Dalam Perjalanan.
- Opsi filter yang mudah dipahami petugas tetap dipertahankan.
- Tidak mengubah status assignment, tindakan petugas, atau alur penugasan.

### Tahap 38.13 — Aksesibilitas kontrol Kasir POS

PR #76 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/76
- Merge commit: `178083d6ae4d351cf4f3c38bc8396bd9bffad2b1`
- Memberi accessible name pada input nama pembeli, pencarian Santri, pencarian riwayat, metode pembayaran, dan tombol kuantitas berdasarkan produk.
- Menghubungkan judul kelompok Identitas Pembeli dan Pembayaran ke kontrolnya.
- Tidak mengubah POS, batas stok Kasir, pembayaran, transaksi, atau data.

### Tahap 38.14 — Ketahanan refresh Dashboard Pengantaran

PR #77 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/77
- Merge commit: `87794c8fbc79e136b96d772553a66abfdb35e7e7`
- Saat refresh antrean gagal, daftar tugas dan notifikasi terakhir tetap tampil; error diberitahukan tanpa mengosongkan halaman.
- Kegagalan pemuatan pertama tetap menyediakan tombol **Coba lagi**.
- Cache dashboard dibersihkan saat logout agar data akun sebelumnya tidak tertinggal.
- Tidak mengubah endpoint, penugasan, status pesanan, bukti pengantaran, atau akses role.
- Regression tests: 85 lulus, 0 gagal.

### Tahap 38.15 — Ketahanan refresh Workspace Kasir/POS

PR #80 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/80
- Merge commit: `a93733ade8d9f8ea3208d1024c8e80cc8557e6f9`
- Jika pencarian katalog POS gagal setelah sebelumnya berhasil, daftar produk dan keranjang terakhir tetap ditampilkan; query dikembalikan ke pencarian terakhir yang berhasil.
- Kegagalan pemuatan katalog pertama tetap menyediakan tombol **Coba lagi**.
- Jika refresh antrean QRIS atau riwayat penjualan gagal, hasil sebelumnya dipertahankan dan error diberitahukan.
- Kegagalan awal QRIS/riwayat tetap menyediakan state error dan tombol retry yang sudah ada.
- Tidak mengubah transaksi POS, pembayaran, stok, harga, backend, atau data produksi.
- Regression tests: 87 lulus, 0 gagal.

### Tahap 38.16 — Ketahanan refresh Distribusi Pengantaran

PR #81 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/81
- Merge commit: `cde67e600690e94724dfcddf9ac96ea1fc100181`
- Daftar pesanan siap antar dan penugasan aktif tetap terlihat jika refresh distribusi gagal.
- Pemuatan awal tetap menyediakan tombol coba ulang.
- Cache distribusi dibersihkan saat logout.
- Tidak mengubah endpoint, daftar petugas, proses penugasan, status pesanan, atau hak akses.
- Regression tests: 88 lulus, 0 gagal.

### Tahap 38.17 — Ketahanan refresh Penanganan Komplain

PR #84 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/84
- Merge commit: `e19232c9276b266761234ef0244b676a5cc338a6`
- Daftar komplain yang sudah dimuat tetap terlihat jika refresh gagal; error disampaikan tanpa mengosongkan workspace.
- Pemuatan awal tetap menyediakan tombol coba ulang.
- Saat logout, konten operasional yang tersembunyi dan cache role terkait dibersihkan agar tidak tertinggal pada sesi akun berikutnya.
- Tidak mengubah endpoint, alur penyelesaian komplain, tenggat konfirmasi, atau hak akses.
- Regression tests: 89 lulus, 0 gagal.

### Tahap 38.18 — Penutupan modal bertumpuk dengan Escape

PR #88 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/88
- Merge commit: `71bda89d9c3edc0e4215a171e16f883995e2818d`
- Handler Escape kini menutup hanya modal teratas yang sedang terlihat, bukan semua modal sekaligus.
- Alur Pembayaran di atas Detail Pesanan dapat kembali ke Detail Pesanan setelah modal pembayaran ditutup.
- Dukungan Escape tetap berlaku untuk modal Wali dan portal Operasional.
- Tidak mengubah tombol close, backdrop, isi form, atau alur transaksi.
- Regression tests: 90 lulus, 0 gagal.

### Tahap 38.19 — Responsivitas filter Dashboard Pengantaran

PR #87 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/87
- Merge commit: `79ce53ab0d9efc8e0c6f69e122e51c60f23f7d80`
- Pencarian tugas dan filter status menggunakan dua kolom dengan proporsi lebih lebar untuk pencarian pada Desktop/Tablet lebar.
- Pada layar maksimal 620 px, kedua kontrol ditumpuk satu kolom agar tetap terbaca dan mudah disentuh.
- Kontrol menggunakan `min-width:0` dan `box-sizing:border-box` untuk mencegah luapan.
- Tidak mengubah pencarian, filter status, alias status, data tugas, atau hak akses.
- Regression tests: 91 lulus, 0 gagal.

### Tahap 38.20 — Accessible name pencarian dan filter Admin/Gudang

PR #91 telah di-merge:
- PR: https://github.com/appfathanmubina/fmart/pull/91
- Merge commit: `525d08e9435763dc33d77ee9cfeba22cfe089490`
- Menambahkan accessible name untuk pencarian akun Petugas dan Wali.
- Menambahkan accessible name untuk pencarian/filter katalog Admin, antrean Gudang, laporan Gudang, riwayat penerimaan, dan kondisi/status stok.
- Mempertahankan placeholder, nilai filter, ID, handler, dan perilaku pencarian.
- Tidak mengubah query, endpoint, hak akses, data, atau proses operasional.
- Regression tests: 92 lulus, 0 gagal.

### Urutan pekerjaan Tahap 38 berikutnya

1. Selesaikan audit login, dashboard, header, dan navigasi lintas role; perbaikan awal header, sidebar, login Admin dua kolom, dan retry Dashboard Operasional sudah masuk `main`.
2. Selesaikan audit katalog Wali: pencarian, kategori, gambar, kartu/detail produk, keranjang, dan checkout; perbaikan aksesibilitas kartu/detail dan kuantitas keranjang sudah masuk `main`.
3. Lanjutkan audit formulir, tabel, filter, laporan, dan modal Admin; asosiasi label form Admin/Gudang, accessible name pencarian/filter, filter/retry laporan, aksesibilitas dialog operasional, pemilih Santri, dan POS Kasir sudah diperbaiki; audit seluruh layar/form dinamis masih berjalan.
4. Lanjutkan audit alur Gudang, Kasir, dan Petugas Pengantar; ringkasan antrean stok Gudang, normalisasi filter status Pengantaran, responsivitas filter mobile, aksesibilitas POS Kasir, serta pemulihan refresh Dashboard/Distribusi/Komplain dan POS sudah diperbaiki.
5. Lanjutkan audit responsivitas HP, tablet portrait/landscape, dan desktop; CSS yang sudah ada mengatur padding header 20 px pada rentang 761–1100 px, selanjutnya periksa tinggi layar pendek, sidebar desktop/tablet landscape, modal, tabel lebar, katalog Wali, POS, dan workspace Gudang/Pengantaran serta regresi lintas role.
6. Tutup temuan, jalankan CI penuh, dan lakukan validasi perangkat sebelum Tahap 38 dinyatakan selesai.

**Status keseluruhan Tahap 38: masih berjalan.** Perbaikan repository Tahap 38.1–38.20 telah masuk `main`, termasuk header/sidebar, login Admin, Dashboard Operasional/Gudang/Pengantaran, katalog dan keranjang Wali, formulir, laporan, dialog bertumpuk, pemilih Santri, aksesibilitas dan ketahanan refresh POS Kasir, filter Pengantaran responsif. Audit lengkap seluruh layar/role, regresi responsif, dan validasi visual pada perangkat nyata masih tertunda.
