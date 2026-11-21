# FMart — Tahap 4 UAT dan Kesiapan Produksi

**Status:** checklist siap dijalankan. Runtime UAT belum dilakukan dari repository; operator Apps Script harus menjalankannya dan melampirkan hasil aktual.

## 1. Hasil CI dan batas validasi

| Tahap | PR | Status | Regression |
|---|---:|---|---:|
| Tahap 1 — Security hardening | #12 | Merged; CI sebelumnya lulus | Tercakup dalam suite |
| Tahap 2 — Integritas transaksi | #13 | Merged; CI lulus | 18 lulus, 0 gagal |
| Tahap 3 — UI/UX dan aksesibilitas | #14 | Merged; CI lulus | 22 lulus, 0 gagal |

Pada CI Tahap 2 dan 3, pemeriksaan sintaks `Code.gs`, sintaks service worker, regression test, dan `git diff --check` lulus.

**Yang belum divalidasi:** runtime Google Apps Script, izin Drive, Spreadsheet produksi, trigger terpasang, riwayat Executions, transaksi multi-user/bersamaan, serta tampilan browser dan perangkat nyata. CI statis bukan bukti bahwa UAT runtime sudah lulus.

### Baseline repository terbaru — 19 November 2026

- Branch `main` setelah PR #125: `4aac87e6b8e1e54eb142fcf31bf3cdbe9acd95de` (perubahan SOP/roadmap dokumentasi menyusul pada PR #126).
- Regression suite: 117 test lulus.
- Build/deployment GitHub Pages: lulus pada commit tersebut.
- Perubahan keamanan terbaru: validasi folder bukti pengantaran, inventaris 83 endpoint UI, isolasi data Wali/Kasir/Pengantaran, self-link Wali berbasis pencocokan `no_wa_wali`, dan batas maksimum dua relasi aktif/pending.

Hasil CI ini hanya baseline source. Semua skenario pada dokumen ini tetap harus dijalankan dan dilaporkan secara runtime sebelum produksi dinyatakan siap.

## 2. Sinkronisasi Apps Script

1. Buat backup Spreadsheet sebelum migrasi header.
2. Pastikan project Apps Script terikat pada Spreadsheet FMart yang benar. Jangan menjalankan setup dari spreadsheet lain.
3. Sinkronkan file dari branch `main`: `SetupDatabase.gs`, `Code.gs`, dan `Index.html`.
4. **Jangan jalankan setup/migrasi database sebagai bagian dari audit read-only.** `setupFMartDatabase_()` mengubah struktur/default database dan bukan fungsi audit. Jalankan setup hanya jika hasil audit membuktikan diperlukan, setelah target Spreadsheet dipastikan dan backup tersedia, melalui prosedur perubahan database yang disetujui.
5. Di Apps Script Editor, pilih fungsi **`runFMartReadinessAudit_`** dari daftar fungsi Apps Script Editor lalu klik **Run**. Akhiran underscore menjaga fungsi ini tetap privat dari pemanggilan browser (`google.script.run`), tetapi tetap dapat dijalankan manual dari editor. Fungsi ini read-only dan menggabungkan audit database, runtime/Drive/trigger, konsistensi operasional, stok/POS, penerimaan, dan transaksi terhenti.
6. Simpan hasil lengkap dari Execution log. Jangan lanjut ke uji transaksi jika ada header mismatch, sheet wajib hilang, referensi rusak, stok negatif, atau saldo/mutasi tidak cocok.

Jangan menjalankan `installDeliveryAutomationTrigger_()` secara manual sebelum hasil audit trigger diperiksa. Fungsi instalasi trigger dapat membuat perubahan; pastikan tidak ada trigger duplikat.

## 3. Strategi keamanan lingkungan

Saat checklist ini dibuat, project Testing belum tersedia.

