
/**
 * Stack Machine Code Generator for TinyC
 */

class StackGenerator {
  constructor() {
    this.output = [];
    this.constants = new Map();
    this.globals = new Set();
    this.dataDecls = new Map();
    this.labelCount = 0;
    this.loopStack = [];
  }

  generate(ast) {
    this.output = [];
    this.constants.clear();
    this.globals.clear();
    this.dataDecls.clear();
    this.labelCount = 0;

    // Collect data declarations first (no forward refs in values)
    for (const node of ast.body) {
      if (node.type === 'DataDeclaration') {
        this.dataDecls.set(node.name, node.values);
      }
    }

    // First pass: collect global constants (repeat until stable to resolve forward refs)
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of ast.body) {
        if (node.type === 'ConstDeclaration' && !this.constants.has(node.name)) {
          const val = this.evaluate(node.init);
          if (val !== undefined) {
            this.constants.set(node.name, val);
            changed = true;
          }
        }
      }
    }
    // Collect global variable names
    for (const node of ast.body) {
      if (node.type === 'VariableDeclaration') {
        this.globals.add(node.name);
      }
    }

    // Second pass: generate IR
    for (const node of ast.body) {
      this.visitTopLevel(node);
    }

    return this.output;
  }

  newLabel() {
    return `L${this.labelCount++}`;
  }

  evaluate(node) {
    if (node.type === 'Literal') return node.value;
    if (node.type === 'SizeofExpression') {
      if (this.dataDecls.has(node.name)) return this.dataDecls.get(node.name).length;
      return undefined;
    }
    if (node.type === 'Identifier' && this.constants.has(node.name)) {
      return this.constants.get(node.name);
    }
    if (node.type === 'UnaryExpression' && node.operator === '-') {
      const v = this.evaluate(node.argument);
      return v !== undefined ? (-v >>> 0) : undefined;
    }
    if (node.type === 'BinaryExpression') {
      const l = this.evaluate(node.left);
      const r = this.evaluate(node.right);
      if (l !== undefined && r !== undefined) {
        switch (node.operator) {
          case '+': return (l + r) >>> 0;
          case '-': return (l - r) >>> 0;
          case '*': return (l * r) >>> 0;
          case '/': return (l / r) >>> 0;
          case '|': return (l | r) >>> 0;
          case '&': return (l & r) >>> 0;
          case '^': return (l ^ r) >>> 0;
          case '<<': return (l << r) >>> 0;
          case '>>': return (l >>> r);
        }
      }
    }
    return undefined;
  }

  visitTopLevel(node) {
    if (node.type === 'ConstDeclaration') {
      // Already collected in first pass; emit comment only
      if (node.src) this.output.push({ type: 'COMMENT', text: node.src });
      return;
    }
    if (node.type === 'VariableDeclaration') {
      if (node.src) this.output.push({ type: 'COMMENT', text: node.src });
      const val = node.init ? (this.evaluate(node.init) ?? 0) : 0;
      this.output.push({ type: 'VAR', name: node.name, value: val });
      return;
    }
    if (node.type === 'DataDeclaration') {
      if (node.src) this.output.push({ type: 'COMMENT', text: node.src });
      this.output.push({ type: 'DATA', name: node.name, values: node.values });
      return;
    }
    if (node.type === 'FunctionDeclaration') {
      if (node.src) this.output.push({ type: 'COMMENT', text: node.src });
      this.visitFunction(node);
      return;
    }
    throw new Error(`Unknown top-level node: ${node.type}`);
  }

  visitFunction(node) {
    const locals = new Map();
    for (let i = 0; i < node.params.length; i++) {
      locals.set(node.params[i], i);
    }

    this.loopStack = [];
    const ops = [];
    this.visitBlock(node.body, locals, ops);

    this.output.push({
      type: 'FUNC',
      name: node.name,
      nargs: node.params.length,
      nvars: locals.size,
      ops,
    });
  }

  visitBlock(stmts, locals, ops) {
    for (const stmt of stmts) {
      this.visitStmt(stmt, locals, ops);
    }
  }

  emit(ops, op, ...rest) {
    const instr = { op };
    if (op === 'CONST') instr.val = rest[0];
    else if (op === 'LOAD' || op === 'SAVE') instr.id = rest[0];
    else if (op === 'GET' || op === 'PUT') instr.name = rest[0];
    else if (op === 'CALL') { instr.name = rest[0]; instr.nargs = rest[1]; }
    else if (op === 'DATA_ADDR') instr.name = rest[0];
    else if (op === 'LABEL' || op === 'GOTO' || op === 'IF_GOTO') instr.name = rest[0];
    else if (op === 'COMMENT') instr.text = rest[0];
    ops.push(instr);
  }

  emitComment(ops, node) {
    if (node.src) this.emit(ops, 'COMMENT', node.src);
  }

  allocLocal(locals, name) {
    if (!locals.has(name)) {
      locals.set(name, locals.size);
    }
    return locals.get(name);
  }

  // Returns true if this expression leaves a value on the stack
  returnsValue(node) {
    if (node.type === 'AssignmentExpression') return false;
    if (node.type === 'CallExpression') {
      return !['poke', 'poke16', 'poke8'].includes(node.callee);
    }
    return true;
  }

  visitStmt(node, locals, ops) {
    switch (node.type) {
      case 'VariableDeclaration': {
        this.emitComment(ops, node);
        const id = this.allocLocal(locals, node.name);
        if (node.init) {
          this.visitExpr(node.init, locals, ops);
          this.emit(ops, 'SAVE', id);
        }
        break;
      }

      case 'ConstDeclaration': {
        // Local const: add to constants map, no code emitted
        this.emitComment(ops, node);
        const val = this.evaluate(node.init);
        if (val !== undefined) {
          this.constants.set(node.name, val);
        } else {
          // Not compile-time evaluatable: treat as local variable
          const id = this.allocLocal(locals, node.name);
          this.visitExpr(node.init, locals, ops);
          this.emit(ops, 'SAVE', id);
        }
        break;
      }

      case 'ReturnStatement':
        this.emitComment(ops, node);
        if (node.argument) {
          this.visitExpr(node.argument, locals, ops);
        }
        this.emit(ops, 'RETURN');
        break;

      case 'IfStatement': {
        this.emitComment(ops, node);
        const labelThen = this.newLabel();
        const labelEnd = this.newLabel();
        this.visitExpr(node.test, locals, ops);
        this.emit(ops, 'IF_GOTO', labelThen);
        if (node.alternate) {
          this.visitStmt(node.alternate, locals, ops);
        }
        this.emit(ops, 'GOTO', labelEnd);
        this.emit(ops, 'LABEL', labelThen);
        this.visitStmt(node.consequent, locals, ops);
        this.emit(ops, 'LABEL', labelEnd);
        break;
      }

      case 'LoopStatement': {
        this.emitComment(ops, node);
        const labelStart = this.newLabel();
        const labelEnd = this.newLabel();
        this.loopStack.push({ start: labelStart, end: labelEnd });
        this.emit(ops, 'LABEL', labelStart);
        this.visitStmt(node.body, locals, ops);
        this.emit(ops, 'GOTO', labelStart);
        this.emit(ops, 'LABEL', labelEnd);
        this.loopStack.pop();
        break;
      }

      case 'BreakStatement':
        this.emitComment(ops, node);
        if (this.loopStack.length === 0) throw new Error('Break outside of loop');
        this.emit(ops, 'GOTO', this.loopStack[this.loopStack.length - 1].end);
        break;

      case 'ContinueStatement':
        this.emitComment(ops, node);
        if (this.loopStack.length === 0) throw new Error('Continue outside of loop');
        this.emit(ops, 'GOTO', this.loopStack[this.loopStack.length - 1].start);
        break;

      case 'BlockStatement':
        this.visitBlock(node.body, locals, ops);
        break;

      case 'ExpressionStatement':
        this.emitComment(ops, node);
        this.visitExpr(node.expression, locals, ops);
        if (this.returnsValue(node.expression)) {
          this.emit(ops, 'POP');
        }
        break;

      default:
        throw new Error(`Unknown statement type: ${node.type}`);
    }
  }

  visitExpr(node, locals, ops) {
    switch (node.type) {
      case 'Literal':
        this.emit(ops, 'CONST', node.value);
        break;

      case 'Identifier':
        if (this.constants.has(node.name)) {
          this.emit(ops, 'CONST', this.constants.get(node.name));
        } else if (this.dataDecls.has(node.name)) {
          this.emit(ops, 'DATA_ADDR', node.name);
        } else if (locals.has(node.name)) {
          this.emit(ops, 'LOAD', locals.get(node.name));
        } else {
          this.emit(ops, 'GET', node.name);
        }
        break;

      case 'SizeofExpression':
        if (!this.dataDecls.has(node.name)) {
          throw new Error(`sizeof: unknown data declaration '${node.name}'`);
        }
        this.emit(ops, 'CONST', this.dataDecls.get(node.name).length);
        break;

      case 'AssignmentExpression':
        this.visitExpr(node.right, locals, ops);
        if (node.left.type !== 'Identifier') throw new Error('Invalid assignment target');
        if (this.dataDecls.has(node.left.name)) {
          throw new Error(`Cannot assign to data declaration '${node.left.name}'`);
        }
        if (locals.has(node.left.name)) {
          this.emit(ops, 'SAVE', locals.get(node.left.name));
        } else {
          this.emit(ops, 'PUT', node.left.name);
        }
        break;

      case 'BinaryExpression':
        this.visitExpr(node.left, locals, ops);
        this.visitExpr(node.right, locals, ops);
        this.emit(ops, this.getBinaryOp(node.operator));
        break;

      case 'UnaryExpression':
        this.visitExpr(node.argument, locals, ops);
        this.emit(ops, this.getUnaryOp(node.operator));
        break;

      case 'TernaryExpression': {
        const labelTrue = this.newLabel();
        const labelEnd = this.newLabel();
        this.visitExpr(node.condition, locals, ops);
        this.emit(ops, 'IF_GOTO', labelTrue);
        this.visitExpr(node.falseExpr, locals, ops);
        this.emit(ops, 'GOTO', labelEnd);
        this.emit(ops, 'LABEL', labelTrue);
        this.visitExpr(node.trueExpr, locals, ops);
        this.emit(ops, 'LABEL', labelEnd);
        break;
      }

      case 'CallExpression': {
        const builtins = {
          'peek': 'PEEK', 'poke': 'POKE',
          'peek16': 'PEEK16', 'poke16': 'POKE16',
          'peek8': 'PEEK8', 'poke8': 'POKE8',
        };
        for (const arg of node.arguments) {
          this.visitExpr(arg, locals, ops);
        }
        if (builtins[node.callee]) {
          this.emit(ops, builtins[node.callee]);
        } else {
          this.emit(ops, 'CALL', node.callee, node.arguments.length);
        }
        break;
      }

      default:
        throw new Error(`Unknown expression type: ${node.type}`);
    }
  }

  getBinaryOp(op) {
    const ops = {
      '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD',
      '&': 'AND', '|': 'OR', '^': 'XOR',
      '<<': 'LSHIFT', '>>': 'RSHIFT',
      '==': 'EQ', '!=': 'NE', '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE',
      '&&': 'LAND', '||': 'LOR',
    };
    return ops[op] || op;
  }

  getUnaryOp(op) {
    const ops = { '+': 'NOP', '-': 'NEG', '~': 'NOT', '!': 'LNOT' };
    return ops[op] || op;
  }
}

if (typeof module !== 'undefined') {
  module.exports = { StackGenerator };
}
