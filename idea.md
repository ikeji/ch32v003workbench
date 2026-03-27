- RISC-Vチップである、CH32V003用の開発環境を作りたい。
- まずは、TinyCコンパイラを作りたい。
- 言語仕様
  - 変数の型はuint32_tのみ。
  - const(定数), var(変数), func(関数)があります。
  - 組み込み関数peek(32bit読み込み),poke(32bit書き込み),peek16(16bit),poke16,peek8(8bit),poke8があります。
  - Cのような演算子が一通りあります。
  - 10進数、16進数、8進数、2進数リテラルがあります。
  - 制御構文は、if,else,returnがあり、無限ループ構文loopとbreak,continue文があります。
- 次のコードがサンプルです。
```
const PIN_LED = PC0;

func main()
{
	SystemInit();

	funGpioInitAll(); // Enable GPIOs
	
	funPinMode( PIN_LED, GPIO_Speed_10MHz | GPIO_CNF_OUT_PP );

	loop
	{
		funDigitalWrite( PIN_LED, FUN_HIGH );
		Delay_Ms( 250 );
		funDigitalWrite( PIN_LED, FUN_LOW );
		Delay_Ms( 250 );
	}
}

const PC0 = 32;
const GPIO_Speed_10MHz = 1;
const GPIO_CNF_OUT_PP = 0;
const FUN_LOW = 0;
const FUN_HIGH = 1;

func SystemInit() {
	const FLASH_ACTLR = 0x40022000;
	const RCC_CTLR    = 0x40021000;
	const RCC_CFGR0   = 0x40021004;
	const STK_CTLR    = 0xE000F000;

	const RCC_PLLON   = 0b01000000000000000000000000; // bit 24
	const RCC_PLLRDY  = 0b10000000000000000000000000; // bit 25
	const RCC_SW_PLL  = 0b00000000000000000000000010; // bit 1
	const RCC_SWS_PLL = 0b00000000000000000000001000; // bit 3 (SWS bits are 3:2)

	// FLASH_ACTLR = 1 (Latency 1 for 48MHz)
	poke(FLASH_ACTLR, 1);
	
	// RCC_CTLR |= RCC_PLLON
	poke(RCC_CTLR, peek(RCC_CTLR) | RCC_PLLON);
	
	// Wait for RCC_PLLRDY
	loop {
		if (peek(RCC_CTLR) & RCC_PLLRDY) break;
	}
	
	// RCC_CFGR0 |= RCC_SW_PLL
	poke(RCC_CFGR0, peek(RCC_CFGR0) | RCC_SW_PLL);
	
	// Wait for RCC_SWS_PLL (System Clock Switch Status)
	loop {
		if ((peek(RCC_CFGR0) & 0b1100) == RCC_SWS_PLL) break;
	}
	
	// STK_CTLR = 1 (Enable SysTick, HCLK/8)
	poke(STK_CTLR, 1);
}

func funGpioInitAll() {
	const RCC_APB2PCENR = 0x40021018;
	const RCC_AFIOEN    = 0b000001; // bit 0
	const RCC_IOPAEN    = 0b000100; // bit 2
	const RCC_IOPCEN    = 0b010000; // bit 4
	const RCC_IOPDEN    = 0b100000; // bit 5

	// Enable AFIO, GPIOA, GPIOC, GPIOD
	poke(RCC_APB2PCENR, peek(RCC_APB2PCENR) | RCC_AFIOEN | RCC_IOPAEN | RCC_IOPCEN | RCC_IOPDEN);
}

func funPinMode(pin, mode) {
	const GPIO_BASE_START = 0x40010800;
	var gpio_base = GPIO_BASE_START + (pin / 16) * 1024;
	var pin_num = pin & 7;
	var shift = pin_num * 4;

	poke(gpio_base, (peek(gpio_base) & (~(0b1111 << shift))) | ((mode & 0b1111) << shift));
}

func funDigitalWrite(pin, mode) {
	const GPIO_BASE_START = 0x40010800;
	const GPIO_BSHR_OFFSET = 16;
	var gpio_base = GPIO_BASE_START + (pin / 16) * 1024;
	var pin_num = pin & 15;

	if (mode) {
		poke(gpio_base + GPIO_BSHR_OFFSET, 1 << pin_num); // BSHR set
	} else {
		poke(gpio_base + GPIO_BSHR_OFFSET, 1 << (pin_num + 16)); // BSHR reset
	}
}

func Delay_Ms(ms) {
	const STK_CNT = 0xE000F008;
	const TICKS_PER_MS = 6000; // 48MHz / 8 / 1000

	var end_time = peek(STK_CNT) + ms * TICKS_PER_MS;
	loop {
		// Handle wrapping by comparing distance as signed 32-bit (threshold is 2^31)
		if ((peek(STK_CNT) - end_time) < 0b10000000000000000000000000000000) break;
	}
}
```
- 環境はいくつかのモジュールからなります。
- 各モジュールはJavaScriptで記述され、ブラウザでも動くし、nodeコマンドで動かすためのラッパ、ユニットテストが用意されている。
  - パーサー
    - 文字列を受け取り、ASTを示すJSONを返す。
    - コアモジュールのAPIは1関数。
    - ラッパは標準入力を読み、出力をpretty printし、標準出力に出す。
    - 出力例:
