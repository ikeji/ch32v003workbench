# badge.c TinyC移植 設計ドキュメント

## 概要

`firmware/badge.c` は CH32V003 で ADC + I2C OLED (SSD1306) を使っておみくじ画像を表示するプログラム。これを TinyC に移植する。

## 元プログラムの構成

### 機能

1. ADC (PA2) からノイズを読み取り、擬似乱数を生成
2. SSD1306 (128x64 I2C OLED) を初期化
3. 10種類のおみくじ画像からランダムに1つ選び表示
4. 画像は XBM フォーマット (各1024バイト、128x64/8)

### ハードウェアレジスタアドレス

```
RCC Base:    0x40021000
  CFGR0:     +0x04
  APB2PCENR: +0x18
  APB1PCENR: +0x1C
  APB2PRSTR: +0x0C
  APB1PRSTR: +0x10

GPIOA Base:  0x40010800
GPIOC Base:  0x40011000
GPIOD Base:  0x40011400
  CFGLR:     +0x00
  BSHR:      +0x10

I2C1 Base:   0x40005400
  CTLR1:     +0x00
  CTLR2:     +0x04
  DATAR:     +0x10
  STAR1:     +0x14
  STAR2:     +0x18
  CKCFGR:    +0x1C

ADC1 Base:   0x40012400
  STATR:     +0x00
  CTLR2:     +0x08
  SAMPTR2:   +0x10
  RSQR1:     +0x2C
  RSQR2:     +0x30
  RSQR3:     +0x34
  RDATAR:    +0x4C

FLASH Base:  0x40022000
  KEYR:      +0x04
  STATR:     +0x0C
  CTLR:      +0x10
  BOOT_MODEKEYR: +0x28
```

### SSD1306 初期化コマンド列 (26バイト)

```
0xAE        Display OFF
0xD5, 0x80  Set display clock divide ratio
0xA8, 0x3F  Set multiplex ratio (64)
0xD3, 0x00  Set display offset (0)
0x40        Set start line (0)
0x8D, 0x14  Enable charge pump
0x20, 0x00  Set memory addressing mode (horizontal)
0xA1        Set segment remap
0xC8        COM output scan direction
0xDA, 0x12  Set COM pins configuration
0x81, 0x8F  Set contrast
0xD9, 0xF1  Set precharge period
0xDB, 0x40  VCOMH deselect level
0xA4        Entire display ON (from RAM)
0xA6        Normal display (not inverted)
0xAF        Display ON
0xFF        Terminate marker
```

### I2C通信プロトコル

- SSD1306 I2C アドレス: 0x3C
- コマンド送信: `[0x00, cmd]` を I2C 送信
- データ送信: `[0x40, data...]` を I2C 送信
- フレームバッファは 32バイトずつ送信 (計32回 = 1024バイト)

### フレームバッファ

- サイズ: 1024バイト (128 * 64 / 8)
- SRAM上に配置: 0x20000000
- ピクセル操作: バイト単位でビット操作 (peek8/poke8)

### 画像データ

- XBM形式: 各1024バイト、LSB first、行優先
- 10枚の画像 (img0〜img9): おみくじの結果
- Flash上に `data` 宣言で配置

## TinyC移植の設計

### 制約と対応方針

| 元コードの機能 | TinyC での対応 |
|---|---|
| 構造体 (RCC->, ADC1->) | peek/poke で直接アドレスアクセス |
| 配列 (ssd1306_buffer[]) | SRAM を peek8/poke8 で直接操作 |
| 画像データ (const配列) | `data` 宣言でFlashに配置 |
| ポインタ配列 (images[]) | 使わない。if文で画像アドレスを選択 |
| uint16_t, uint8_t | uint32_t のみ。マスク演算で対処 |
| memset | peek8/poke8 のループで実装 |

### メモリレイアウト

```
SRAM (0x20000000 - 0x200007FF, 2KB):
  0x20000000 - 0x200003FF: SSD1306 フレームバッファ (1024バイト)
  0x20000400 - 0x200007FF: グローバル変数 + スタック
```

フレームバッファをグローバル変数として確保するとSRAM上の配置が自動的に行われるが、1024バイト分の個別変数は非現実的。代わりに、SRAM のアドレスを直接 peek8/poke8 で操作する。グローバル変数は 0x20000400 以降に配置されるよう、256個のダミー `var` (各4バイト) で予約するか、または asmgen のRAM_BASEオフセットを調整する。

**採用方針**: フレームバッファ用にSRAMの先頭1024バイトを直接アドレス指定で使い、グローバル変数はその後に配置される想定。ただし現状のasmgenはRAM 0x20000000からグローバル変数を配置するため、フレームバッファとの衝突を避けるため:
- `var` を使わず、グローバル変数もSRAM上の固定アドレスに peek/poke で直接アクセスする
- または `var` を256個宣言してフレームバッファ領域を「予約」する

→ シンプルにフレームバッファはアドレス直指定(0x20000000)、必要なグローバル変数は `var` で宣言し、衝突しないことを前提とする。画像枚数が少なければグローバル変数は少数なので問題ない。

### 関数構成

```
SystemInit()           - クロック設定 (48MHz PLL)
funGpioInitAll()       - GPIO有効化
funPinMode(pin, mode)  - ピンモード設定
adc_init()             - ADC初期化 (PA2, チャネル2)
adc_get()              - ADC変換実行・結果取得
rng()                  - ADCノイズから16bit乱数生成
i2c_setup()            - I2C1初期化 (400kHz fast mode)
i2c_start()            - I2C START条件送信
i2c_send_addr(addr)    - I2Cアドレス送信
i2c_send_byte(byte)    - I2C 1バイト送信
i2c_stop()             - I2C STOP条件送信
ssd1306_cmd(cmd)       - OLEDコマンド送信
ssd1306_setbuf(color)  - フレームバッファクリア
ssd1306_init()         - OLED初期化
ssd1306_refresh()      - フレームバッファをOLEDに転送
ssd1306_drawPixel(x, y, color) - ピクセル描画
draw(img_addr)         - XBM画像をフレームバッファに描画
select_image(index)    - インデックスから画像アドレスを返す
main()                 - メイン処理
```

### 画像データの扱い

10枚の XBM ファイル (各1024バイト) を TinyC の `data` 宣言で埋め込む:

```
data IMG0 = { 0xFF, 0xFF, ... }; // 大吉
data IMG1 = { ... };             // 中吉
...
data IMG9 = { ... };             // 凶
```

ポインタ配列の代わりに `select_image(index)` 関数で if 文による分岐:

```
func select_image(i) {
    if (i == 0) return IMG0;
    if (i == 1) return IMG1;
    ...
}
```

### Flash容量の見積もり

- 画像データ: 1024 * 10 = 10,240 バイト
- コード: 約 2,000 バイト (推定)
- SSD1306初期化データ: 26 バイト
- 合計: 約 12,300 バイト (Flash 16KB に収まる)

### I2C通信の実装

peek/poke で I2C レジスタを直接操作。タイムアウトは固定回数ループ:

```
func i2c_wait_flag(addr, mask) {
    var timeout = 100000;
    loop {
        if (peek(addr) & mask) return 1;
        timeout = timeout - 1;
        if (timeout == 0) return 0;
    }
}
```
