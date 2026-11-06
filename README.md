# Rungline

Siemens S7-1200/S7-1500 için yapay zekâ destekli, modern bir PLC IDE'si. TIA Portal'dan ayrı açılan bağımsız bir uygulamadır, eklentisi değildir. Geliştirme ve simülasyon TIA olmadan yapılır, program hazır olunca TIA'ya aktarılır. Electron, React ve TypeScript ile yazıldı. İçinde sanal bir S7 PLC vardır. Gerçek donanıma bağlanmaz.

## Çalıştırma

```
npm install
npm run dev
```

Örnek projeler `examples/` altındadır. Uygulamadan klasör olarak açılır.

## Kontroller

```
npm run typecheck
npm test
npm run build
npm run test:gui    # Electron arayüzünü Playwright ile dolaşır
npm run test:layout # Her ekranı dört pencere boyutunda taşma ve çakışma için ölçer
```

## TIA Portal

```
npm run tia:package -- examples/tia_smoke
```

Bu komut, TIA kurulu bir bilgisayara taşınacak `tia-package` klasörünü hazırlar. Adımlar [tools/tia-bridge/README.md](tools/tia-bridge/README.md) dosyasındadır.

**Durum: dışa ve içe aktarma gerçek TIA Portal ile henüz denenmedi.** Dosya biçimleri belgelerden ve bilgiden yazıldı. Köprü yalnızca TIA'yı taklit eden sahte bir kütüphaneyle çalıştırıldı.

| Öğe | Dışa aktarma | İçe aktarma |
|---|---|---|
| SCL blokları (OB, FB, FC) | Var | Var |
| Veri blokları, UDT'ler | Var | Var. İç içe başlangıç değerleri alınmaz, uyarı verilir |
| Etiket tabloları | SimaticML ve CSV | SimaticML |
| LAD blokları | Yok, uyarıyla atlanır | Yok, uyarıyla atlanır |

## Yapay zekâ ajanı

Ayarlardan bir Gemini anahtarı girin. Anahtar işletim sisteminin şifreli deposunda saklanır.

Ajan projenin mevcut halini görür. FB, FC, UDT, global DB ve etiket oluşturur, OB1'e ladder ekler ve blokları okuyabilir. Her yanıt bir bütün olarak uygulanır, derlenir ve simülatörde çalıştırılır. Model her ladder devresiyle birlikte bir zaman çizelgesi gönderir: hangi anda hangi giriş değişir, hangi çıkış ne olmalı. Yeni bir hata çıkarsa veya devre çizelgeye uymazsa yanıt geri alınır, hata ve programın gerçekte yaptıkları modele gönderilir ve en fazla 6 istekte yeniden denenir. Yine çözülmezse proje değişmez ve hata gösterilir.

Ajan 19 hazır devre kalıbını okuyabilir (mühürleme, yıldız-üçgen, timer zinciri, sayıcılar, adım dizisi...). Kalıplar bu proje için yazıldı ve `npm test` her birini simülatörde çalıştırır. Bir ders kitabından veya standarttan alınmadılar ve gerçek bir CPU'da denenmediler.

Donanım ayarlarını, simülasyon betiklerini değiştiremez ve etiket silemez.

## Bilinen sınırlar

Gerçek CPU'dan farklı veya doğrulanmamış davranışlar:

**Simülatör**

- Kesme OB'leri taramayı bölmez, taramalar arasında çalışır. Faz kaydırma yok sayılır
- Döngü OB'si olarak yalnızca OB1 çalışır, OB123 ve üstü çalışmaz
- INT taşması yalnızca belleğe yazılırken sarar, ara işlem sonuçlarında sarmaz
- LAD güç akışı durumu aynı FB'nin örnekleri arasında paylaşılır
- DATE ve TOD sabitleri desteklenmez
- TIA'nın sistem belleği açıkken kendiliğinden eklediği `FirstScan` gibi semboller yok. Adresle yazılmalı: `%M1.0`
- REAL'den tamsayıya örtük atamada yuvarlama bir varsayımdır
- CPU bellek boyutları ve watchdog'da STOP kuralı Siemens belgeleriyle karşılaştırılmadı

**TIA'ya aktarım**

- Kaynak dosyası OB tipini belirtemez. OB30 gibi kesme OB'lerinin tipi TIA'da kontrol edilmelidir
- Blok numarasının aktarılması doğrulanmadı. Olmazsa TIA numarayı kendi verir

**IDE**

- Silinen blok, UDT ve etiket tablolarının dosyaları projedeki `.trash` klasörüne taşınır. Geri almak için dosya elle taşınmalıdır
- Arayüz tablosu bir kaynağı yeniden yazarken bildirim bölümleri arasındaki yorumlar kaybolur

**Yapay zekâ ajanı**

- API anahtarı veya Ollama sunucusu olmadan çalışmaz. Yerleşik hazır yanıtlar yoktur
- Gemini etiketleri, blok adlarını ve okuduğu blokların kaynağını Google'a gönderir. Gizli bir projede kullanmadan önce Google'ın koşullarını okuyun
- Yalnızca Gemini yolu araç döngüsü kullanır. OpenAI ve Ollama yalnızca OB1'e ladder ekler, derleyici kontrolünden ve simülasyon testinden geçmez
- Ladder yalnızca OB1'e yazılır. Ajan bir FB veya FC üretebilir, ama onu ladder'dan çağıramaz ve yeni OB ekleyemez
- Simülasyon testini geçmek, devrenin isteğinizi yaptığını kanıtlamaz. Testi de model yazar ve eksik yazabilir. Çizelgeyi ve programı kendiniz sınayın
- Simülasyon testi yalnızca OB1 ve başlangıç OB'lerini çalıştırır, çevrimsel kesme OB'lerini (OB30..OB38) çalıştırmaz. FB ve FC üreten araç çağrılarında sınanan da sadece ladder devresidir
- Model test göndermezse bir kez istenir, yine göndermezse devre "doğrulanmadı" notuyla kabul edilir
- Diff-View'da simülasyon testi onaydan önce çalışır, ama yanıtta yeni blok veya etiket oluşturan araç çağrıları da varsa çalışamaz ve bu yanıtta belirtilir. Derleyici kontrolü onaydan sonra çalışır ve hata varsa değişiklik geri alınmaz, Undo Turn ile alınır
- Undo Turn, ajanın diske yazdığı yeni dosyaları silmez. Proje yeniden açılınca bu bloklar geri gelir

## Lisans

[MIT](LICENSE)

Kodun büyük bölümü yapay zekâ araçlarıyla (Claude) yazıldı. Commit geçmişinde `Co-Authored-By` satırlarıyla görülebilir.

## Geri bildirim

Önerilerinizi ve bulduğunuz hataları [Issues](https://github.com/Berat-Ay/PLC_SmartIDE/issues) üzerinden paylaşırsanız çok sevinirim.
