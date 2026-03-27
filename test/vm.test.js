
const test = require('node:test');
const assert = require('node:assert');
const { Assembler } = require('../src/assembler');
const { VM } = require('../src/vm');

test('VM should execute basic math', () => {
  const assembler = new Assembler();
  const asm = `
    li a0, 10
    li a1, 20
    add a2, a0, a1
    sub a3, a1, a0
  `;
  const hexdump = assembler.assemble(asm);
  const vm = new VM(hexdump);
  
  while (vm.step());
  
  assert.strictEqual(vm.regs[10], 10); // a0
  assert.strictEqual(vm.regs[11], 20); // a1
  assert.strictEqual(vm.regs[12], 30); // a2 (10 + 20)
  assert.strictEqual(vm.regs[13], 10); // a3 (20 - 10)
});

test('VM should handle branches', () => {
  const assembler = new Assembler();
  const asm = `
    li a0, 5
    li a1, 0
    loop:
      addi a1, a1, 1
      bne a1, a0, loop
  `;
  const hexdump = assembler.assemble(asm);
  const vm = new VM(hexdump);
  
  // Running with a limit to avoid infinite loop
  let steps = 0;
  while (vm.step() && steps < 100) steps++;
  
  assert.strictEqual(vm.regs[11], 5); // a1 should be 5
});

test('VM should handle memory access in SRAM', () => {
  const assembler = new Assembler();
  const asm = `
    li t0, 0x20000000
    li t1, 123
    sw t1, 0(t0)
    lw t2, 0(t0)
  `;
  const hexdump = assembler.assemble(asm);
  const vm = new VM(hexdump);
  
  while (vm.step());
  
  assert.strictEqual(vm.regs[7], 123); // t2 should be 123
});