```json
{
  "type": "Program",
  "body": [
    {
      "type": "FunctionDeclaration",
      "src" : "func add(a,b)",
      "name": "add",
      "params": ["a", "b"],
      "body": [
        {
          "type": "ReturnStatement",
          "src":"return a + b;",
          "value": {
            "type": "BinaryExpression",
            "operator": "+",
            "left": { "type": "Identifier", "name": "a" },
            "right": { "type": "Identifier", "name": "b" }
          }
        }
      ]
    }
  ]
}
```

  - スタックマシンコード生成
    - ASTを受け取り、スタックマシンベースのコードを生成する。
    - 入力も出力もJSON形式。
    - ラッパは標準入力を読みJSONにパース、出力をpretty printし標準出力に出す。
    - トップレベル定義
      - `VAR <name> <value>`: グローバル変数定義
      - `FUNC <name> <narg> <nvar> <ops>`: 関数定義。名前、引数の数、関数内(自動)変数の数(引数を含む)
      - `COMMENT <text>`: コメント。元ソースなどを入れる。挙動には影響しない。
    - 指令セット定義:
      - `COMMENT <text>`: コメント。元ソースなどを入れる。挙動には影響しない。
      - `CONST <val>`: 定数をスタックに積む
      - `POP`: スタックトップを捨てる
      - `GET <name>`: グローバル変数の値をスタックに積む
      - `PUT <name>`: スタックから値を出しグローバル変数に格納する
      - `LOAD <id>`: ローカル変数の値をスタックに積む（IDは関数内連番）
      - `SAVE <id>`: スタックから値を出しローカル変数に格納する
      - `ADD`, `SUB`, `MUL`, `DIV`, `MOD`: 算術演算
      - `AND`, `OR`, `XOR`, `NOT`: ビット演算
      - `LSHIFT`, `RSHIFT`: 論理シフト
      - `EQ`, `NE`, `LT`, `LE`, `GT`, `GE`: 比較演算（すべて符号なし）
      - `IF_GOTO <label>`: スタックトップが真ならジャンプ
      - `GOTO <label>`: 無条件ジャンプ
      - `LABEL <label>`: ジャンプ先ラベル
      - `CALL <name> <nargs>`: 関数呼び出し（引数はすべてスタック渡し）
      - `RETURN`: 関数から戻る(スタックトップを返す)
      - `PEEK`: 32bitメモリ読み込み(addr -> value)
      - `POKE`: 32bitメモリ書き込み(addr, value -> )
      - `PEEK16`: 16bitメモリ読み込み(addr -> value)
      - `POKE16`: 16bitメモリ書き込み(addr, value -> )
      - `PEEK8`: 8bitメモリ読み込み(addr -> value)
      - `POKE8`: 8bitメモリ書き込み(addr, value -> )
    - コメント
      - 三項演算子は`IF_GOTO`で実装。
      - 引数は前から順に積む。
    - 出力例:
