
const test = require('node:test');
const assert = require('node:assert');
const { Tokenizer, Parser } = require('../src/parser');
const { StackGenerator } = require('../src/stackgen');

function getIR(source) {
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();
  const stackgen = new StackGenerator();
  return stackgen.generate(ast);
}

function getFunc(ir, name) {
  return ir.find(item => item.type === 'FUNC' && item.name === name);
}

test('StackGen should generate basic math instructions', () => {
  const ir = getIR('func main() { var x = 1 + 2 * 3; }');
  const main = getFunc(ir, 'main');
  assert.ok(main, 'main function should exist');
  const ops = main.ops.filter(i => i.op !== 'COMMENT').map(i => i.op);
  // 1, 2, 3, MUL, ADD, SAVE
  assert.deepStrictEqual(ops, ['CONST', 'CONST', 'CONST', 'MUL', 'ADD', 'SAVE']);
});

test('StackGen should handle if-else with IF_GOTO (condition true → then)', () => {
  const ir = getIR('func main() { if (1) { return 1; } else { return 0; } }');
  const main = getFunc(ir, 'main');
  const ops = main.ops.filter(i => i.op !== 'COMMENT').map(i => i.op);
  assert.ok(ops.includes('IF_GOTO'));
  assert.ok(ops.includes('LABEL'));
  assert.ok(ops.includes('GOTO'));
});

test('StackGen should handle loops and break', () => {
  const ir = getIR('func main() { loop { break; } }');
  const main = getFunc(ir, 'main');
  const ops = main.ops.filter(i => i.op !== 'COMMENT');
  const labels = ops.filter(i => i.op === 'LABEL').map(i => i.name);
  const gotos = ops.filter(i => i.op === 'GOTO').map(i => i.name);
  assert.strictEqual(labels.length, 2); // start and end
  // break → GOTO end label; loop → GOTO start label
  assert.ok(gotos.includes(labels[1])); // break goes to end
  assert.ok(gotos.includes(labels[0])); // loop back to start
});

test('StackGen should inline peek and poke without CALL', () => {
  const ir = getIR('func main() { poke(0x40021000, peek(0x40021000) | 1); }');
  const main = getFunc(ir, 'main');
  const ops = main.ops.map(i => i.op);
  assert.ok(ops.includes('PEEK'));
  assert.ok(ops.includes('POKE'));
  assert.ok(!ops.includes('CALL'));
});

test('StackGen should handle ternary operator', () => {
  const ir = getIR('func main() { var x = a ? 1 : 0; }');
  const main = getFunc(ir, 'main');
  const ops = main.ops.filter(i => i.op !== 'COMMENT').map(i => i.op);
  assert.ok(ops.includes('IF_GOTO'));
  assert.ok(ops.includes('GOTO'));
  assert.strictEqual(ops.filter(o => o === 'LABEL').length, 2);
});

test('StackGen should handle global constants (no VAR or FUNC output for const)', () => {
  const source = 'const A = 10; const B = 20; func main() { poke(A, B); }';
  const ir = getIR(source);
  // Global consts produce no VAR entries
  assert.ok(!ir.some(item => item.type === 'VAR'));
  const main = getFunc(ir, 'main');
  const ops = main.ops.filter(i => i.op !== 'COMMENT');
  assert.deepStrictEqual(ops, [
    { op: 'CONST', val: 10 },
    { op: 'CONST', val: 20 },
    { op: 'POKE' },
  ]);
});

test('StackGen should emit VAR for global variables', () => {
  const source = 'var counter = 0; func main() { counter = 1; }';
  const ir = getIR(source);
  const varEntry = ir.find(item => item.type === 'VAR' && item.name === 'counter');
  assert.ok(varEntry, 'global var should appear as VAR entry');
  assert.strictEqual(varEntry.value, 0);
  const main = getFunc(ir, 'main');
  const ops = main.ops.filter(i => i.op !== 'COMMENT').map(i => i.op);
  assert.ok(ops.includes('PUT'));
});

test('StackGen should use LOAD/SAVE for locals and GET/PUT for globals', () => {
  const source = 'var g = 0; func f(a) { var b = a; g = b; }';
  const ir = getIR(source);
  const f = getFunc(ir, 'f');
  const ops = f.ops.filter(i => i.op !== 'COMMENT');
  // a is param id=0, b is local id=1
  assert.ok(ops.some(i => i.op === 'LOAD' && i.id === 0)); // read param a
  assert.ok(ops.some(i => i.op === 'SAVE' && i.id === 1)); // write local b
  assert.ok(ops.some(i => i.op === 'LOAD' && i.id === 1)); // read local b
  assert.ok(ops.some(i => i.op === 'PUT'  && i.name === 'g')); // write global g
});

test('StackGen FUNC should have correct nargs and nvars', () => {
  const source = 'func f(a, b) { var c = 0; var d = 0; }';
  const ir = getIR(source);
  const f = getFunc(ir, 'f');
  assert.strictEqual(f.nargs, 2);
  assert.strictEqual(f.nvars, 4); // a, b, c, d
});

test('StackGen should emit COMMENT ops from src fields', () => {
  const ir = getIR('func main() { return 1; }');
  const main = getFunc(ir, 'main');
  assert.ok(main.ops.some(i => i.op === 'COMMENT'));
});

test('StackGen should emit POP after function call used as statement', () => {
  const source = 'func foo() { return 1; } func main() { foo(); }';
  const ir = getIR(source);
  const main = getFunc(ir, 'main');
  const ops = main.ops.filter(i => i.op !== 'COMMENT').map(i => i.op);
  assert.ok(ops.includes('CALL'));
  assert.ok(ops.includes('POP'));
});

test('StackGen should NOT emit POP after poke (no return value)', () => {
  const source = 'func main() { poke(1, 2); }';
  const ir = getIR(source);
  const main = getFunc(ir, 'main');
  const ops = main.ops.filter(i => i.op !== 'COMMENT').map(i => i.op);
  assert.ok(!ops.includes('POP'));
});