- Audit read-only, login, dan pemeriksaan visibilitas menu dapat dilakukan setelah sinkronisasi dengan risiko rendah.
- **Jangan** menguji transaksi gagal, duplikat, bersamaan, pembatalan, atau pemulihan pada data pelanggan/stok produksi.
- Untuk uji transaksi, siapkan salinan Spreadsheet dan project Apps Script uji dengan data dummy, akun uji, produk uji, dan folder Drive uji. Jika belum tersedia, tandai skenario transaksi sebagai **BLOCKED — belum ada lingkungan uji**, bukan PASS.
- Jangan memakai transaksi pelanggan nyata sebagai data uji. Jangan menghapus atau mengubah baris transaksi langsung di Spreadsheet untuk membersihkan hasil pengujian.

## 4. Akun dan hak akses

Siapkan akun uji terpisah untuk setiap role. Jangan berbagi password atau OTP melalui laporan.

| Role | Yang harus terlihat | Yang harus ditolak |
|---|---|---|
| Superadmin | Seluruh menu, pengaturan QRIS, pengguna, laporan, POS, Gudang, pengantaran | Akses file/Spreadsheet di luar izin yang diberikan |
| Admin | Operasional, pengguna sesuai haknya, laporan, POS, Gudang, pengantaran | Pengaturan QRIS dan tindakan khusus Superadmin |
| Kasir | Dashboard Kasir, POS, antrean verifikasi QRIS Wali | Pengaturan QRIS, menu Gudang/Admin, verifikasi metode non-QRIS |
| Gudang | Dashboard, pesanan/pemenuhan, stok Gudang, penerimaan, laporan Gudang, penugasan pengantaran | Pengaturan QRIS, pengguna, data pembayaran yang tidak diperlukan |
| Petugas Pengantar | Dashboard dan tugas pengantaran miliknya | Tugas petugas lain, stok, POS, pembayaran, pengaturan |
| Supervisor | Dashboard pengawasan, semua Pesanan, semua Transaksi POS, seluruh Produk, Laporan & Pencapaian (baca-saja) | Mutasi POS, verifikasi pembayaran, edit katalog/kategori/harga, mutasi/penerimaan stok, penugasan/status pengantaran, manajemen akun, pengaturan QRIS, Audit Activity |
| Wali Santri | Katalog, keranjang, pesanan anak yang terhubung, pembayaran QRIS, bukti pengantaran/konfirmasi | Pesanan wali lain, menu staf, pengaturan QRIS |

Catatan role:
- Role `SUPERVISOR` sudah didefinisikan pada backend, portal Admin, form akun, navigasi, dan regression test. Uji bahwa seluruh halaman Supervisor bersifat baca-saja dan semua endpoint mutasi/administrasi tetap ditolak. Status akun aktual tetap diverifikasi pada runtime.
- Hubungan Wali–Santri yang berstatus `MENUNGGU_VERIFIKASI` belum memberi akses sebagai Santri terhubung; hanya relasi `AKTIF` yang boleh digunakan untuk akses data/checkout sebagai Santri terhubung.

Untuk setiap role:
- Login berhasil dan identitas/role benar.
- Menu yang tidak berhak tidak muncul dan tidak dapat difokuskan dengan keyboard.
- Coba panggil endpoint terlarang secara langsung dari UI console/test harness. Backend harus tetap menolak meskipun menu disembunyikan.
- Kasir hanya boleh melihat/memeriksa antrean QRIS Wali; untuk POS, riwayat dan aksi QRIS dibatasi pada transaksi milik akun sendiri. Kasir tidak boleh mengubah konfigurasi QRIS.
- Supervisor harus dapat membaca seluruh riwayat POS, tetapi tidak dapat membuat, mengubah, membatalkan, atau mengonfirmasi transaksi.
- Verifikasi jalur UI yang berbeda: Kasir dan Superadmin membuka antrean Verifikasi QRIS Wali melalui navigasi khusus; Admin membuka antrean dan aksi verifikasi dari workspace POS. Riwayat POS Kasir/Admin berada di workspace POS sesuai batas transaksi, sedangkan Supervisor memakai halaman riwayat lintas kasir yang baca-saja. Pastikan pemanggilan endpoint dan menu yang tampil sesuai dengan jalur role; jangan menyamakan perbedaan tombol navigasi dengan perbedaan kewenangan.
- Pengaturan QRIS hanya dapat dibuka dan diubah oleh Superadmin.