```json
[
  { "type": "COMMENT": "text" : "var global = 123"},
  { "type": "VAR", "name": "global", "value": 123},
  { "type": "COMMENT": "text" : "func add(a,b)"},
  { "type": "FUNC", "name": "add", "nargs": 2, "nvars": 2, "ops": [
    { "op": "COMMENT", "text": "return a + b;"},
    { "op": "LOAD", "id": "0" },
    { "op": "LOAD", "id": "1" },
    { "op": "ADD" },
    { "op": "RETURN" }
  ]},
  { "type": "COMMENT": "text" : "func main()"},
  { "type": "FUNC", "name": "add", "nargs": 0, "nvars": 1, "ops": [
    { "op": "COMMENT", "text": "var c = add(1,2);"},
    { "op": "CONST", "val": "1" },
    { "op": "CONST", "val": "2" },
    { "op": "CALL", "name": "add", "nargs":2 },
    { "op": "SAVE", "id": 0},
    { "op": "COMMENT", "text": "poke(123,c);"},
    { "op": "CONST", "val": "123" },
    { "op": "LOAD", "id":0 },
    { "op": "RETURN" }
  ]}
]
```

  - RV32ECアセンブラ生成
    - スタックマシンのコードJSONを受け取り、アセンブラコードをテキストで出力する。
    - 呼び出し規約: 簡便のため、引数は常にスタックを経由して受け渡しを行う。
    - 組み込み関数: `peek`/`poke`等はスタックマシンの専用命令として扱われ、アセンブラレベルで効率的なインラインコードに展開される。
    - ブートストラップ: 割り込みベクトルテーブル、スタックポインタ(sp)の初期化、グローバル変数の初期化、`main`の呼び出しを含むコードを常に自動生成する。
    - 出力例:
```asm
#  { "type": "COMMENT": "text" : "func add(a,b)"},
#  { "type": "FUNC", "name": "add", "nargs": 2, "nvars": 2, "ops": [
add:
#    { "op": "COMMENT", "text": "return a + b;"},
#    { "op": "LOAD", "id": "0" },
    lw t1, 4(sp)
#    { "op": "LOAD", "id": "1" },
    lw t0, 0(sp)
#    { "op": "ADD" },
    add t0, t0, t1
#    { "op": "RETURN" }
    sw t0, 8(sp) # 戻り値をスタックに置く
    ret
#  ]},
```

  - アセンブル
    - アセンブラテキストを受け取り、実際のアセンブラを行う。
    - 出力は、バイナリを0番地からhexdumpしたもの。
  - ディスアセンブル
    - hexdumpされたバイナリを逆アセンブルする、objdumpコマンドの出力と同じフォーマット。
  - 仮想マシン
    - ディスアセンブルしたものを読み込み、実行する。
    - タイマ、GPIOのハードウエアを実装する。
    - メモリマップ:
      - `0x00000000 - 0x00003FFF`: Flash (16KB) - プログラムコードおよび定数
      - `0x20000000 - 0x200007FF`: SRAM (2KB) - グローバル変数およびスタック
      - `0x40000000 - 0x40023FFF`: 周辺機能 (GPIO, RCC, etc.)
      - スタックは SRAM の末尾 (`0x20000800`) から下向きに成長する。
    - コアモジュールはクラスとして実装する。
      - var vm = new VM(disassembled_code, timer_callback, gpio_callback, log_callback);
      - vm.step();
    - ラッパは次のように実装する。
      - コードは標準入力から読む。
      - タイマはクロックではなく実時間を使う。
      - gpioは入力として使われた場合は変化せず、出力の変化はconsoleに出す。
      - ログ出力は、consoleに出す。
    - 出力例:
