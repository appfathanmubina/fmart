# FMart — Paket Serah-Terima Audit Repository

**Tanggal:** 19 November 2026  
**Baseline source saat paket disusun:** `4aac87e6b8e1e54eb142fcf31bf3cdbe9acd95de`  
**Baseline dokumentasi sebelum paket serah-terima:** `ea976ce35ed92edf6fe6bb718d909ddacf748659`  
**PR paket serah-terima:** #128, merge commit `95a5c04529d4d62101185ca3d9ed28d34ce81c5a`  
**Status:** Audit source dan dokumentasi repository selesai untuk lingkup yang tercatat; runtime UAT dan persetujuan produksi belum dilakukan.

Dokumen ini merangkum hasil pekerjaan PR dan daftar gerbang yang masih harus diselesaikan. Baca bersama [Roadmap Audit](ROADMAP_AUDIT_FMART_2026-11-19.md), [Checklist UAT](UAT-TAHAP-4-FMART.md), dan [SOP Operasional (draft)](SOP_OPERASIONAL_FMART.md).

## 1. Perubahan yang sudah masuk main

| PR | Hasil |
|---|---|
| #117 | Sidebar Desktop ditata ulang untuk menu aktif/tidak aktif, fokus, hover, dan ukuran responsif |
| #118 | Status roadmap diselaraskan dengan hasil audit sidebar |
| #119 | Navigasi role memakai helper status aktif tunggal dan `aria-current` |
| #120 | Pratinjau bukti pengantaran memeriksa folder khusus, pemisahan folder, ukuran, dan MIME |
| #121 | Inventaris 83 endpoint UI dikunci dengan regression test otorisasi |
| #122 | Isolasi data Wali, Kasir, dan Pengantaran dikunci dengan regression test |
| #123 | Self-link Wali hanya aktif bila nomor akun cocok dengan `no_wa_wali`; selain itu pending Admin |
| #124 | Batas dua relasi Wali aktif/pending disamakan pada self-link dan persetujuan Admin |
| #125 | Guard mutasi, lock, ownership, idempotensi, dan transisi status dikunci dengan regression test |
| #126 | SOP Operasional draft ditambahkan dan ditautkan dari README |
| #127 | Checklist UAT disinkronkan dengan pengamanan terbaru |
| #128 | Paket serah-terima audit repository ditambahkan |

Perubahan PR #117–#125 sudah melewati regression CI. Pada baseline source PR #125, 117 test lulus dan build/deployment GitHub Pages lulus. Untuk commit dokumentasi `ea976ce`, regression CI lulus; build Jekyll dan deployment GitHub Pages kemudian selesai dengan sukses.

## 2. Temuan yang sudah diperbaiki pada source

- Status menu staf hanya memiliki satu sumber kebenaran; menu tersembunyi tidak dapat menjadi aktif.
- Endpoint UI yang dipanggil secara literal maupun melalui pemetaan dinamis memiliki fungsi backend dan guard server-side, kecuali tiga jalur pra-autentikasi yang memiliki kontrol khusus.
- Data Wali, Kasir, dan petugas pengantaran dibatasi sesuai pemilik/role.
- Bukti pengantaran hanya dapat dipratinjau Wali pemilik pesanan dari folder yang ditetapkan, dengan batas 10 MB dan MIME gambar yang diizinkan.
- Self-link Wali–Santri menggunakan pencocokan nomor ternormalisasi. Mismatch/kosong membuat relasi pending, bukan akses aktif.
- Batas dua Wali unik aktif/pending ditegakkan pada self-link dan persetujuan Admin.
- Mutasi penting dilindungi guard role, script lock, ownership, idempotency key, dan aturan transisi status sesuai alur.

## 3. Hal yang belum boleh dianggap selesai

