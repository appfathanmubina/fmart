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
- Menambahkan wrapper publik `runFMartReadinessAudit()` yang hanya meneruskan ke audit gabungan read-only `runFMartReadinessAudit_()`.
- Memperbaiki `docs/UAT-TAHAP-4-FMART.md` agar nama fungsi yang dijalankan sesuai dengan entry point publik.
- Menghapus instruksi menjalankan setup database sebagai prasyarat audit read-only. Setup/migrasi hanya boleh dilakukan sebagai pekerjaan terpisah setelah hasil audit membuktikan perlu, target database dipastikan, dan backup tersedia.
- Audit gabungan tetap memanggil pemeriksaan database, runtime, sinkronisasi operasional, stok/POS, penerimaan, dan pemulihan transaksi. Hasil dicatat ke Execution log.

**Batasan:** perubahan ini menyiapkan jalur audit; tidak menjalankan Apps Script, tidak membaca database produksi, tidak mengubah Spreadsheet/Drive, dan tidak menguji akun/perangkat. Operator tetap perlu menjalankan `runFMartReadinessAudit` di Apps Script Editor dan mengirimkan hasil yang telah disamarkan. Jangan mengirim password, OTP, token, Spreadsheet ID, folder ID, atau data pribadi.
