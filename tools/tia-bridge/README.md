# TIA Bridge: okulda test rehberi

Bu araç, IDE'nin ürettiği paketi gerçek TIA Portal'da derler ve sonucu rapor olarak yazar.

**Bu araç henüz gerçek TIA Portal ile hiç çalıştırılmadı.** Yalnızca TIA'yı taklit eden sahte bir kütüphaneyle
akışı denendi. Hata çıkması normaldir. Çıkan rapor, projenin eksik kalan parçasıdır.

## Evde hazırlık

```
npm run tia:package
```

Oluşan `tia-package` klasörünü USB belleğe kopyala. İçinde `TiaBridge.exe`, `run-verify.cmd` ve `bundle` klasörü olmalı.

## Okuldaki bilgisayarda

Gerekenler: TIA Portal V17 veya üstü, STEP 7 lisansı, TIA Openness bileşeni.

1. Hesabının `Siemens TIA Openness` Windows grubunda olduğunu kontrol et. Komut satırına şunu yaz:
   ```
   net localgroup "Siemens TIA Openness"
   ```
   Adın listede yoksa hocandan seni eklemesini iste. Ekledikten sonra oturumu kapatıp yeniden açman gerekir.
2. `tia-package` klasörünü USB'den masaüstüne kopyala. USB üzerinde çalıştırma.
3. `run-verify.cmd` dosyasına çift tıkla. İlk çalışmada TIA Portal erişim onayı isteyebilir. **Yes** veya **Yes to all** seç.
4. Bitene kadar bekle. Birkaç dakika sürebilir.
5. **`result` klasörünün tamamını** USB'ye geri al.

Okul bilgisayarında exe çalıştırmak yasaksa, `build.cmd` ile kaynaktan derlemeyi dene. O da yasaksa hocana sor.

## Sonucu okuma

| Çıkış kodu | Anlamı |
|---|---|
| 0 | Paket içe aktarıldı ve TIA'da derlendi |
| 2 | Araç çalıştı, TIA projede sorun buldu. Sebebi `tia-report.json` içinde |
| 1 | Araç çalışamadı: Openness bulunamadı, yetki yok veya CPU oluşturulamadı |

`result` klasöründekiler:

- `tia-report.json`: her adımın ve derlemenin sonucu
- `exported/`: TIA'nın yazdığı gerçek XML ve kaynak dosyalar. Testlerdeki elle yazılmış örneklerin yerine bunlar geçecek
- `tia-project/`: oluşturulan proje. TIA'da açıp bakabilirsin

Çalışma sadece `result` klasörüne yazar. Var olan TIA projelerine dokunmaz.

## Sık karşılaşılabilecek durumlar

**CPU oluşturulamadı.** O bilgisayardaki TIA'da aynı firmware yoktur. Firmware'i değiştirerek dene:
```
TiaBridge.exe verify bundle --out result --cpu "OrderNumber:6ES7 214-1AG40-0XB0/V4.5"
```

**Birden fazla TIA sürümü kurulu.** En yeni sürüm seçilir. Başka birini seçmek için `--tia-version V18` ekle.

**Openness bulunamadı.** DLL'lerin olduğu klasörü elle ver:
```
TiaBridge.exe verify bundle --out result --api-dir "C:\Program Files\Siemens\Automation\Portal V19\PublicAPI\V19\net48"
```

**TIA'yı açık görerek izlemek.** Komutun sonuna `--ui` ekle.

## Diğer komutlar

Hocanın **bir kopya** projesinden gerçek LAD/SCL örnekleri almak Faz 3 için çok değerlidir:
```
TiaBridge.exe export --project "C:\kopya\Proje.ap19" --out ornekler
```
Bu komut projeyi derler ama kaydetmez. Yine de başkasının projesinde değil, kopyasında çalış.

Paketi var olan bir projeye eklemek için aşağıdaki komut vardır. **Projeyi değiştirip kaydeder**, aynı adlı blokların
üzerine yazabilir. Sadece kopya projede kullan:
```
TiaBridge.exe import bundle --project "C:\kopya\Proje.ap19" --out sonuc
```

## Doğrulanmamış varsayımlar

Bu noktaları ilk gerçek çalıştırma gösterecek:

- Blok numarasını `SetAttribute("Number", ...)` ile ayarlamak. Olmazsa rapora not düşülür, TIA numarayı kendi verir
- `GenerateSource` çağrısının imzası. Olmazsa XML dışa aktarımı yine çalışır
- Etiket tablosu XML biçimi. Elle yazıldı, gerçek bir dışa aktarımla karşılaştırılmadı
- OB30 gibi kesme OB'lerinin kaynaktan doğru tipte oluşması. Kaynak dosyası OB tipini söyleyemiyor
- V17-V20 sürümleri. Openness bilgileri V21 tabanlı belgelerden alındı