1. **Runtime Apps Script belum diuji.** CI tidak membuktikan izin Drive, Spreadsheet produksi, trigger, deployment Web App, atau transaksi nyata.
2. **Tampilan browser/perangkat belum diverifikasi.** Sidebar 901–1100 px, Desktop lebar/pendek, tablet landscape/portrait, dan HP tetap harus diuji.
3. **Role Supervisor belum ada di backend.** Jangan membuat akun atau memberi akses role ini tanpa keputusan dan implementasi terpisah.
4. **Akun ADMIN dan PETUGAS_PENGANTAR belum dibuat oleh operator.** Alur role tersebut belum dapat diuji dengan akun nyata.
5. **Saldo 294 produk aktif yang dikelola Gudang belum boleh diasumsikan sudah terisi.** Gudang harus memasukkan saldo berdasarkan hitung fisik/dokumen melalui penerimaan; jangan menginisialisasi nol massal.
6. **Folder bukti pengantaran telah dibuat dan Script Property telah diperbarui oleh operator, tetapi ID, akses, privasi, dan file existing masih perlu diverifikasi pada runtime.** File bukti lama di luar folder konfigurasi akan ditolak untuk pratinjau; source tidak memindahkan file otomatis.
7. **Relasi Wali–Santri lama tidak dimigrasi otomatis.** Relasi aktif lama tidak dicabut oleh perbaikan phone-match. Perlu rekonsiliasi terkontrol untuk memastikan data aktif lama sesuai nomor `no_wa_wali`.
8. **Relasi lama yang melebihi dua Wali aktif/pending perlu ditinjau Admin.** Persetujuan baru akan ditolak jika jumlah relasi sudah melebihi batas; tidak ada penghapusan otomatis.
9. **Backup/restore otomatis belum tersedia di source.** SOP menetapkan backup manual dan pemulihan pada salinan terpisah sampai mekanisme resmi diuji.
10. **Ketersediaan lingkungan uji harus dikonfirmasi.** Jangan menjalankan skenario transaksi gagal/duplikat/bersamaan pada data produksi.

## 4. Gerbang sebelum runtime

Lakukan berurutan, dengan bukti yang dapat diperiksa:

1. Pastikan tersedia salinan Spreadsheet, project Apps Script, folder Drive, dan akun uji terisolasi. Jika belum ada, siapkan terlebih dahulu.
2. Buat/aktifkan akun ADMIN, KASIR, GUDANG, dan PETUGAS_PENGANTAR sesuai petugas yang ditunjuk; jangan berbagi kredensial.
3. Verifikasi Script Properties, Spreadsheet ID, folder bukti pembayaran/pengantaran yang berbeda, izin akses, dan trigger.
4. Jalankan fungsi audit read-only `runFMartReadinessAudit_()` pada project dan Spreadsheet target yang benar. Simpan Execution ID/log.
5. Rekonsiliasi relasi Wali–Santri lama, file bukti lama, master produk, stok awal, dan ledger pada salinan uji.
6. Jalankan skenario pada Checklist UAT. Beri status PASS hanya jika ada bukti aktual; selain itu gunakan FAIL, BLOCKED, atau NOT RUN.
7. Uji tampilan dan aksesibilitas lintas perangkat/role.
8. Setelah seluruh temuan ditutup dan pemilik proses menyetujui, baru tentukan jadwal deployment Apps Script dan rencana aktivasi produksi.

## 5. Keputusan kesiapan

**Status saat serah-terima: SOURCE AUDIT PASS / RUNTIME NOT RUN / PRODUCTION NOT APPROVED.**

Jangan mengartikan status source audit atau GitHub Pages build sebagai persetujuan produksi. Perbaikan hasil runtime harus dicatat sebagai temuan baru, diprioritaskan, diperbaiki melalui branch/PR, diuji regresi, dan baru kemudian di-merge.


## Addendum — pembaruan setelah paket serah-terima (19 November 2026)

Baseline repository setelah perbaikan login: `f0be7fdc1ac31b9356b0d853d93195286389a882`.

- **PR #129:** menutup Tahap 40.3 pada sisi dokumentasi; paket serah-terima dan status review/runtime tetap dibedakan.
- **PR #130 / Tahap 40.4:** memperbaiki tombol Masuk yang sebelumnya dapat diblokir validasi native browser karena kolom OTP tersembunyi memiliki atribut `required` sejak awal. Status `required` sekarang hanya aktif saat panel OTP ditampilkan, lalu dibersihkan saat panel ditutup atau OTP berhasil. Regression CI, build, dan deployment GitHub Pages pasca-merge lulus.
- Perbaikan tidak mengubah backend autentikasi, akun, role, database, atau data produksi. Tombol Masuk belum diuji langsung pada browser/runtime.

Status keseluruhan tetap: **SOURCE AUDIT / REGRESSION PASS — RUNTIME UAT NOT COMPLETE — PRODUCTION NOT APPROVED.**


## Addendum — Tahap 40.6 HPP dan laba kotor (20 November 2026)

