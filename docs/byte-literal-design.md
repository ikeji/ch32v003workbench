# バイト列リテラル埋め込み機能 設計ドキュメント

## 動機

CH32V003向けの組み込み開発では、以下のようなバイト列をプログラムに埋め込む必要がある:

- LUTテーブル（LEDの輝度テーブル、CRCテーブル等）
- I2C/SPIデバイスへの初期化コマンド列
- フォントデータやビットマップ
- 固定文字列（UARTで送信するメッセージ等）

現在のTinyC言語には配列や文字列リテラルがなく、このようなデータを扱うには`poke8`で1バイトずつRAMに書き込むか、`const`で個別定義するしかない。これは冗長でSRAM（2KB）を圧迫する。

## 設計方針

バイト列はFlash上の読み取り専用データとして配置し、ポインタ（アドレス）を返す。SRAM（2KB）を消費しない。

## 構文

### データ宣言 (`data`)

新しいトップレベル宣言 `data` を導入する:

```
data TABLE = { 0x00, 0x10, 0x20, 0x30, 0xFF };
```

- `data` は新しいキーワード
- 名前はconstと同様に識別子
- `{ }` の中にカンマ区切りで数値リテラル（0〜255）を列挙
- 各要素は既存の数値リテラル形式（10進、16進、8進、2進）が使える
- セミコロンで終端

### 文字列リテラル

文字列リテラルも同時にサポートする:

```
data HELLO = "Hello, World!\n";
```

- ダブルクォートで囲む
- 基本的なエスケープシーケンス: `\n`, `\r`, `\t`, `\\`, `\"`, `\0`
- `\xHH` による16進バイト指定
- 末尾にNULLターミネータ(`\0`)は**自動付加しない**（明示的に書く）
- 文字列とバイト列は混在不可（シンプルさ優先）

### 式中での使用

`data` 名は式中で使うと、そのデータのFlash上アドレス（`uint32_t`値）に評価される:

```
data MSG = "OK\r\n\0";
data TABLE = { 0, 10, 20, 30 };

func send_message() {
    var i = 0;
    loop {
        var ch = peek8(MSG + i);
        if (ch == 0) break;
        uart_send(ch);
        i = i + 1;
    }
}

func lookup(index) {
    return peek8(TABLE + index);
}
```

### サイズの取得

組み込み演算子 `sizeof()` を追加:

```
data TABLE = { 1, 2, 3, 4, 5 };
const TABLE_LEN = sizeof(TABLE);  // = 5
```

- `sizeof` は `data` 宣言に対してのみ使用可能
- コンパイル時に定数に解決される（ランタイムコストなし）
- `const` の初期化式で使用可能

## 各ステージの変更

### 1. パーサー (`src/parser.js`)

#### トークナイザの変更

- キーワード: `data` を追加
- 文字列リテラル: `"..."` のトークン認識を追加
- `sizeof` キーワードを追加

#### ASTノード

新しいトップレベルノード `DataDeclaration`:

```json
{
  "type": "DataDeclaration",
  "src": "data TABLE = { 0x00, 0x10, 0x20 };",
  "name": "TABLE",
  "dataType": "bytes",
  "values": [0, 16, 32]
}
```

文字列リテラルの場合:

```json
{
  "type": "DataDeclaration",
  "src": "data HELLO = \"Hello\\n\";",
  "name": "HELLO",
  "dataType": "string",
  "values": [72, 101, 108, 108, 111, 10]
}
```

パーサーが文字列をバイト列に展開する（後段はバイト列だけを扱えばよい）。

新しい式ノード `SizeofExpression`:

```json
{
  "type": "SizeofExpression",
  "name": "TABLE"
}
```

### 2. スタックマシンコード生成 (`src/stackgen.js`)

#### 新しいIRノード

トップレベルに `DATA` ノードを追加:

```json
{
  "type": "DATA",
  "name": "TABLE",
  "values": [0, 16, 32]
}
```

#### 式中での参照

`data` 名が式中に出現した場合、`CONST` ではなく新しいオペコード `DATA_ADDR` を生成:

```json
{ "op": "DATA_ADDR", "name": "TABLE" }
```

これは「`TABLE` のFlashアドレスをスタックに積む」という意味。アドレスの具体的な値はasmgen段階で解決される。

#### sizeof の処理

`sizeof(TABLE)` はコンパイル時に解決し、`CONST` として出力:

```json
{ "op": "CONST", "val": 3 }
```

### 3. アセンブラ生成 (`src/asmgen.js`)

#### データセクションの生成

`.data` セクションにバイト列を出力:

```asm
.section .data
# data TABLE (3 bytes)
data_TABLE:
  .byte 0x00
  .byte 0x10
  .byte 0x20
  .align 2
```

`.align 2` で4バイト境界にアラインし、後続のデータやコードのアライメントを保証する。

#### DATA_ADDR オペコードの処理

`DATA_ADDR` は `la` 疑似命令でアドレスをロード:

```asm
# DATA_ADDR TABLE
la t0, data_TABLE
addi sp, sp, -4
sw t0, 0(sp)
```

#### 配置

データはFlash上のコードの後ろに配置される（現状の `.data` セクションと同じ領域）。グローバル変数の初期値（`var_*_init`）と同じ場所。

### 4. アセンブラ (`src/assembler.js`)

#### 新しいディレクティブ

`.byte` ディレクティブを追加:

```
.byte <value>
```

