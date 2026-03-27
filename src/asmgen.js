
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

    for (const op of ops) {
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
      case 'MUL':    this._binaryOp(out, 'mul');  break;
      case 'DIV':    this._binaryOp(out, 'divu'); break;
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
