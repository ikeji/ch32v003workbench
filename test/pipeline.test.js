
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Tokenizer, Parser } = require('../src/parser');
const { StackGenerator } = require('../src/stackgen');
const { AssemblerGenerator } = require('../src/asmgen');
const { Assembler } = require('../src/assembler');
const { VM } = require('../src/vm');

test('Complete Pipeline Test with sample_idea.c', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/sample_idea.c'), 'utf-8');

  // 1. Parser
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();
  assert.strictEqual(ast.type, 'Program');
  assert.ok(ast.body.length > 0);

  // 2. StackGen
  const stackgen = new StackGenerator();
  const ir = stackgen.generate(ast);
  assert.ok(Array.isArray(ir));
  const mainFunc = ir.find(item => item.type === 'FUNC' && item.name === 'main');
  assert.ok(mainFunc, 'main function should be in IR');
  assert.ok(ir.some(item => {
    if (item.type !== 'FUNC') return false;
    return item.ops.some(op => op.op === 'PEEK' || op.op === 'POKE');
  }), 'IR should contain PEEK or POKE ops');

  // 3. AsmGen (TODO: needs update to consume new IR format)
  const asmgen = new AssemblerGenerator();
  const asm = asmgen.generate(ir);
  assert.ok(asm.includes('_start:'));
  assert.ok(asm.includes('main:'));
  assert.ok(asm.includes('SystemInit:'));

  // 4. Assembler
  const assembler = new Assembler();
  const hexdump = assembler.assemble(asm);
  assert.ok(hexdump.includes('00000000:'));
  assert.ok(assembler.pc > 100);

  // 5. VM Execution (Dry run)
  let gpioWrites = 0;
  const vm = new VM(hexdump, null, (addr, val) => {
    gpioWrites++;
  });

  for (let i = 0; i < 1000; i++) {
    if (!vm.step()) break;
  }

  assert.ok(vm.pc !== 0);
});