- Pass 1: `ln.size = 1`（1バイト分のアドレス確保）
- Pass 2: 1バイトを出力バッファに書き込む

`.align <n>` ディレクティブを追加:

```
.align 2   # 4バイト(2^2)境界にアライン
```

- Pass 1: 現在のアドレスからアライメントまでのパディングを計算し `ln.size` に設定
- Pass 2: パディングバイト（0x00）を出力

### 5. VM (`src/vm.js`)

変更不要。既にFlashからのバイト単位読み出し（`lbu`命令）をサポートしている。`peek8()` によるFlash読み出しが正しく動作することを確認するテストを追加する。

## メモリレイアウト

```
Flash (0x00000000 - 0x00003FFF, 16KB):
  +------------------+
  | .init            |  割り込みベクトル, SP初期化, global初期化, main呼出
  +------------------+
  | .text            |  関数コード
  +------------------+
  | .data            |  グローバル変数初期値 (var_*_init)
  |                  |  バイト列データ (data_*)     ← 新規
  +------------------+
  | (未使用)          |
  +------------------+

SRAM (0x20000000 - 0x200007FF, 2KB):
  +------------------+
  | グローバル変数     |  var_* (実行時の値)
  +------------------+
  | (空き)            |
  +------------------+
  |     ↓ スタック    |  SP = 0x20000800 から下方向
  +------------------+
```

バイト列データはFlash上に配置されるため、SRAMを消費しない。

## 制約と制限

1. **読み取り専用**: `data` で宣言したデータは実行時に変更できない（Flash上のため）
2. **最大サイズ**: Flash全体16KBからコード分を引いた残りが上限
3. **要素は0〜255**: 各要素は1バイトに収まる値のみ
4. **トップレベルのみ**: `data` 宣言は関数内では使えない（`const`/`var`と同様にトップレベル宣言）
5. **代入不可**: `data` 名への代入はコンパイルエラー

## 使用例

### LED輝度テーブル

```
data GAMMA = {
    0,   0,   0,   0,   0,   0,   0,   0,
    0,   0,   0,   0,   1,   1,   1,   1,
    2,   2,   2,   3,   3,   4,   4,   5,
    5,   6,   7,   8,   9,  10,  11,  12,
   13,  15,  16,  18,  20,  22,  24,  26,
   28,  31,  34,  37,  40,  43,  47,  51,
   55,  59,  64,  69,  74,  80,  86,  92,
   99, 106, 114, 122, 131, 140, 150, 160
};

func set_pwm(brightness) {
    var gamma_val = peek8(GAMMA + brightness);
    poke(TIM1_CCR1, gamma_val);
}
```

### UART文字列送信

```
data BANNER = "CH32V003 Ready\r\n\0";

func uart_puts(addr) {
    var i = 0;
    loop {
        var ch = peek8(addr + i);
        if (ch == 0) break;
        // TX FIFOが空くまで待つ
        loop {
            if (peek(USART_STATR) & USART_TXE) break;
        }
        poke(USART_DATAR, ch);
        i = i + 1;
    }
}

func main() {
    uart_init();
    uart_puts(BANNER);
}
```

### I2Cコマンド列

```
data OLED_INIT = {
    0xAE,       // Display OFF
    0xD5, 0x80, // Set display clock
    0xA8, 0x3F, // Set multiplex ratio
    0xD3, 0x00, // Set display offset
    0x40,       // Set start line
    0x8D, 0x14, // Enable charge pump
    0xA1,       // Segment remap
    0xC8,       // COM scan direction
    0xAF        // Display ON
};
const OLED_INIT_LEN = sizeof(OLED_INIT);

func oled_init() {
    var i = 0;
    loop {
        if (i >= OLED_INIT_LEN) break;
        i2c_write(0x3C, peek8(OLED_INIT + i));
        i = i + 1;
    }
}
```

## 実装順序

1. **アセンブラ**: `.byte` と `.align` ディレクティブを追加（他の変更に依存しない）
2. **パーサー**: `data` 宣言と文字列リテラルのパース、`sizeof` 式のパース
3. **スタックマシンコード生成**: `DATA` IRノードと `DATA_ADDR` オペコード、`sizeof` のコンパイル時解決
4. **アセンブラ生成**: データセクション出力と `DATA_ADDR` のアセンブリ生成
5. **テスト**: パイプライン全体を通したテスト

## 代替案の検討

### 案A: 配列型変数（不採用）

```
var table[5] = { 1, 2, 3, 4, 5 };
```

不採用理由: SRAM上に配置されるため貴重な2KBを消費する。また型システム（`uint32_t`のみ）との整合性が複雑になる。

### 案B: インラインhex文字列（不採用）

```
const TABLE = 0h"001020FF";
```

不採用理由: サイズが偶数バイトに制限される、10進やコメント付きでの記述ができない、可読性が低い。

### 案C: マクロ/プリプロセッサ（不採用）

```
#include "data.bin"
```

不採用理由: プリプロセッサの仕組みが必要になり、パイプラインの複雑性が大幅に増加する。

### 案D: `const` の拡張（不採用）

```
const TABLE = { 1, 2, 3 };
```

不採用理由: 既存の `const` はコンパイル時定数（スカラ値）として扱われており、セマンティクスが大きく変わる。`const`はアドレスを持たない（Flash上のラベルがない）が、`data`はFlash上のアドレスを持つ。混乱を避けるため別キーワードとする。
