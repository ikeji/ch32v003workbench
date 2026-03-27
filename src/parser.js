
/**
 * TinyC Parser for CH32V003
 */

function parseNumberLiteral(s) {
  if (s.startsWith('0b') || s.startsWith('0B')) return parseInt(s.slice(2), 2);
  if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s.slice(2), 16);
  if (s.length > 1 && s.startsWith('0')) return parseInt(s, 8);
  return parseInt(s, 10);
}

class Tokenizer {
  constructor(source) {
    this.source = source;
    this.tokens = [];
    this.pos = 0;
    this.tokenize();
  }

  tokenize() {
    const rules = [
      { type: 'COMMENT', regex: /^\/\/.*|^\/\*[\s\S]*?\*\// },
      { type: 'WHITESPACE', regex: /^\s+/ },
      { type: 'NUMBER', regex: /^(0x[0-9a-fA-F]+|0b[01]+|0[0-7]*|[0-9]+)/ },
      { type: 'KEYWORD', regex: /^(func|const|var|if|else|return|loop|break|continue)\b/ },
      { type: 'IDENTIFIER', regex: /^[a-zA-Z_][a-zA-Z0-9_]*/ },
      { type: 'OPERATOR', regex: /^(<<|>>|==|!=|<=|>=|&&|\|\||[+\-*/%&|^~<>!?:=])/ },
      { type: 'PUNCTUATION', regex: /^[(){},;]/ },
    ];

    let pos = 0;
    let current = this.source;
    while (current.length > 0) {
      let matched = false;
      for (const rule of rules) {
        const match = current.match(rule.regex);
        if (match) {
          if (rule.type !== 'WHITESPACE' && rule.type !== 'COMMENT') {
            this.tokens.push({ type: rule.type, value: match[0], start: pos, end: pos + match[0].length });
          }
          pos += match[0].length;
          current = current.slice(match[0].length);
          matched = true;
          break;
        }
      }
      if (!matched) {
        throw new Error(`Unexpected character at: ${current.slice(0, 10)}...`);
      }
    }
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  expect(type, value) {
    const token = this.next();
    if (!token || token.type !== type || (value && token.value !== value)) {
      throw new Error(`Expected ${type}${value ? ` '${value}'` : ''}, but got ${token ? token.value : 'EOF'}`);
    }
    return token;
  }

  isEOF() {
    return this.pos >= this.tokens.length;
  }
}

class Parser {
  constructor(tokens) {
    this.tokenizer = tokens;
  }

  _startPos() {
    return this.tokenizer.tokens[this.tokenizer.pos]?.start ?? 0;
  }

  _srcFrom(startPos) {
    const lastToken = this.tokenizer.tokens[this.tokenizer.pos - 1];
    const endPos = lastToken?.end ?? startPos;
    return this.tokenizer.source.slice(startPos, endPos).trim();
  }

  parse() {
    const body = [];
    while (!this.tokenizer.isEOF()) {
      body.push(this.parseTopLevel());
    }
    return { type: 'Program', body };
  }

  parseTopLevel() {
    const token = this.tokenizer.peek();
    if (token.type === 'KEYWORD') {
      if (token.value === 'func') return this.parseFunction();
      if (token.value === 'const') return this.parseGlobalConst();
      if (token.value === 'var') return this.parseGlobalVar();
    }
    throw new Error(`Unexpected top-level token: ${token.value}`);
  }

  parseFunction() {
    const startPos = this._startPos();
    this.tokenizer.expect('KEYWORD', 'func');
    const name = this.tokenizer.expect('IDENTIFIER').value;
    this.tokenizer.expect('PUNCTUATION', '(');
    const params = [];
    if (this.tokenizer.peek().value !== ')') {
      params.push(this.tokenizer.expect('IDENTIFIER').value);
      while (this.tokenizer.peek().value === ',') {
        this.tokenizer.next();
        params.push(this.tokenizer.expect('IDENTIFIER').value);
      }
    }
    this.tokenizer.expect('PUNCTUATION', ')');
    const src = this._srcFrom(startPos);
    const body = this.parseBlock();
    return { type: 'FunctionDeclaration', src, name, params, body };
  }

  parseBlock() {
    this.tokenizer.expect('PUNCTUATION', '{');
    const body = [];
    while (this.tokenizer.peek().value !== '}') {
      body.push(this.parseStatement());
    }
    this.tokenizer.expect('PUNCTUATION', '}');
    return body;
  }

  parseStatement() {
    const token = this.tokenizer.peek();
    if (token.type === 'KEYWORD') {
      switch (token.value) {
        case 'var': return this.parseVarDeclaration();
        case 'const': return this.parseConstDeclaration();
        case 'if': return this.parseIf();
        case 'loop': return this.parseLoop();
        case 'return': return this.parseReturn();
        case 'break': {
          const startPos = this._startPos();
          this.tokenizer.next();
          this.tokenizer.expect('PUNCTUATION', ';');
          return { type: 'BreakStatement', src: this._srcFrom(startPos) };
        }
        case 'continue': {
          const startPos = this._startPos();
          this.tokenizer.next();
          this.tokenizer.expect('PUNCTUATION', ';');
          return { type: 'ContinueStatement', src: this._srcFrom(startPos) };
        }
      }
    }
    if (token.value === '{') return { type: 'BlockStatement', body: this.parseBlock() };

    const startPos = this._startPos();
    const expr = this.parseExpression();
    this.tokenizer.expect('PUNCTUATION', ';');
    return { type: 'ExpressionStatement', src: this._srcFrom(startPos), expression: expr };
  }

  parseVarDeclaration() {
    const startPos = this._startPos();
    this.tokenizer.expect('KEYWORD', 'var');
    const name = this.tokenizer.expect('IDENTIFIER').value;
    let init = null;
    if (this.tokenizer.peek().value === '=') {
      this.tokenizer.next();
      init = this.parseExpression();
    }
    this.tokenizer.expect('PUNCTUATION', ';');
    return { type: 'VariableDeclaration', src: this._srcFrom(startPos), name, init };
  }

  parseGlobalVar() { return this.parseVarDeclaration(); }

  parseConstDeclaration() {
    const startPos = this._startPos();
    this.tokenizer.expect('KEYWORD', 'const');
    const name = this.tokenizer.expect('IDENTIFIER').value;
    this.tokenizer.expect('OPERATOR', '=');
    const init = this.parseExpression();
    this.tokenizer.expect('PUNCTUATION', ';');
    return { type: 'ConstDeclaration', src: this._srcFrom(startPos), name, init };
  }

  parseGlobalConst() { return this.parseConstDeclaration(); }

  parseIf() {
    const startPos = this._startPos();
    this.tokenizer.expect('KEYWORD', 'if');
    this.tokenizer.expect('PUNCTUATION', '(');
    const test = this.parseExpression();
    this.tokenizer.expect('PUNCTUATION', ')');
    const src = this._srcFrom(startPos);
    const consequent = this.parseStatement();
    let alternate = null;
    if (!this.tokenizer.isEOF() && this.tokenizer.peek().value === 'else') {
      this.tokenizer.next();
      alternate = this.parseStatement();
    }
    return { type: 'IfStatement', src, test, consequent, alternate };
  }

  parseLoop() {
    const startPos = this._startPos();
    this.tokenizer.expect('KEYWORD', 'loop');
    const src = this._srcFrom(startPos);
    const body = this.parseStatement();
    return { type: 'LoopStatement', src, body };
  }

  parseReturn() {
    const startPos = this._startPos();
    this.tokenizer.expect('KEYWORD', 'return');
    let argument = null;
    if (this.tokenizer.peek().value !== ';') {
      argument = this.parseExpression();
    }
    this.tokenizer.expect('PUNCTUATION', ';');
    return { type: 'ReturnStatement', src: this._srcFrom(startPos), argument };
  }

  parseExpression() {
    return this.parseAssignment();
  }

  parseAssignment() {
    let left = this.parseTernary();
    if (!this.tokenizer.isEOF() && this.tokenizer.peek().value === '=') {
      this.tokenizer.next();
      const right = this.parseAssignment();
      return { type: 'AssignmentExpression', left, right };
    }
    return left;
  }

  parseTernary() {
    let condition = this.parseLogicalOr();
    if (!this.tokenizer.isEOF() && this.tokenizer.peek().value === '?') {
      this.tokenizer.next();
      const trueExpr = this.parseExpression();
      this.tokenizer.expect('OPERATOR', ':');
      const falseExpr = this.parseTernary();
      return { type: 'TernaryExpression', condition, trueExpr, falseExpr };
    }
    return condition;
  }

  parseLogicalOr() {
    let left = this.parseLogicalAnd();
    while (!this.tokenizer.isEOF() && this.tokenizer.peek().value === '||') {
      const operator = this.tokenizer.next().value;
      const right = this.parseLogicalAnd();
      left = { type: 'BinaryExpression', operator, left, right };
    }
    return left;
  }

  parseLogicalAnd() {
    let left = this.parseBitwiseOr();
    while (!this.tokenizer.isEOF() && this.tokenizer.peek().value === '&&') {
      const operator = this.tokenizer.next().value;
      const right = this.parseBitwiseOr();
      left = { type: 'BinaryExpression', operator, left, right };
    }
    return left;
  }

  parseBitwiseOr() {
    let left = this.parseBitwiseXor();
    while (!this.tokenizer.isEOF() && this.tokenizer.peek().value === '|') {
      const operator = this.tokenizer.next().value;
      const right = this.parseBitwiseXor();
      left = { type: 'BinaryExpression', operator, left, right };
    }
    return left;
  }

  parseBitwiseXor() {
    let left = this.parseBitwiseAnd();
    while (!this.tokenizer.isEOF() && this.tokenizer.peek().value === '^') {
      const operator = this.tokenizer.next().value;
      const right = this.parseBitwiseAnd();
      left = { type: 'BinaryExpression', operator, left, right };
    }
    return left;
  }

  parseBitwiseAnd() {
    let left = this.parseEquality();
    while (!this.tokenizer.isEOF() && this.tokenizer.peek().value === '&') {
      const operator = this.tokenizer.next().value;
      const right = this.parseEquality();
      left = { type: 'BinaryExpression', operator, left, right };
    }
    return left;
  }

  parseEquality() {
    let left = this.parseRelational();
    while (!this.tokenizer.isEOF() && (this.tokenizer.peek().value === '==' || this.tokenizer.peek().value === '!=')) {
      const operator = this.tokenizer.next().value;
      const right = this.parseRelational();
      left = { type: 'BinaryExpression', operator, left, right };
    }
    return left;
  }

  parseRelational() {
    let left = this.parseShift();
    const ops = ['<', '>', '<=', '>='];
    while (!this.tokenizer.isEOF() && ops.includes(this.tokenizer.peek().value)) {
      const operator = this.tokenizer.next().value;
      const right = this.parseShift();
      left = { type: 'BinaryExpression', operator, left, right };
    }
    return left;
  }

  parseShift() {
    let left = this.parseAdditive();
    const ops = ['<<', '>>'];
    while (!this.tokenizer.isEOF() && ops.includes(this.tokenizer.peek().value)) {
      const operator = this.tokenizer.next().value;
      const right = this.parseAdditive();
      left = { type: 'BinaryExpression', operator, left, right };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (!this.tokenizer.isEOF() && (this.tokenizer.peek().value === '+' || this.tokenizer.peek().value === '-')) {
      const operator = this.tokenizer.next().value;
      const right = this.parseMultiplicative();
      left = { type: 'BinaryExpression', operator, left, right };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    const ops = ['*', '/', '%'];
    while (!this.tokenizer.isEOF() && ops.includes(this.tokenizer.peek().value)) {
      const operator = this.tokenizer.next().value;
      const right = this.parseUnary();
      left = { type: 'BinaryExpression', operator, left, right };
    }
    return left;
  }

  parseUnary() {
    const ops = ['+', '-', '~', '!'];
    if (ops.includes(this.tokenizer.peek().value)) {
      const operator = this.tokenizer.next().value;
      const argument = this.parseUnary();
      return { type: 'UnaryExpression', operator, argument };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.tokenizer.next();
    if (token.type === 'NUMBER') {
      return { type: 'Literal', value: parseNumberLiteral(token.value) };
    }
    if (token.type === 'IDENTIFIER') {
      if (!this.tokenizer.isEOF() && this.tokenizer.peek().value === '(') {
        this.tokenizer.next();
        const args = [];
        if (this.tokenizer.peek().value !== ')') {
          args.push(this.parseExpression());
          while (this.tokenizer.peek().value === ',') {
            this.tokenizer.next();
            args.push(this.parseExpression());
          }
        }
        this.tokenizer.expect('PUNCTUATION', ')');
        return { type: 'CallExpression', callee: token.value, arguments: args };
      }
      return { type: 'Identifier', name: token.value };
    }
    if (token.value === '(') {
      const expr = this.parseExpression();
      this.tokenizer.expect('PUNCTUATION', ')');
      return expr;
    }
    throw new Error(`Unexpected token in primary: ${token.value}`);
  }
}

if (typeof module !== 'undefined') {
  module.exports = { Tokenizer, Parser };
}
