
/**
 * RV32EC Assembly Generator for TinyC
 * Consumes the Stack Machine IR produced by StackGenerator.
 *
 * Frame layout (s0 = old sp = argN-1 position):
 *   s0 + (nargs-1-i)*4 : param id=i  (positive offsets, from caller stack)
 *   s0 - 4             : saved ra
 *   s0 - 8             : saved s0
 *   s0 - 12 - k*4      : non-param local id=(nargs+k)  (negative offsets)
 *
 * Temp computation stack grows below sp (which starts at s0 - 8 - M*4
 * after prologue, M = nvars - nargs).
 *
 * Calling convention:
 *   Caller pushes args in order (arg0 first, argN-1 last = at sp).
 *   Callee epilogue restores sp to argN-1 position, returns value in t0.
 *   Caller adjusts sp and stores t0 as return value on stack.
 */

class AssemblerGenerator {
  generate(ir) {
    this._labelCounter = 0;
    const initAsm = [];
    const dataAsm = [];
    const codeAsm = [];

    // グローバル変数を事前収集してRAMアドレスを割り当てる
    // RAM: 0x20000000 〜 (グローバル変数領域)
    // スタック: 0x20000800 から下方向に成長
    const RAM_BASE = 0x20000000;
    const globalVars = {}; // name -> { initValue, ramAddr }
    let ramOffset = 0;
    for (const item of ir) {
      if (item.type === 'VAR') {
        globalVars[item.name] = {
          initValue: item.value,
          ramAddr: RAM_BASE + ramOffset,
        };
        ramOffset += 4;
      }
    }
    this._globalVars = globalVars;

    // Bootstrap / Interrupt Vector Table
    initAsm.push('# ============================================================');
    initAsm.push('# Bootstrap: Interrupt Vector Table + Reset Handler');
    initAsm.push('# ============================================================');
    initAsm.push('.section .init');
    initAsm.push('.globl _start');
    initAsm.push('_start:                        # 割り込みベクタテーブル先頭');
    initAsm.push('    j reset_handler            # ベクタ0: リセット → reset_handler へジャンプ');
    for (let i = 1; i < 32; i++) initAsm.push(`    .word 0                    # ベクタ${i}: 未使用`);
    initAsm.push('reset_handler:                 # リセットハンドラ');
    initAsm.push('    lui sp, 0x20001            # sp 上位 = 0x20001000');
    initAsm.push('    addi sp, sp, -2048         # sp = 0x20000800 (SRAM末尾 = スタック初期値)');
    initAsm.push('    li t0, 0x1880');
    initAsm.push('    csrw mstatus, t0           # MPIE=1, MPP=M-mode (割り込みモード設定)');
    initAsm.push('    li t0, 3');
    initAsm.push('    csrw mtvec, t0             # 割り込みベクタ = 0x0 (vectoredモード)');

    // グローバル変数の初期化: フラッシュの初期値をRAMにコピー
    for (const [name, info] of Object.entries(globalVars)) {
      const ramHex = `0x${info.ramAddr.toString(16)}`;
      initAsm.push(`# グローバル変数 ${name} の初期化 → RAM ${ramHex}`);
      if (info.initValue !== 0) {
        initAsm.push(`    la t0, var_${name}_init    # フラッシュの初期値アドレス`);
        initAsm.push(`    lw t0, 0(t0)               # 初期値を読み込む`);
      } else {
        initAsm.push(`    li t0, 0                   # 初期値 = 0`);
      }
      initAsm.push(`    li t1, ${ramHex}             # RAMアドレス`);
      initAsm.push(`    sw t0, 0(t1)               # RAMに書き込む`);
    }

    initAsm.push('    jal ra, main               # main() を呼び出す');
    initAsm.push('loop_forever:                  # main() から戻ってきた場合は無限ループ');
    initAsm.push('    j loop_forever');

    dataAsm.push('# ============================================================');
    dataAsm.push('# Global Variable Initial Values (Flash ROM)');
    dataAsm.push('# ============================================================');
    dataAsm.push('.section .data');

    codeAsm.push('# ============================================================');
    codeAsm.push('# Functions');
    codeAsm.push('# ============================================================');
    codeAsm.push('.section .text');

    for (const item of ir) {
      switch (item.type) {
        case 'COMMENT':
          // top-level IR comments shown as-is
          codeAsm.push(`# ${item.text}`);
          break;
        case 'VAR':
          dataAsm.push(`# ${JSON.stringify(item)}`);
          if (item.value !== 0) {
            // 非ゼロの初期値のみフラッシュに保存 (ゼロはreset_handlerでli t0,0で対処)
            dataAsm.push(`var_${item.name}_init: .word ${item.value}`);
          }
          break;
        case 'DATA':
          dataAsm.push(`# data ${item.name} (${item.values.length} bytes)`);
          dataAsm.push(`data_${item.name}:`);
          for (const byte of item.values) {
            dataAsm.push(`  .byte ${byte}`);
          }
          dataAsm.push('  .align 2');
          break;
        case 'FUNC':
          this._genFunc(item, codeAsm);
          break;
        default:
          throw new Error(`Unknown IR item type: ${item.type}`);
      }
    }

    return initAsm.concat(dataAsm).concat(codeAsm).join('\n');
  }

