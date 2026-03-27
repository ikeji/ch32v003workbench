
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Tokenizer, Parser } = require('../src/parser');

test('Tokenizer should handle different number formats', () => {
  const source = '123 0xABC 0b101 0123';
  const tokenizer = new Tokenizer(source);
  assert.strictEqual(tokenizer.tokens[0].value, '123');
  assert.strictEqual(tokenizer.tokens[1].value, '0xABC');
  assert.strictEqual(tokenizer.tokens[2].value, '0b101');
  assert.strictEqual(tokenizer.tokens[3].value, '0123');
});

test('Parser should handle basic function and binary expression', () => {
  const source = 'func add(a, b) { return a + b; }';
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();
  
  assert.strictEqual(ast.type, 'Program');
  const func = ast.body[0];
  assert.strictEqual(func.type, 'FunctionDeclaration');
  assert.strictEqual(func.name, 'add');
  assert.deepStrictEqual(func.params, ['a', 'b']);
  assert.strictEqual(func.body[0].type, 'ReturnStatement');
  assert.strictEqual(func.body[0].argument.type, 'BinaryExpression');
});

test('Parser should handle loop, break, continue', () => {
  const source = 'func test() { loop { if (1) break; else continue; } }';
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();
  
  const loop = ast.body[0].body[0];
  assert.strictEqual(loop.type, 'LoopStatement');
  assert.strictEqual(loop.body.type, 'BlockStatement');
  const ifStmt = loop.body.body[0];
  assert.strictEqual(ifStmt.consequent.type, 'BreakStatement');
  assert.strictEqual(ifStmt.alternate.type, 'ContinueStatement');
});

test('Parser should parse sample_idea.c without error', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/sample_idea.c'), 'utf-8');
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();
  
  assert.strictEqual(ast.type, 'Program');
  // Check some key functions exist
  const funcNames = ast.body.filter(n => n.type === 'FunctionDeclaration').map(n => n.name);
  assert.ok(funcNames.includes('main'));
  assert.ok(funcNames.includes('SystemInit'));
  assert.ok(funcNames.includes('Delay_Ms'));
});

test('Parser should handle operator precedence (mul vs add)', () => {
  const source = 'var x = 1 + 2 * 3;';
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();
  
  const init = ast.body[0].init;
  assert.strictEqual(init.operator, '+');
  assert.strictEqual(init.right.operator, '*');
});

test('Parser should handle ternary operator', () => {
  const source = 'var x = a ? b : c;';
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();
  
  const init = ast.body[0].init;
  assert.strictEqual(init.type, 'TernaryExpression');
  assert.strictEqual(init.condition.name, 'a');
  assert.strictEqual(init.trueExpr.name, 'b');
  assert.strictEqual(init.falseExpr.name, 'c');
});