### 4.1 Relasi Wali–Santri berdasarkan nomor wali

- Siapkan satu Santri aktif dengan `no_wa_wali` terisi dan akun Wali dengan nomor sama dalam format berbeda (misalnya 08... dan +62...); setelah normalisasi, relasi harus langsung menjadi `AKTIF`.
- Uji nomor berbeda; permintaan harus berstatus `MENUNGGU_VERIFIKASI` dan tidak boleh memberi akses ke data Santri sebagai anak terhubung.
- Uji `no_wa_wali` kosong; hasil juga harus pending, bukan aktif.
- Uji pengajuan pending berulang; tidak boleh membuat relasi pending ganda.
- Pastikan Admin dapat memeriksa dan menyetujui melalui jalur verifikasi manual.
- Pastikan maksimal dua akun Wali unik dalam gabungan status aktif/pending. Jika data lama sudah melampaui batas, persetujuan Admin harus ditolak sampai relasi direkonsiliasi.
- Relasi aktif lama tidak boleh dicabut otomatis oleh perubahan ini.

### 4.1.1 Uji khusus Supervisor
- Login sebagai Supervisor dan pastikan hanya menu Dashboard, Pesanan, Transaksi POS, Produk, dan Laporan yang tersedia.
- Pastikan halaman Produk dan Laporan Supervisor tidak menjalankan migrasi skema HPP; jika kolom HPP belum tersedia, Admin/Superadmin harus menyiapkan skema sebelum UAT Supervisor.
- Pada detail pesanan Supervisor, pastikan nomor kontak dan alamat pribadi penerima tidak dikirim sebagai field recipient; informasi tujuan pengantaran yang memang diperlukan untuk pengawasan tetap tersedia.
- Baca detail pesanan, seluruh riwayat POS, katalog lengkap, dan laporan.
- Uji endpoint mutasi POS, verifikasi pembayaran, edit/tambah produk/kategori, mutasi/penerimaan stok, penugasan pengantaran, manajemen akun, pengaturan QRIS, dan Audit Activity; server harus menolak.
- Pastikan Supervisor tidak dapat mengakses data Wali yang tidak relevan atau data rahasia akun.

### 4.1.2 Uji khusus Superadmin
- Pastikan Superadmin dapat membuka Dashboard, Pesanan, POS, Verifikasi QRIS Wali, Produk, Stok, Penerimaan, Riwayat Gudang, Distribusi, Komplain, Pengguna, Laporan, Aktivitas Audit, dan Pengaturan QRIS sesuai alur UI.
- Buat akun uji untuk setiap role staf yang dibutuhkan; pastikan form staf tidak membuat akun Superadmin baru.
- Uji ubah nama/role, aktif/nonaktif, reset password, dan perubahan email staf. Email baru hanya boleh berlaku setelah OTP benar; kode salah dibatasi lima percobaan, kedaluwarsa, dan tidak boleh mengubah email lama jika pengiriman email gagal.
- Uji bahwa akun Superadmin sendiri tidak dapat diubah, dinonaktifkan, atau direset melalui endpoint manajemen staf.
- Ubah pengaturan QRIS hanya pada lingkungan uji; verifikasi URL HTTPS, pratinjau gambar, WhatsApp opsional, dan tampilan QRIS pada portal Wali. Jangan mengubah konfigurasi produksi saat UAT.
- Verifikasi pembayaran Wali hanya setelah dana benar-benar cocok pada merchant; uji bukti privat, penolakan, dan larangan akses untuk role yang tidak berhak.
- Buka Laporan dan Aktivitas Audit. Uji filter ADMIN, SUPERADMIN, KASIR, GUDANG, PETUGAS_PENGANTAR, SUPERVISOR, WALI_SANTRI, dan SYSTEM.
- Uji pemanggilan langsung seluruh endpoint khusus Superadmin menggunakan token Admin/Kasir/Gudang/Petugas Pengantar/Supervisor; server harus menolak.
- Jalankan runFMartReadinessAudit_() untuk pemeriksaan umum dan auditFMartCostingIntegrity_() secara terpisah. Readiness audit belum memanggil audit costing secara otomatis. Jika migrasi kolom HPP memang diperlukan, fungsi internal migrateFMartCostingSchema_() hanya dijalankan dari Apps Script Editor; jangan membuka atau memanggilnya sebagai endpoint PWA.
- Catat hasil source, CI, dan runtime secara terpisah. Source atau CI yang lulus tidak menggantikan UAT akun nyata.