```
PC: 0x00000000
Instruction: li a0, 32
Detail: x10 (a0) に 32 (0x20) を格納しました。

PC: 0x00000002
Instruction: jal ra, 0x00000040
Detail: ra (x1) に 0x00000004 を格納し、0x00000040 (funPinMode) へジャンプします。

GPIO: Port C Pin 0 を出力 (10MHz, Push-Pull) に設定しました。
GPIO: Port C Pin 0 を High にしました。
```

- 全体を実行するコマンド、テストを一括実行する方法を用意して、Makefileにして。

## 解決済みの設計方針
1. **メモリモデル**: CH32V003の仕様に準じたメモリマップを採用。変数はSRAMに配置し、スタックはSRAM末尾から開始。
2. **関数呼び出し規約**: 常にスタック渡し。RV32ECのレジスタ制約を考慮し、簡潔さを優先。
3. **組み込み関数**: `peek`/`poke`系は言語上は関数だが、コンパイラが専用命令として扱い、インライン展開する。
4. **ブートストラップ**: スタートアップコードとグローバル変数初期化を自動生成。
5. **演算子の範囲**: 符号なし比較、ビットシフト、三項演算子をサポート。符号付き比較は非サポート。
6. **中間形式**: JSONベースのスタックマシン命令セットを定義。

## GUIのアイディア

- index.htmlを作る。
- たぶんreact.jsとか使うといいと思う。
- 全体
  - 画面上部にタブが並ぶ。
  - タブ内左側に操作パネルがある。
  - タブ内右側にテキストエリアがある。
  - タブの外の画面下部に1行のステータスバーがある。
- ソースタブ
  - テキストエリアはソースコードが編集できる。
  - 操作パネルには次の機能がある。
    - コンパイルする
      - 押すとコンパイルされ、バイナリタブが開かれる。
    - 保存
      - local storageに保存される。
      - 保存時刻をキーに保存される。
    - 保存されたファイル一覧
      - 選ぶとエディタにロードされる。
    - サンプルファイル一覧
      - 選ぶとエディタにロードされる。
- ASTタブ
  - ASTのJSONが入ってる。編集不可。操作パネルは空
- スタックマシンコードタブ
  - ASTのJSONが入ってる。編集不可。操作パネルは空
- RV32ECアセンブラコードタブ
  - テキストでアセンブラが入ってる。編集不可。操作パネルは空
- バイナリコードタブ
  - hexdumpしたコードが入ってる。編集は不可。
  - 操作パネルは次の4つのボタンがある。
    - 実行
      - VMタブに移行する。
    - 書き込み
      - CH32V003に書き込みを行う。
      - 実装には lib/rv003usb_webflasher.js を使う。
    - binファイルダウンロード
    - binファルアップロード
      - アップロードすると、このタブにロードされる。
      - その後、実行/書き込みもできる。
- 逆アセンブルタブ
  - バイナリコードタブの中身を逆アセンブルする。
  - テキストでアセンブラが入ってる。編集不可。操作パネルは空
  - バイナリコードタブの中身が変わると、自動で更新される。
- VMタブ
  - メインテキスト部分はログ表示に使われる。
  - 操作パネル
    - リセット&実行
      - VMの状態をリセットする、逆アセンブルタブの中身をロード
      - タイマを使い非同期でVMを動かす。
    - 停止
      - タイマを停止
    - 実行中かどうかの表示
    - LED表示
      - マイコンがLEDを点滅させると、ここも点滅する。
- ログ
  - コンパイラなどを動かした時に動作状況が表示される。
  - 操作パネルにはクリアボタンがある。
  - ここにログが書き込まれたら、最終行がステータスバーにも表示される。
