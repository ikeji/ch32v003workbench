
const test = require('node:test');
const assert = require('node:assert');
const { Tokenizer, Parser } = require('../src/parser');
const { StackGenerator } = require('../src/stackgen');
const { AssemblerGenerator } = require('../src/asmgen');

function getAsm(source) {
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();
  const stackgen = new StackGenerator();
  const ir = stackgen.generate(ast);
  const asmgen = new AssemblerGenerator();
  return asmgen.generate(ir);
}

test('AsmGen should generate entry point and main function', () => {
  const asm = getAsm('func main() { return 0; }');
  assert.ok(asm.includes('_start:'));
  assert.ok(asm.includes('main:'));
  assert.ok(asm.includes('ret'));
});

test('AsmGen should handle local variables on stack (s0-relative)', () => {
  // main has no params (nargs=0), so x is non-param local id=0 → offset = -(12+0) = -12
  const asm = getAsm('func main() { var x = 10; return x; }');
  assert.ok(asm.includes('sw t0, -12(s0)'));  // SAVE id=0
  assert.ok(asm.includes('lw t0, -12(s0)'));  // LOAD id=0
});

test('AsmGen should handle function params (s0-relative positive offsets)', () => {
  // f(a, b): nargs=2, a=id0 → offset=(2-1-0)*4=4, b=id1 → offset=(2-1-1)*4=0
  const asm = getAsm('func f(a, b) { return a; }');
  assert.ok(asm.includes('lw t0, 4(s0)'));  // LOAD id=0 (param a)
});

test('AsmGen should handle global variables', () => {
  const asm = getAsm('var G = 100; func main() { return G; }');
  // 非ゼロ初期値はフラッシュに保存される
  assert.ok(asm.includes('var_G_init: .word 100'));
  // reset_handlerでフラッシュからRAMへコピー
  assert.ok(asm.includes('la t0, var_G_init'));
  // GET/PUTはRAMの絶対アドレスを使用 (0x20000000 〜)
  assert.ok(asm.includes('li t1, 0x20000000'));
});

test('AsmGen should generate inline peek/poke', () => {
  const asm = getAsm('func main() { poke(0, peek(0)); }');
  assert.ok(asm.includes('lw t0, 0(t0)'));  // peek: load from addr
  assert.ok(asm.includes('sw t1, 0(t0)'));  // poke: store value to addr
});

test('AsmGen should emit .byte directives for data declaration', () => {
  const asm = getAsm('data TABLE = { 0x10, 0x20 }; func main() { return 0; }');
  assert.ok(asm.includes('data_TABLE:'), 'should have data label');
  assert.ok(asm.includes('.byte 16'), 'should have .byte 16');
  assert.ok(asm.includes('.byte 32'), 'should have .byte 32');
  assert.ok(asm.includes('.align 2'), 'should have .align 2');
});

test('AsmGen should emit la for DATA_ADDR', () => {
  const asm = getAsm('data TABLE = { 1 }; func main() { return TABLE; }');
  assert.ok(asm.includes('la t0, data_TABLE'), 'should use la to load data address');
});

test('AsmGen full pipeline with data and peek8', () => {
  const source = 'data MSG = "AB"; func main() { return peek8(MSG); }';
  const asm = getAsm(source);
  assert.ok(asm.includes('data_MSG:'));
  assert.ok(asm.includes('.byte 65'));
  assert.ok(asm.includes('.byte 66'));
  assert.ok(asm.includes('la t0, data_MSG'));
  assert.ok(asm.includes('lbu t0, 0(t0)'));  // peek8
});