### 4.1.3 Uji silang batas akses seluruh role petugas
- Admin: antrean pembayaran Wali dan riwayat POS tersedia di workspace POS; daftar staf hanya baca; relasi Wali–Santri dapat dikelola tetapi akun Wali tidak dapat diedit; pengaturan QRIS ditolak.
- Kasir: dashboard, penjualan, riwayat dan antrean QRIS POS hanya untuk akun sendiri; konfirmasi/pembatalan transaksi Kasir lain harus ditolak; verifikasi Wali hanya QRIS; detail pesanan dan bukti pembayaran non-QRIS harus ditolak.
- Gudang: stok, HPP, penerimaan, transfer ke Kasir, riwayat, dan distribusi dapat dilakukan sesuai transisi; antrean detail pembayaran Wali tidak boleh dikirim ke dashboard; endpoint verifikasi harus ditolak.
- Petugas Pengantar: hanya penugasan akun sendiri yang tampil; semua aksi terikat pada penugasan sendiri; bukti JPG/PNG/WEBP maksimal 10 MB; petugas tidak dapat mengonfirmasi penerimaan.
- Supervisor: hanya Dashboard, Pesanan, Transaksi POS, Produk, dan Laporan baca-saja; antrean pembayaran Wali, kontak/alamat pribadi penerima, Audit Activity, dan seluruh endpoint mutasi harus ditolak/tidak dikirim.
- Untuk setiap role, ulangi pengujian melalui UI dan pemanggilan endpoint langsung menggunakan token role tersebut. Simpan bukti respons server; menyembunyikan tombol saja tidak dianggap lulus.
- Jalankan UAT dengan akun aktif masing-masing role. Jika akun tidak tersedia, tandai BLOCKED, jangan menggantinya dengan asumsi source.

## 5. Uji transaksi

Jalankan hanya pada data uji yang terisolasi.

### 5.1 Checkout Wali
- Checkout satu santri dengan beberapa item terpilih.
- Klik tombol checkout dua kali dengan cepat.
- Simulasikan retry request yang sama dengan request key dan payload sama.
- Ulangi dengan payload berbeda tetapi request key sama; backend harus menolak.
- Pastikan hanya satu Pesanan, satu set DetailPesanan, satu Pengiriman, dan item keranjang terpilih terhapus.
- Item keranjang yang tidak dipilih harus tetap ada.

### 5.2 Pembayaran QRIS Wali
- Metode Wali harus QRIS saja.
- Nominal sama persis dengan total pesanan diterima; nominal kurang/lebih ditolak.
- Uji file JPG/PNG/WEBP/PDF valid dan file dengan ekstensi/MIME palsu.
- Retry file dan request key yang sama tidak boleh membuat pembayaran atau file bukti ganda.
- Uji order yang sudah punya pembayaran pending/terverifikasi; pengajuan kedua harus ditolak.
- Pastikan Kasir hanya melihat antrean QRIS Wali; keputusan verifikasi tetap berdasarkan kecocokan dana pada merchant QRIS, bukan screenshot semata.

### 5.3 POS Kasir
- Uji transaksi tunai dan QRIS POS secara terpisah.
- Pastikan pembayaran QRIS POS baru memotong stok setelah konfirmasi yang sah.
- Uji request key yang sama dan klik ganda; satu transaksi hanya boleh menghasilkan satu pengurangan stok.
- Uji dua Kasir bersamaan membeli unit terakhir. Tidak boleh ada stok negatif atau penjualan melebihi stok.
- Pastikan stok Kasir terpisah dari stok Gudang dan mutasi POS tercatat pada lokasi yang benar.

