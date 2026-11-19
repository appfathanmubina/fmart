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
- **PR #130 / Tahap 40.4:** memperbaiki tombol Masuk yang sebelumnya dapat diblokir validasi native browser karena kolom OTP tersembunyi memiliki atribut `required` sejak awal. Status `required` sekarang hanya aktif saat panel OTP ditampilkan, lalu dibersihkan saat panel ditutup atau OTP berhasil. Regression CI dan build GitHub Pages pasca-merge lulus.
- Perbaikan tidak mengubah backend autentikasi, akun, role, database, atau data produksi. Tombol Masuk belum diuji langsung pada browser/runtime.

Status keseluruhan tetap: **SOURCE AUDIT / REGRESSION PASS — RUNTIME UAT NOT COMPLETE — PRODUCTION NOT APPROVED.**