  _genFunc(func, out) {
    const { name, nargs, nvars, ops } = func;
    const M = nvars - nargs; // number of non-param local slots
    const frameSize = 8 + M * 4; // ra(4) + s0(4) + M locals

    out.push('');
    out.push(`# ${JSON.stringify({ type: 'FUNC', name, nargs, nvars })}`);
    out.push(`${name}:`);

    // Prologue
    out.push(`# [prologue] frameSize=${frameSize}: ra(4) + s0(4) + ${M}ローカル変数スロット(${M}*4)`);
    out.push(`    addi sp, sp, -${frameSize}    # フレーム確保`);
    out.push(`    sw ra, ${frameSize - 4}(sp)              # ra を保存`);
    out.push(`    sw s0, ${frameSize - 8}(sp)              # s0 を保存`);
    out.push(`    addi s0, sp, ${frameSize}     # s0 = フレームベース (旧sp = 引数N-1の位置)`);
    if (nargs > 0) {
      out.push(`# [prologue] 引数スロット: ${Array.from({length: nargs}, (_, i) => `id=${i} → ${this._localOffset(i, nargs)}(s0)`).join(', ')}`);
    }
    if (M > 0) {
      out.push(`# [prologue] ローカル変数スロット: ${Array.from({length: M}, (_, k) => `id=${nargs + k} → ${this._localOffset(nargs + k, nargs)}(s0)`).join(', ')}`);
    }

    for (const op of this._peephole(ops)) {
      this._genOp(op, name, nargs, out);
    }

    // Epilogue
    out.push(`# [epilogue]`);
    out.push(`_${name}_end:`);
    out.push('    lw ra, -4(s0)              # ra を復元');
    out.push('    mv t1, s0                  # 旧s0を退避 (この後s0を上書きするため)');
    out.push('    lw s0, -8(t1)              # s0 を復元');
    out.push('    mv sp, t1                  # sp を復元 (引数N-1の位置に戻す)');
    out.push('    ret                        # 呼び出し元へ戻る (戻り値はt0)');
  }

  _localOffset(id, nargs) {
    if (id < nargs) {
      return (nargs - 1 - id) * 4;    // param: positive offset from s0
    }
    return -(12 + (id - nargs) * 4);  // local: negative offset from s0
  }