### 5.4 FIFO dan pemenuhan pesanan
- Buat dua pesanan terbayar saat stok tidak cukup.
- Pastikan pesanan tertua diproses lebih dahulu setelah penerimaan menambah stok.
- Pastikan pesanan yang belum cukup stok tetap menunggu dan tidak memotong stok parsial.
- Uji pemulihan saat eksekusi terhenti setelah mutasi tercatat tetapi sebelum saldo/status selesai. Pemulihan harus melanjutkan nilai yang sama, bukan mengurangi stok dua kali.
- Pastikan reservasi hanya berubah menjadi digunakan setelah semua baris pemenuhan selesai.

### 5.5 Penerimaan Gudang
- Catat penerimaan multi-item dan cocokkan header, detail, saldo stok, mirror variasi, mutasi masuk, dan AuditLog.
- Retry request key yang sama harus menghasilkan satu penerimaan dan satu kenaikan stok per item.
- Uji payload berbeda dengan request key sama; harus ditolak.
- Uji pemulihan dari payload tersimpan. Jika saldo aktual tidak sama dengan saldo sebelum/sesudah yang diharapkan, pemulihan harus berhenti dan melaporkan konflik.
- Jangan memperbaiki selisih stok dengan mengedit histori mutasi secara manual.

### 5.6 Bukti pengantaran dan konfirmasi
- Hanya petugas yang ditugaskan boleh mengunggah bukti.
- Uji signature file dan penolakan MIME palsu; format pratinjau hanya JPG/PNG/WEBP.
- File maksimal 10 MB; file di atas batas harus ditolak.
- Pastikan file tersimpan di folder `FMART_DELIVERY_PROOF_FOLDER_ID`, dan folder ini berbeda dari `FMART_PAYMENT_PROOF_FOLDER_ID`.
- Uji file yang berada di folder lain; endpoint pratinjau harus menolak file tersebut.
- Retry bukti yang sama untuk penugasan yang sama harus menggunakan bukti yang sama dan tidak membuat konfirmasi/notifikasi/riwayat ganda.
- Pastikan Wali hanya melihat bukti untuk pesanan miliknya dan tidak dapat meminta file milik Wali lain.
- Pastikan auto-confirm tujuh hari hanya berlaku untuk pengantaran yang memang menunggu konfirmasi; tidak boleh berlaku untuk pengambilan langsung.

## 6. Audit data, Drive, dan trigger

Jalankan fungsi privat `runFMartReadinessAudit_` dari daftar fungsi Apps Script Editor dan simpan seluruh hasil. Jangan membuat wrapper publik tanpa underscore karena dapat membuka fungsi audit sebagai endpoint browser. Fungsi audit individual berakhiran underscore dipanggil otomatis oleh audit gabungan. Audit gabungan memanggil pemeriksaan internal berikut secara otomatis (fungsi berakhiran underscore bukan entry point publik untuk dijalankan langsung dari daftar fungsi editor):

- `auditFMartDatabaseIntegrity_()` — header, primary ID, referensi, dan konsistensi database.
- `auditFMartRuntime_()` — Spreadsheet terhubung, sheet wajib, akun role, folder Drive, dan trigger.
- `auditFMartOperationalSync_()` — master produk, variasi, stok, mutasi, dan relasi operasional.
- `auditFMartStockReconciliation_()` — rantai mutasi, saldo Gudang/Kasir, reservasi, POS, dan pesanan.
- `auditCashierPOSIntegrity_()` — total POS, request key, reservasi, dan mutasi.
- `auditWarehouseReceivingIntegrity_()` — header/detail penerimaan, mutasi masuk, dan AuditLog.
- `auditFMartTransactionRecovery_()` — transaksi yang mungkin terhenti.