PR #135 menambahkan metode HPP rata-rata tertimbang dan snapshot biaya saat barang keluar. Perubahan source menambahkan kolom pada Produk, VariasiProduk, MutasiStok, DetailPenerimaanBarang, DetailPesanan, dan DetailPenjualanToko. Kolom ditambahkan di ujung sheet; data transaksi lama tidak ditimpa.

- Gudang mencatat biaya perolehan per unit pada setiap penerimaan barang dan setiap mutasi stok masuk.
- Untuk produk/variasi yang sudah memiliki saldo stok tetapi belum memiliki HPP, Admin harus menetapkan HPP pembukaan dari dokumen pembelian atau dasar biaya yang disetujui. Sistem menolak menggabungkan stok lama tanpa nilai biaya dengan stok baru.
- HPP rata-rata berlaku pada gabungan saldo Gudang dan Kasir; transfer internal tidak mengubah rata-rata.
- HPP setiap penjualan Wali/POS disimpan pada detail ketika stok dikurangi. Data lama tidak direkonstruksi memakai HPP sekarang karena akan menghasilkan laba historis yang tidak dapat dibuktikan.
- Laporan hanya menampilkan laba kotor ketika semua baris penjualan terbayar pada periode memiliki snapshot HPP. Jika belum lengkap, angka laba kotor dan HPP total ditahan dan jumlah baris/unit yang belum tercatat ditampilkan.
- Laba kotor belum mengurangi biaya operasional, sehingga bukan laba bersih.
- Fungsi migrasi eksplisit: `migrateFMartCostingSchema()`. Pemanggilan katalog Gudang/Admin dan laporan juga menjalankan pemeriksaan skema append-only.

PR #135 merged ke `main` pada commit `3601c97169249ca779ddc5c97bedfe269b599cc8`. Regression CI pasca-merge, build, dan deployment GitHub Pages lulus. Runtime UAT, uji migrasi pada salinan Spreadsheet, bukti rekonsiliasi pembelian, serta deployment versi Apps Script tetap belum dilakukan. Status produksi tetap **NOT APPROVED** sampai gerbang UAT selesai.


## Addendum — Tahap 40.7 Pengamanan HPP master (20 November 2026)

Audit source menemukan endpoint Admin `saveProduct()` dan `saveVariation()` sebelumnya mengizinkan perubahan HPP positif ketika saldo stok masih tersedia. Guard backend baru mempertahankan jalur penetapan HPP pembukaan dari 0 ke nilai positif, tetapi menolak perubahan/pengosongan HPP yang sudah tercatat selama saldo gabungan Gudang + Kasir lebih dari nol. Nilai yang sama tetap dapat disimpan; setelah saldo nol, koreksi HPP master diperbolehkan.

Perubahan tidak mengubah skema, saldo, transaksi, snapshot HPP, atau data existing. Regression test menguji kondisi yang diizinkan/ditolak dan memastikan kedua endpoint memanggil guard. PR #137 telah di-merge ke `main` pada commit `442cca6016b9e492fb56516fe0fa5953eab33572`; regression CI PR lulus. Pemeriksaan post-merge dan deployment GitHub Pages tetap dipantau terpisah. Runtime UAT tetap diperlukan; revaluasi stok berjalan harus menggunakan jurnal penyesuaian terpisah.


## Addendum — Tahap 40.8 media PWA dan QRIS Drive (20 November 2026)

PR #139 telah di-merge ke `main` pada squash commit `2e84967f59d15144e950259040c8aff7dab54b92`; regression CI lulus. Source menyediakan endpoint `getQrisImageData(token)` untuk membaca QRIS dari Drive melalui Apps Script, dengan pembatasan role Wali/Superadmin, pemeriksaan file trash, tipe gambar, signature byte, dan batas 5 MB. UI Wali mencoba memakai data gambar dari server dan mempertahankan tautan Drive asli sebagai fallback. Transformasi thumbnail hanya diterapkan untuk URL `drive.google.com`.

Audit menemukan foto produk menggunakan URL aman dan fallback visual; bukti pengantaran disajikan melalui endpoint yang memeriksa kepemilikan pesanan dan folder Drive; bukti pembayaran melalui endpoint yang membatasi role dan folder bukti pembayaran. Tidak ada perubahan izin Drive atau data produksi. Uji perangkat/PWA dan verifikasi Apps Script aktif tetap wajib sebelum produksi disetujui.