  _genOp(op, funcName, nargs, out) {
    // COMMENTはCソースコード、それ以外はスタックマシン命令をコメント出力
    if (op.op !== 'COMMENT') {
      out.push(`# ${JSON.stringify(op)}`);
    }

    switch (op.op) {
      case 'COMMENT':
        out.push(`# ${op.text}`);
        break;

      case 'CONST':
        out.push(`    li t0, ${op.val}`);
        out.push('    addi sp, sp, -4');
        out.push('    sw t0, 0(sp)');
        break;

      case 'DATA_ADDR':
        out.push(`    la t0, data_${op.name}`);
        out.push('    addi sp, sp, -4');
        out.push('    sw t0, 0(sp)');
        break;

      case 'LOAD': {
        const off = this._localOffset(op.id, nargs);
        out.push(`    lw t0, ${off}(s0)`);
        out.push('    addi sp, sp, -4');
        out.push('    sw t0, 0(sp)');
        break;
      }

      case 'SAVE': {
        const off = this._localOffset(op.id, nargs);
        out.push('    lw t0, 0(sp)');
        out.push('    addi sp, sp, 4');
        out.push(`    sw t0, ${off}(s0)`);
        break;
      }

      case 'GET': {
        const getAddr = `0x${this._globalVars[op.name].ramAddr.toString(16)}`;
        out.push(`    li t1, ${getAddr}           # var_${op.name} のRAMアドレス`);
        out.push('    lw t0, 0(t1)');
        out.push('    addi sp, sp, -4');
        out.push('    sw t0, 0(sp)');
        break;
      }

      case 'PUT': {
        const putAddr = `0x${this._globalVars[op.name].ramAddr.toString(16)}`;
        out.push('    lw t0, 0(sp)');
        out.push('    addi sp, sp, 4');
        out.push(`    li t1, ${putAddr}           # var_${op.name} のRAMアドレス`);
        out.push('    sw t0, 0(t1)');
        break;
      }

      case 'POP':
        out.push('    addi sp, sp, 4');
        break;

      case 'ADD':    this._binaryOp(out, 'add');  break;
      case 'SUB':    this._binaryOp(out, 'sub');  break;
      case 'MUL':    this._softMulInline(out, `__smul${this._labelCounter++}`); break;
      case 'DIV':    this._softDivInline(out, `__sdiv${this._labelCounter++}`); break;
      case 'CONST_MUL':
        out.push('    lw t0, 0(sp)');
        this._constMul(out, op.val);
        out.push('    sw t0, 0(sp)');
        break;
      case 'SHR_IMM':
        out.push('    lw t0, 0(sp)');
        out.push(`    li t1, ${op.shift}`);
        out.push('    srl t0, t0, t1');
        out.push('    sw t0, 0(sp)');
        break;
      case 'MOD':    this._binaryOp(out, 'remu'); break;
      case 'AND':    this._binaryOp(out, 'and');  break;
      case 'OR':     this._binaryOp(out, 'or');   break;
      case 'XOR':    this._binaryOp(out, 'xor');  break;
      case 'LSHIFT': this._binaryOp(out, 'sll');  break;
      case 'RSHIFT': this._binaryOp(out, 'srl');  break;

      case 'EQ': this._compareOp(out, 'sub',  'seqz'); break;
      case 'NE': this._compareOp(out, 'sub',  'snez'); break;
      case 'LT': this._compareOp(out, 'sltu', null);   break;
      case 'GT':
        out.push('    lw t1, 0(sp)');
        out.push('    lw t0, 4(sp)');
        out.push('    sltu t0, t1, t0');
        out.push('    addi sp, sp, 4');
        out.push('    sw t0, 0(sp)');
        break;
      case 'LE':
        out.push('    lw t1, 0(sp)');
        out.push('    lw t0, 4(sp)');
        out.push('    sltu t0, t1, t0');
        out.push('    xori t0, t0, 1');
        out.push('    addi sp, sp, 4');
        out.push('    sw t0, 0(sp)');
        break;
      case 'GE':
        out.push('    lw t1, 0(sp)');
        out.push('    lw t0, 4(sp)');
        out.push('    sltu t0, t0, t1');
        out.push('    xori t0, t0, 1');
        out.push('    addi sp, sp, 4');
        out.push('    sw t0, 0(sp)');
        break;

      case 'NOT':
        out.push('    lw t0, 0(sp)');
        out.push('    not t0, t0');
        out.push('    sw t0, 0(sp)');
        break;
      case 'LNOT':
        out.push('    lw t0, 0(sp)');
        out.push('    seqz t0, t0');
        out.push('    sw t0, 0(sp)');
        break;
      case 'NEG':
        out.push('    lw t0, 0(sp)');
        out.push('    neg t0, t0');
        out.push('    sw t0, 0(sp)');
        break;
      case 'NOP':
        break;

      case 'LAND':
        out.push('    lw t1, 0(sp)');
        out.push('    lw t0, 4(sp)');
        out.push('    snez t0, t0');
        out.push('    snez t1, t1');
        out.push('    and t0, t0, t1');
        out.push('    addi sp, sp, 4');
        out.push('    sw t0, 0(sp)');
        break;
      case 'LOR':
        out.push('    lw t1, 0(sp)');
        out.push('    lw t0, 4(sp)');
        out.push('    or t0, t0, t1');
        out.push('    snez t0, t0');
        out.push('    addi sp, sp, 4');
        out.push('    sw t0, 0(sp)');
        break;

      case 'GOTO':
        out.push(`    j label_${op.name}`);
        break;

      case 'IF_GOTO':
        out.push('    lw t0, 0(sp)');
        out.push('    addi sp, sp, 4');
        out.push(`    bnez t0, label_${op.name}`);
        break;

      case 'LABEL':
        out.push(`label_${op.name}:`);
        break;

      case 'CALL': {
        out.push(`    jal ra, ${op.name}`);
        if (op.nargs === 0) {
          out.push('    addi sp, sp, -4');
        } else if (op.nargs > 1) {
          out.push(`    addi sp, sp, ${(op.nargs - 1) * 4}`);
        }
        out.push('    sw t0, 0(sp)');
        break;
      }

      case 'RETURN':
        out.push('    lw t0, 0(sp)');
        out.push(`    j _${funcName}_end`);
        break;

      case 'PEEK':
        out.push('    lw t0, 0(sp)');
        out.push('    lw t0, 0(t0)');
        out.push('    sw t0, 0(sp)');
        break;
      case 'POKE':
        out.push('    lw t1, 0(sp)');
        out.push('    lw t0, 4(sp)');
        out.push('    sw t1, 0(t0)');
        out.push('    addi sp, sp, 8');
        break;
      case 'PEEK16':
        out.push('    lw t0, 0(sp)');
        out.push('    lhu t0, 0(t0)');
        out.push('    sw t0, 0(sp)');
        break;
      case 'POKE16':
        out.push('    lw t1, 0(sp)');
        out.push('    lw t0, 4(sp)');
        out.push('    sh t1, 0(t0)');
        out.push('    addi sp, sp, 8');
        break;
      case 'PEEK8':
        out.push('    lw t0, 0(sp)');
        out.push('    lbu t0, 0(t0)');
        out.push('    sw t0, 0(sp)');
        break;
      case 'POKE8':
        out.push('    lw t1, 0(sp)');
        out.push('    lw t0, 4(sp)');
        out.push('    sb t1, 0(t0)');
        out.push('    addi sp, sp, 8');
        break;

      default:
        throw new Error(`Unknown op: ${op.op}`);
    }
  }