Pemeriksaan Drive:
- Pastikan `FMART_DELIVERY_PROOF_FOLDER_ID` dan `FMART_PAYMENT_PROOF_FOLDER_ID` berisi ID folder berbeda dan folder tidak dibagikan publik tanpa alasan.
- File bukti pengantaran harus benar-benar berada di folder pengantaran yang dikonfigurasi; file di luar folder harus ditolak.
- Folder bukti QRIS dan pengantaran tersedia dan ID-nya sesuai pengaturan.
- Folder bukti QRIS dan pengantaran tersedia dan ID-nya sesuai pengaturan.
- File bukti dapat dibuka oleh role yang berhak dan ditolak bagi role yang tidak berhak.
- Tidak ada folder bukti publik tanpa alasan yang disetujui.
- Pastikan file orphan/duplikat yang ditemukan tidak dihapus sebelum referensi transaksi diperiksa.

Pemeriksaan trigger:
- Cocokkan daftar trigger pada hasil `auditFMartRuntime_()` dengan trigger yang memang diperlukan.
- Pastikan tidak ada trigger duplikat.
- Periksa Executions untuk keberhasilan, kegagalan, durasi, dan error terbaru.
- Jalankan fungsi instalasi trigger hanya bila audit menunjukkan trigger memang belum ada dan operator telah memeriksa efeknya.

## 7. UI/UX dan perangkat

Uji minimal:
- Desktop Chrome: 1440×900 dan 1280×720.
- Tablet portrait: 768×1024.
- HP: 390×844 dan 360×800.
- Jika tersedia: Android Chrome dan iOS Safari.

Periksa setiap halaman/menu yang dapat diakses role terkait:
- Login, OTP, Dashboard, katalog, detail produk, keranjang, checkout, pesanan, pembayaran.
- POS, antrean QRIS, katalog/stok, penerimaan, pemenuhan Gudang, laporan.
- Penugasan pengantaran, unggah bukti, konfirmasi, komplain, pengguna, dan pengaturan QRIS.

Checklist visual dan aksesibilitas:
- Tidak ada horizontal overflow pada halaman; tabel boleh scroll horizontal di dalam wrapper.
- Tidak ada modal terpotong; tombol aksi utama terlihat dan dapat dijangkau.
- Semua kontrol penting memiliki target sentuh minimal 44px.
- Navigasi keyboard menunjukkan focus ring dan urutan Tab logis.
- Label input terbaca; error form/notifikasi tidak hanya dibedakan dengan warna.
- Zoom browser 200% tetap dapat digunakan.
- Reduced motion tidak menghasilkan animasi yang mengganggu.
- PWA tidak menampilkan identitas/ikon yang salah dan navigasi tetap berfungsi setelah instalasi.

## 8. Kriteria lulus dan laporan hasil

Satu skenario hanya boleh diberi PASS jika ada bukti aktual. Gunakan status:
- **PASS** — berhasil dan bukti log/screenshot tersedia.
- **FAIL** — hasil aktual tidak sesuai ekspektasi; catat error dan jangan lanjut ke produksi.
- **BLOCKED** — belum dapat diuji, misalnya belum ada project/data uji.
- **NOT RUN** — belum dijalankan.

Catat minimal:
1. Tanggal/waktu dan zona waktu.
2. Versi/commit `main` yang disinkronkan.
3. Role akun uji (tanpa password/token).
4. Browser, perangkat, dan ukuran viewport.
5. Nama skenario, hasil, jumlah record sebelum/sesudah, dan Execution ID.
6. Screenshot/log yang sudah disamarkan dari data pribadi, token, OTP, dan URL rahasia.

**Kriteria siap produksi:** seluruh audit database/runtime/Drive/stok/POS/penerimaan bersih atau memiliki pengecualian yang disetujui tertulis; semua skenario kritis transaksi lulus di lingkungan uji; tidak ada duplikasi, stok negatif, akses lintas role, trigger duplikat, atau bukti file yang bocor; dan seluruh regresi CI lulus.

Jangan mengaktifkan PBKDF2 atau mengubah konfigurasi produksi sampai hasil benchmark Apps Script, backup, dan UAT login/OTP dinyatakan aman. Fitur PBKDF2 tetap dalam mode runtime-gated.
