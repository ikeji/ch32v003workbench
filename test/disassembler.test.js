
const test = require('node:test');
const assert = require('node:assert');
const { Assembler } = require('../src/assembler');
const { Disassembler } = require('../src/disassembler');

function roundtrip(asm) {
  const hexdump = new Assembler().assemble(asm);
  return new Disassembler().disassemble(hexdump);
}

test('Disassembler should decode assembler output', () => {
  const result = roundtrip(`
    li t0, 10
    addi t1, t0, 5
    add t2, t0, t1
    lw a0, 0(sp)
    sw a1, 4(sp)
    ret
  `);
  assert.ok(result.includes('li\tt0,10'));
  assert.ok(result.includes('addi\tt1,t0,5'));
  assert.ok(result.includes('add\tt2,t0,t1'));
  assert.ok(result.includes('lw\ta0,0(sp)'));
  assert.ok(result.includes('sw\ta1,4(sp)'));
  assert.ok(result.includes('ret'));
});

test('Disassembler should handle jumps and branches', () => {
  const result = roundtrip(`
    loop:
      li a0, 1
      bne a0, zero, loop
      j loop
  `);
  // bne a0, zero は bnez a0 にfold、アドレスはPC相対で0x0 (loop先頭)
  assert.ok(result.includes('bnez\ta0,0x0'));
  assert.ok(result.includes('j\t0x0'));
});

test('Disassembler should decode lui correctly', () => {
  // lui sp, 0x20001 → sp = 0x20001000
  const result = roundtrip('lui sp, 0x20001');
  assert.ok(result.includes('lui\tsp,0x20001'));
});

test('Disassembler should decode mv pseudo (addi rd, rs, 0)', () => {
  const result = roundtrip('mv t1, s0');
  assert.ok(result.includes('mv\tt1,s0'));
});

test('Disassembler should decode not pseudo (xori rd, rs, -1)', () => {
  const result = roundtrip('not t0, t0');
  assert.ok(result.includes('not\tt0,t0'));
});

test('Disassembler should decode seqz pseudo (sltiu rd, rs, 1)', () => {
  const result = roundtrip('seqz t0, t0');
  assert.ok(result.includes('seqz\tt0,t0'));
});

test('Disassembler should decode R-type: sub, mul, sltu', () => {
  const result = roundtrip(`
    sub t0, t0, t1
    mul t0, t0, t1
    sltu t0, t0, t1
  `);
  assert.ok(result.includes('sub\tt0,t0,t1'));
  assert.ok(result.includes('mul\tt0,t0,t1'));
  assert.ok(result.includes('sltu\tt0,t0,t1'));
});

test('Disassembler should decode lhu and lbu', () => {
  const result = roundtrip(`
    lhu t0, 0(t1)
    lbu t0, 0(t1)
  `);
  assert.ok(result.includes('lhu\tt0,0(t1)'));
  assert.ok(result.includes('lbu\tt0,0(t1)'));
});

test('Disassembler should decode sh and sb', () => {
  const result = roundtrip(`
    sh t0, 0(t1)
    sb t0, 0(t1)
  `);
  assert.ok(result.includes('sh\tt0,0(t1)'));
  assert.ok(result.includes('sb\tt0,0(t1)'));
});

test('Disassembler output format matches objdump style', () => {
  const result = roundtrip('addi sp, sp, -4');
  // "   0:\tffc10113\t\taddi\tsp,sp,-4"
  assert.ok(result.includes(':\t'));           // addr: \t
  assert.ok(result.includes('ffc10113'));      // 8桁hex
  assert.ok(result.includes('addi\tsp,sp,-4')); // tab区切り、カンマ後スペースなし
});