  // CONST + MUL → CONST_MUL (シフト+加算で展開)
  // CONST(2の累乗) + DIV → SHR_IMM (シフト右)
  _peephole(ops) {
    const result = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.op === 'CONST') {
        let j = i + 1;
        while (j < ops.length && ops[j].op === 'COMMENT') j++;
        const next = ops[j];
        if (next && next.op === 'MUL') {
          for (let k = i + 1; k < j; k++) result.push(ops[k]);
          result.push({ op: 'CONST_MUL', val: op.val });
          i = j;
          continue;
        }
        if (next && next.op === 'DIV' && op.val > 0 && (op.val & (op.val - 1)) === 0) {
          for (let k = i + 1; k < j; k++) result.push(ops[k]);
          result.push({ op: 'SHR_IMM', shift: Math.log2(op.val) | 0 });
          i = j;
          continue;
        }
      }
      result.push(op);
    }
    return result;
  }

  // 非定数乗算: t0 * t1 → t0  シフト+加算ループ (O(32)反復)
  // 使用レジスタ: t2(積累計), a0(定数1), a1(LSBテスト用)
  _softMulInline(out, lbl) {
    out.push('    lw t1, 0(sp)');      // t1 = 右辺 (乗数)
    out.push('    lw t0, 4(sp)');      // t0 = 左辺 (被乗数)
    out.push('    addi sp, sp, 4');
    out.push('    li a0, 1');          // a0 = 1 (シフト量・マスク定数)
    out.push('    mv t2, zero');       // t2 = 積 = 0
    out.push(`${lbl}:`);
    out.push(`    beq t1, zero, ${lbl}_e`);
    out.push('    and a1, t1, a0');    // a1 = t1 & 1 (LSB)
    out.push(`    beq a1, zero, ${lbl}_s`);
    out.push('    add t2, t2, t0');    // 積 += 被乗数
    out.push(`${lbl}_s:`);
    out.push('    sll t0, t0, a0');    // 被乗数 <<= 1
    out.push('    srl t1, t1, a0');    // 乗数 >>= 1
    out.push(`    j ${lbl}`);
    out.push(`${lbl}_e:`);
    out.push('    sw t2, 0(sp)');
  }

  // 非定数除算(符号なし): t0 / t1 → t0  バイナリ長除算 (O(32)反復)
  // 使用レジスタ: t2(商), a0(余り), a1(ビットカウンタ), a2(テンポラリ), a3(定数1)
  _softDivInline(out, lbl) {
    out.push('    lw t1, 0(sp)');      // t1 = 除数
    out.push('    lw t0, 4(sp)');      // t0 = 被除数
    out.push('    addi sp, sp, 4');
    out.push('    mv t2, zero');       // 商 = 0
    out.push('    mv a0, zero');       // 余り = 0
    out.push('    li a1, 31');         // ビットカウンタ (31→0)
    out.push('    li a3, 1');          // 定数 1
    out.push(`    beq t1, zero, ${lbl}_e`);  // ÷0 → 商 = 0
    out.push(`${lbl}:`);
    // 余り = (余り << 1) | ((被除数 >> bit) & 1)
    out.push('    sll a0, a0, a3');    // 余り <<= 1
    out.push('    srl a2, t0, a1');    // a2 = 被除数 >> bit
    out.push('    and a2, a2, a3');    // a2 &= 1
    out.push('    or a0, a0, a2');     // 余り |= a2
    // if 余り >= 除数: 余り -= 除数, 商 |= (1 << bit)
    out.push('    sltu a2, a0, t1');   // a2 = (余り < 除数)
    out.push(`    bnez a2, ${lbl}_s`);
    out.push('    sub a0, a0, t1');    // 余り -= 除数
    out.push('    sll a2, a3, a1');    // a2 = 1 << bit
    out.push('    or t2, t2, a2');     // 商 |= a2
    out.push(`${lbl}_s:`);
    out.push(`    beq a1, zero, ${lbl}_e`);  // bit=0 まで処理したら終了
    out.push('    addi a1, a1, -1');   // bit--
    out.push(`    j ${lbl}`);
    out.push(`${lbl}_e:`);
    out.push('    sw t2, 0(sp)');
  }

  // 定数 val を t0 にかける (t0 = t0 * val) — シフト+加算で展開
  // t2 を一時レジスタとして使用
  _constMul(out, val) {
    val = val >>> 0; // 符号なし32ビットとして扱う
    if (val === 0) { out.push('    li t0, 0'); return; }
    if (val === 1) return;
    const bits = [];
    for (let b = 0; b < 32; b++) {
      if ((val >>> b) & 1) bits.push(b);
    }
    if (bits.length === 1) {
      // 2の累乗: シフトのみ
      out.push(`    li t1, ${bits[0]}`);
      out.push('    sll t0, t0, t1');
      return;
    }
    // 複数ビット: t2 に元の値を退避してシフト+加算で展開
    out.push('    mv t2, t0');
    out.push(`    li t1, ${bits[0]}`);
    out.push('    sll t0, t2, t1');
    for (let i = 1; i < bits.length; i++) {
      out.push(`    li t1, ${bits[i]}`);
      out.push('    sll t1, t2, t1');
      out.push('    add t0, t0, t1');
    }
  }

  _binaryOp(out, op) {
    out.push('    lw t1, 0(sp)');
    out.push('    lw t0, 4(sp)');
    out.push(`    ${op} t0, t0, t1`);
    out.push('    addi sp, sp, 4');
    out.push('    sw t0, 0(sp)');
  }

  _compareOp(out, op, finalOp) {
    out.push('    lw t1, 0(sp)');
    out.push('    lw t0, 4(sp)');
    out.push(`    ${op} t0, t0, t1`);
    if (finalOp) out.push(`    ${finalOp} t0, t0`);
    out.push('    addi sp, sp, 4');
    out.push('    sw t0, 0(sp)');
  }
}

if (typeof module !== 'undefined') {
  module.exports = { AssemblerGenerator };
}
