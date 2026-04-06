
const test = require('node:test');
const assert = require('node:assert');
const { Assembler } = require('../src/assembler');

test('Assembler should handle simple instructions', () => {
  const assembler = new Assembler();
  const asm = `
    li t0, 10
    addi t1, t0, 5
    add t2, t0, t1
  `;
  const dump = assembler.assemble(asm);
  assert.ok(dump.includes('00000000:'));
  // 3 instructions * 4 bytes = 12 bytes
  assert.strictEqual(assembler.pc, 12);
});

test('Assembler should handle labels and jumps', () => {
  const assembler = new Assembler();
  const asm = `
    start:
      j start
      li a0, 0
  `;
  const dump = assembler.assemble(asm);
  // j start should be a jump to self (offset 0)
  // 0x6f (jal x0, 0)
  assert.ok(dump.includes('6f 00 00 00') || dump.includes('6f 00 00 00')); // Depending on offset calc
});

test('Assembler should handle .word directive', () => {
  const assembler = new Assembler();
  const asm = `
    .word 0x12345678
  `;
  const dump = assembler.assemble(asm);
  assert.ok(dump.includes('78 56 34 12'));
});

test('Assembler should handle lw/sw with offset', () => {
  const assembler = new Assembler();
  const asm = `
    lw t0, 8(sp)
    sw t0, 4(sp)
  `;
  const dump = assembler.assemble(asm);
  assert.strictEqual(assembler.pc, 8);
});

test('Assembler lui should shift immediate by 12', () => {
  // lui sp, 0x20001 → sp = 0x20001000
  // 正しいエンコード: 0x20001137 (バイト列: 37 11 00 20)
  const assembler = new Assembler();
  const dump = assembler.assemble('lui sp, 0x20001');
  assert.ok(dump.includes('37 11 00 20'), `Expected 20001137, got: ${dump}`);
  assert.strictEqual(assembler.pc, 4);
});

test('Assembler should encode mv as addi rd, rs, 0', () => {
  const assembler = new Assembler();
  // mv t1, s0 = addi t1, s0, 0 = 0x00040313 (バイト列: 13 03 04 00)
  const dump = assembler.assemble('mv t1, s0');
  assert.ok(dump.includes('13 03 04 00'), `Expected 00040313, got: ${dump}`);
  assert.strictEqual(assembler.pc, 4);
});

test('Assembler should encode neg as sub rd, zero, rs', () => {
  const assembler = new Assembler();
  const dump = assembler.assemble('neg t0, t0');
  // sub t0, zero, t0 → rd=5, r1=0, r2=5, f7=0x20, f3=0
  assert.strictEqual(assembler.pc, 4);
  // disassemblerで確認: バイト列をデコードして sub になること
  const { Disassembler } = require('../src/disassembler');
  const result = new Disassembler().disassemble(dump);
  assert.ok(result.includes('neg\tt0,t0'));
});

test('Assembler should encode divu and remu', () => {
  const assembler = new Assembler();
  const dump = assembler.assemble(`
    divu t0, t0, t1
    remu t0, t0, t1
  `);
  assert.strictEqual(assembler.pc, 8);
});

test('Assembler li with lower=0 literal emits only lui (4 bytes)', () => {
  // 0x40022000: 下位12bit=0, bit31=0
  const a1 = new Assembler();
  a1.assemble('li t0, 0x40022000');
  assert.strictEqual(a1.pc, 4, 'lower=0 literal should be 4 bytes');

  // lower!=0 なら lui+addi で 8 bytes
  const a2 = new Assembler();
  a2.assemble('li t0, 0x40022100');
  assert.strictEqual(a2.pc, 8, 'lower!=0 should be 8 bytes');
});

test('Assembler li with bit31 set and lower=0 emits only lui (4 bytes)', () => {
  // 0xe000f000: 下位12bit=0, bit31=1 → JS の & が負の Int32 を返す問題の修正確認
  const assembler = new Assembler();
  const dump = assembler.assemble('li t0, 0xe000f000');
  assert.strictEqual(assembler.pc, 4, '0xe000f000 should be 4 bytes (lui only)');
  // lui t0, 0xe000f → 0xe000f2b7 (バイト列: b7 f2 00 e0)
  assert.ok(dump.includes('b7 f2 00 e0'), `Expected e000f2b7, got: ${dump}`);
});

test('Assembler should handle .byte directive', () => {
  const assembler = new Assembler();
  const dump = assembler.assemble('.byte 0x42');
  assert.strictEqual(assembler.pc, 1);
  assert.strictEqual(assembler.buffer[0], 0x42);
});

test('Assembler should handle multiple .byte directives', () => {
  const assembler = new Assembler();
  assembler.assemble('.byte 0x01\n.byte 0x02\n.byte 0x03');
  assert.strictEqual(assembler.pc, 3);
  assert.strictEqual(assembler.buffer[0], 0x01);
  assert.strictEqual(assembler.buffer[1], 0x02);
  assert.strictEqual(assembler.buffer[2], 0x03);
});

test('Assembler .align should pad to boundary', () => {
  const assembler = new Assembler();
  assembler.assemble('.byte 0x01\n.byte 0x02\n.byte 0x03\n.align 2');
  assert.strictEqual(assembler.pc, 4);
  assert.strictEqual(assembler.buffer[3], 0x00);
});

test('Assembler .align when already aligned is no-op', () => {
  const assembler = new Assembler();
  assembler.assemble('.word 0x12345678\n.align 2');
  assert.strictEqual(assembler.pc, 4);
});

test('Assembler .byte followed by instruction', () => {
  const assembler = new Assembler();
  assembler.assemble('.byte 0x01\n.byte 0x02\n.byte 0x03\n.byte 0x04\nli t0, 10');
  assert.strictEqual(assembler.pc, 8); // 4 bytes + 4 bytes (li fits in addi)
});

test('Assembler .byte label reference', () => {
  const assembler = new Assembler();
  assembler.assemble('mydata:\n.byte 0xAA\n.byte 0xBB\n.align 2\nla t0, mydata');
  // mydata is at 0, la should load address 0
  assert.strictEqual(assembler.buffer[0], 0xAA);
  assert.strictEqual(assembler.buffer[1], 0xBB);
});

test('Assembler should throw on unknown instruction', () => {
  const assembler = new Assembler();
  assert.throws(
    () => assembler.assemble('unknown_op t0, t1'),
    /Unknown instruction/
  );
});
