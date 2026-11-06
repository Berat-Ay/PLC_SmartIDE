# Rungline

Siemens S7-1200/S7-1500 için yapay zekâ destekli, modern bir PLC IDE'si. TIA Portal'ın yerine geçmeyi değil, önce yanında daha hızlı bir yardımcı olmayı hedefler. Electron, React ve TypeScript ile yazıldı. İçinde sanal bir S7 PLC vardır. Gerçek donanıma bağlanmaz.

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

## Bilinen sınırlar

Gerçek CPU'dan farklı veya doğrulanmamış davranışlar:

**Simülatör**

- Kesme OB'leri taramayı bölmez, taramalar arasında çalışır. Faz kaydırma yok sayılır
- Döngü OB'si olarak yalnızca OB1 çalışır, OB123 ve üstü çalışmaz
- INT taşması yalnızca belleğe yazılırken sarar, ara işlem sonuçlarında sarmaz
- LAD güç akışı durumu aynı FB'nin örnekleri arasında paylaşılır
- DATE ve TOD sabitleri desteklenmez
- REAL'den tamsayıya örtük atamada yuvarlama bir varsayımdır
- CPU bellek boyutları ve watchdog'da STOP kuralı Siemens belgeleriyle karşılaştırılmadı

**TIA'ya aktarım**

- Kaynak dosyası OB tipini belirtemez. OB30 gibi kesme OB'lerinin tipi TIA'da kontrol edilmelidir
- Blok numarasının aktarılması doğrulanmadı. Olmazsa TIA numarayı kendi verir

**IDE**

- Silinen bloklar diskte kalır, elle silinmesi gerekir
- Arayüz tablosu bir kaynağı yeniden yazarken bildirim bölümleri arasındaki yorumlar kaybolur
- Gemini bağlantısı gerçek bir anahtarla denenmedi

## Geri bildirim

Önerilerinizi ve bulduğunuz hataları [Issues](https://github.com/Berat-Ay/PLC_SmartIDE/issues) üzerinden paylaşırsanız çok sevinirim.