## Addendum — Tahap 40.9 audit database, migrasi, dan konsistensi HPP (20 November 2026)

PR #141 menutup celah penggunaan nomor kolom tetap pada pembacaan/penulisan HPP master dan detail laporan. Semua jalur tersebut kini mencari kolom berdasarkan nama header. Migrasi costing memeriksa header dasar dan posisi kanonis; jika ditemukan header dasar yang berubah, kolom costing duplikat/salah posisi, atau kolom tambahan yang menghalangi append-only, migrasi dihentikan tanpa menulis.

Fungsi baru `auditFMartCostingIntegrity_()` bersifat READ_ONLY dan melaporkan konsistensi HPP master terhadap saldo gabungan Gudang+Kasir, saldo ganda/invalid, biaya detail penerimaan, jurnal MASUK, snapshot HPP detail pesanan dan POS, serta perbedaan master terhadap HPP sesudah mutasi MASUK terakhir. Laporan hanya menjumlah COGS dari snapshot `TERCATAT` yang subtotalnya sama dengan HPP unit × qty.

Regression CI menguji migrasi aman, pemetaan header dinamis, perhitungan snapshot, dan sifat read-only audit. Tidak ada migrasi yang dijalankan dan tidak ada perubahan saldo stok, HPP existing, transaksi, atau laporan Spreadsheet produksi.

**UAT wajib:** jalankan audit read-only pada salinan Spreadsheet yang diverifikasi, tinjau issue, lakukan uji penerimaan/mutasi/transfer/penjualan/retry, dan rekonsiliasi laporan dengan dokumen pembelian. Migrasi hanya boleh dilakukan setelah header dan data dinyatakan aman. Data transaksi lama tanpa bukti HPP tetap dibiarkan tidak bernilai; jangan direkonstruksi dari HPP saat ini.


**Status merge Tahap 40.9:** PR #141 berhasil di-merge ke `main` pada commit `7c9ad22e3d56768389a8b6a8d11c86d79b8e2718`. Regression CI pada head PR lulus. Source Apps Script aktif belum otomatis diperbarui. Uji audit database dan costing pada salinan Spreadsheet, sinkronisasi Apps Script, serta UAT tetap wajib sebelum migrasi/produksi.


## Addendum — Tahap 40.10 konsistensi UI relasi Wali dan navigasi role (20 November 2026)

PR #143 telah di-merge ke `main` melalui squash commit `bc5e3e7dfaa272c8024457aaf77a01e7d6df578a`. Audit statis mencocokkan peta navigasi staf dengan role backend dan guard handler menu. Supervisor tetap memiliki menu pengawasan baca-saja sesuai desain.

Dua keterangan UI yang keliru tentang hubungan Wali–Santri telah diperbaiki. UI kini menjelaskan bahwa relasi aktif otomatis hanya jika nomor HP akun Wali cocok dengan nomor Wali pada master Santri; jika tidak cocok/kosong, pengajuan menunggu verifikasi Admin. Regression CI pada PR lulus. Tidak ada perubahan data, skema, atau logika backend.

Status tetap **SOURCE AUDIT IN PROGRESS / RUNTIME UAT NOT RUN / PRODUCTION NOT APPROVED**. Audit visual aktual, akun, perangkat, dan alur transaksi akan dilakukan setelah seluruh tahap audit repository selesai.


## Addendum — Tahap 40.11 riwayat POS baca-saja untuk Supervisor (20 November 2026)

PR #145 telah di-merge ke `main` melalui squash commit `5b3ee7fe600ad12f6806b832b7db4a2aa06c6604`. Supervisor kini memiliki menu **Transaksi POS** khusus baca-saja, dengan filter pencarian/tanggal dan rincian item. Endpoint riwayat POS menerima Supervisor tanpa memberi akses ke endpoint pembuatan, pembatalan, atau verifikasi transaksi. Pembatasan Kasir agar hanya melihat transaksi miliknya tetap dipertahankan.

Regression CI pada PR lulus. Tidak ada perubahan data atau skema Spreadsheet. Uji akun dan rekonsiliasi transaksi aktual tetap menjadi gerbang runtime.


## Addendum — Tahap 40.12 dashboard pengawasan Supervisor (20 November 2026)

