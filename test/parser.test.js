
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Tokenizer, Parser, parseStringLiteral } = require('../src/parser');

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

test('Parser should handle data declaration with byte array', () => {
  const source = 'data TABLE = { 0x00, 0x10, 0xFF };';
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();

  const decl = ast.body[0];
  assert.strictEqual(decl.type, 'DataDeclaration');
  assert.strictEqual(decl.name, 'TABLE');
  assert.strictEqual(decl.dataType, 'bytes');
  assert.deepStrictEqual(decl.values, [0, 16, 255]);
});

test('Parser should handle data declaration with string literal', () => {
  const source = 'data MSG = "Hi\\n";';
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();

  const decl = ast.body[0];
  assert.strictEqual(decl.type, 'DataDeclaration');
  assert.strictEqual(decl.name, 'MSG');
  assert.strictEqual(decl.dataType, 'string');
  assert.deepStrictEqual(decl.values, [72, 105, 10]);
});

test('parseStringLiteral should handle escape sequences', () => {
  assert.deepStrictEqual(parseStringLiteral('"\\n\\r\\t\\\\\\""'), [10, 13, 9, 92, 34]);
  assert.deepStrictEqual(parseStringLiteral('"\\0"'), [0]);
  assert.deepStrictEqual(parseStringLiteral('"\\x41\\x42"'), [65, 66]);
});

test('Parser should handle empty data declaration', () => {
  const source = 'data EMPTY = {};';
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();

  assert.strictEqual(ast.body[0].type, 'DataDeclaration');
  assert.deepStrictEqual(ast.body[0].values, []);
});

test('Parser should handle sizeof expression', () => {
  const source = 'data T = { 1, 2, 3 }; const LEN = sizeof(T);';
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();

  const constDecl = ast.body[1];
  assert.strictEqual(constDecl.type, 'ConstDeclaration');
  assert.strictEqual(constDecl.init.type, 'SizeofExpression');
  assert.strictEqual(constDecl.init.name, 'T');
});

test('Tokenizer should handle STRING token', () => {
  const source = '"hello world"';
  const tokenizer = new Tokenizer(source);
  assert.strictEqual(tokenizer.tokens[0].type, 'STRING');
  assert.strictEqual(tokenizer.tokens[0].value, '"hello world"');
});

test('Parser should handle trailing comma in data declaration', () => {
  const source = 'data T = { 1, 2, 3, };';
  const tokenizer = new Tokenizer(source);
  const parser = new Parser(tokenizer);
  const ast = parser.parse();

  assert.deepStrictEqual(ast.body[0].values, [1, 2, 3]);
});