PR #147 telah di-merge ke `main` melalui squash commit `9bffd4e5b56b81caac32cc85103523aaa816c4f8`. Dashboard Supervisor kini terpisah dari Dashboard Gudang dan berisi ringkasan pesanan, status pemenuhan, produk aktif, serta pesanan terbaru. Pintasan hanya menuju Pesanan, Transaksi POS baca-saja, Seluruh Produk baca-saja, dan Laporan & Pencapaian.

Regression CI pada PR lulus. Tidak ada perubahan data, skema, atau endpoint mutasi. Validasi visual dan akses akun nyata tetap menunggu Uji Runtime.


## Penutupan Audit Repository — 20 November 2026

Audit source repository Tahap 40.1–40.13 telah ditutup. Baseline source `main` sebelum penutupan dokumentasi adalah `89acaaddfd8349825c5561479f49c8ca174847bd`; PR dokumentasi penutupan #149 di-merge menjadi `77c60d5e953408981dcf3629f5c9bf6f91e5ea84`. Regression CI pada kedua commit lulus **130/130 tes** dan build/deployment GitHub Pages berstatus success. Tidak ada PR terbuka. Perbaikan terakhir memastikan Supervisor mempunyai dashboard pengawasan yang tepat serta akses baca-saja ke seluruh riwayat POS, di samping pesanan, produk, dan laporan.

Tidak ada migrasi, penulisan data, atau rekonsiliasi Spreadsheet produksi yang dilakukan selama audit source. **Uji Runtime belum dimulai dan produksi belum disetujui.** Tahap selanjutnya adalah menjalankan checklist UAT secara terisolasi: verifikasi Script Properties dan target, gunakan salinan Spreadsheet/Drive, jalankan seluruh audit read-only, uji akun/role dan alur nyata, rekonsiliasi stok/HPP/laba/transaksi, lalu minta persetujuan pemilik proses.


## Addendum — Tahap 41.1 sinkronisasi dokumentasi dan role (21 November 2026)

Review ulang `main` setelah PR #186 menemukan bahwa beberapa pernyataan pada paket serah-terima ini adalah snapshot historis dan kini sudah kedaluwarsa. Secara khusus, butir lama bahwa Supervisor belum ada di backend sudah tidak berlaku: Supervisor telah diimplementasikan dan diuji secara statis pada PR #133, #145, #147, serta perbaikan form akun #175. Matriks terkini terdiri dari enam role petugas/Admin dan satu role Wali Santri.

Dokumentasi terkini diperbarui melalui SOP, checklist UAT, README, dan roadmap Tahap 41.1. Dua perbedaan UI/backend dicatat untuk audit izin Tahap 41.2: Admin mengakses antrean verifikasi pembayaran Wali melalui workspace POS meskipun tidak memiliki tombol navigasi verifikasi khusus. Admin/Kasir juga memiliki riwayat POS melalui workspace POS, sedangkan Supervisor memiliki halaman riwayat lintas kasir yang baca-saja. Perbedaan lokasi menu tersebut bukan bukti ketidaksesuaian hak akses; pengujian runtime per role tetap diperlukan. Tidak ada perubahan data produksi.

Status runtime UAT tetap **NOT RUN** dan produksi tetap **NOT APPROVED** sampai akun aktual, Apps Script deployment, Spreadsheet/Drive, seluruh alur role, dan perangkat diverifikasi.

## Addendum — Tahap 41.2 Audit Superadmin (21 November 2026)

Audit source Superadmin dilakukan pada apps-script/Code.gs, apps-script/Index.html, apps-script/SetupDatabase.gs, dan tests/fmart-regression.test.cjs. Kewenangan server untuk QRIS, manajemen staf, email OTP, bukti pembayaran, laporan, dan Audit Activity telah ditinjau. Dua perbaikan audit yang tidak mengubah alur transaksi disiapkan pada PR #189: pemeriksaan akun aktif Supervisor di audit runtime dan filter Aktivitas Audit untuk seluruh role.

CI/check PR #189 belum melaporkan status yang dapat diverifikasi; jangan menyatakan regression lulus sebelum workflow benar-benar selesai. Uji runtime dengan akun Superadmin dan role pembanding belum dilakukan. Jalankan runFMartReadinessAudit_() serta auditFMartCostingIntegrity_() secara terpisah; audit costing belum termasuk dalam fungsi readiness gabungan. Tidak ada perubahan data produksi.

**Status:** source review selesai; perubahan menunggu CI/review/merge; runtime NOT RUN; produksi NOT APPROVED.
