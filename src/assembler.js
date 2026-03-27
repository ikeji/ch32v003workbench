
/**
 * Advanced RV32E Assembler for TinyC (Robust Section/Pseudo Handling)
 */

const CSR_MAP = {
  mstatus: 0x300, misa: 0x301, mtvec: 0x305,
  mscratch: 0x340, mepc: 0x341, mcause: 0x342, mtval: 0x343
};

const REG_MAP = {
  zero: 0, x0: 0, ra: 1, x1: 1, sp: 2, x2: 2, gp: 3, x3: 3,
  tp: 4, x4: 4, t0: 5, x5: 5, t1: 6, x6: 6, t2: 7, x7: 7,
  s0: 8, fp: 8, x8: 8, s1: 9, x9: 9, a0: 10, x10: 10, a1: 11, x11: 11,
  a2: 12, x12: 12, a3: 13, x13: 13, a4: 14, x14: 14, a5: 15, x15: 15
};

class Assembler {
  constructor() {
    this.symbols = {};
    this.buffer = new Uint8Array(16384);
    this.pc = 0;
  }

  assemble(source) {
    const lines = source.split('\n')
      .map(l => l.replace(/#.*/, '').trim())
      .filter(l => l.length > 0);
    
    const parsedLines = lines.map(line => {
      const labelMatch = line.match(/^([\w\.]+):/);
      let label = null;
      let content = line;
      if (labelMatch) {
        label = labelMatch[1];
        content = line.slice(labelMatch[0].length).trim();
      }
      return { label, content };
    });

    // Pass 1: PC determination
    this.pc = 0;
    parsedLines.forEach(ln => {
      if (ln.label) this.symbols[ln.label] = this.pc;
      if (ln.content.length === 0) return;
      ln.addr = this.pc;
      const parts = ln.content.split(/[,\s]+/).filter(p => p.length > 0);
      if (parts[0] === 'la' || parts[0] === 'li') {
        const val = this.parseVal(parts[2]);
        if (val === undefined || val < -2048 || val > 2047) {
          // リテラル値で下位12ビットがゼロの場合はluiのみ(4バイト)
          // >>> 0 で符号なし32bitに統一(ビット31が立つ値でもlowerが正しく0になる)
          if (val !== undefined && (((val + 0x800) & 0xfffff000) >>> 0) === val) {
            this.pc += 4; ln.size = 4; return;
          }
          this.pc += 8;
          ln.size = 8;
          return;
        }
      }
      if (parts[0] === '.word') {
        this.pc += 4; ln.size = 4;
      } else if (parts[0].startsWith('.')) {
        ln.size = 0;
      } else {
        this.pc += 4; ln.size = 4;
      }
    });

    // Pass 2: Generation
    this.pc = 0;
    parsedLines.forEach(ln => {
      if (ln.content.length === 0) return;
      const parts = ln.content.split(/[,\s]+/).filter(p => p.length > 0);
      const op = parts[0];
      const args = parts.slice(1);

      if (op === '.word') {
        this.write32(this.parseVal(args[0]));
        return;
      }
      if (op.startsWith('.')) return;

      const codes = this.encode(op, args, ln.addr);
      if (Array.isArray(codes)) codes.forEach(c => this.write32(c));
      else if (codes !== null) this.write32(codes);
    });

    return this.hexdump();
  }

  parseVal(val) {
    if (val === undefined) return undefined;
    if (this.symbols[val] !== undefined) return this.symbols[val];
    if (val.startsWith('0x')) return parseInt(val, 16);
    if (val.startsWith('0b')) return parseInt(val.slice(2), 2);
    return parseInt(val);
  }

  write32(val) {
    this.buffer[this.pc++] = val & 0xff;
    this.buffer[this.pc++] = (val >> 8) & 0xff;
    this.buffer[this.pc++] = (val >> 16) & 0xff;
    this.buffer[this.pc++] = (val >> 24) & 0xff;
  }

  encode(op, args, currentPc) {
    const r = (name) => {
      const reg = REG_MAP[name];
      if (reg === undefined) throw new Error(`Unknown register: ${name}`);
      return reg;
    };
    const imm = (val) => {
      const result = this.parseVal(val);
      if (result === undefined) throw new Error(`Undefined symbol: ${val}`);
      return result;
    };

    switch (op) {
      case 'add': return this.fmtR(0x33, 0x0, 0x00, r(args[0]), r(args[1]), r(args[2]));
      case 'sub': return this.fmtR(0x33, 0x0, 0x20, r(args[0]), r(args[1]), r(args[2]));
      case 'mul': return this.fmtR(0x33, 0x0, 0x01, r(args[0]), r(args[1]), r(args[2]));
      case 'and': return this.fmtR(0x33, 0x7, 0x00, r(args[0]), r(args[1]), r(args[2]));
      case 'or':  return this.fmtR(0x33, 0x6, 0x00, r(args[0]), r(args[1]), r(args[2]));
      case 'xor': return this.fmtR(0x33, 0x4, 0x00, r(args[0]), r(args[1]), r(args[2]));
      case 'sll': return this.fmtR(0x33, 0x1, 0x00, r(args[0]), r(args[1]), r(args[2]));
      case 'srl': return this.fmtR(0x33, 0x5, 0x00, r(args[0]), r(args[1]), r(args[2]));
      case 'sltu': return this.fmtR(0x33, 0x3, 0x00, r(args[0]), r(args[1]), r(args[2]));

      case 'addi': return this.fmtI(0x13, 0x0, r(args[0]), r(args[1]), imm(args[2]));
      case 'xori': return this.fmtI(0x13, 0x4, r(args[0]), r(args[1]), imm(args[2]));
      case 'sltiu': return this.fmtI(0x13, 0x3, r(args[0]), r(args[1]), imm(args[2]));
      case 'lui': return this.fmtU(0x37, r(args[0]), imm(args[1]) << 12);

      case 'lw': {
        const m = args[1].match(/(-?\d+)\((.+)\)/);
        return m ? this.fmtI(0x03, 0x2, r(args[0]), r(m[2]), parseInt(m[1])) : this.fmtI(0x03, 0x2, r(args[0]), r(args[1]), imm(args[2]));
      }
      case 'lhu': {
        const m = args[1].match(/(-?\d+)\((.+)\)/);
        return m ? this.fmtI(0x03, 0x5, r(args[0]), r(m[2]), parseInt(m[1])) : this.fmtI(0x03, 0x5, r(args[0]), r(args[1]), imm(args[2]));
      }
      case 'lbu': {
        const m = args[1].match(/(-?\d+)\((.+)\)/);
        return m ? this.fmtI(0x03, 0x4, r(args[0]), r(m[2]), parseInt(m[1])) : this.fmtI(0x03, 0x4, r(args[0]), r(args[1]), imm(args[2]));
      }
      case 'sw': {
        const m = args[1].match(/(-?\d+)\((.+)\)/);
        return m ? this.fmtS(0x23, 0x2, r(m[2]), r(args[0]), parseInt(m[1])) : this.fmtS(0x23, 0x2, r(args[1]), r(args[0]), imm(args[2]));
      }
      case 'sh': {
        const m = args[1].match(/(-?\d+)\((.+)\)/);
        return m ? this.fmtS(0x23, 0x1, r(m[2]), r(args[0]), parseInt(m[1])) : this.fmtS(0x23, 0x1, r(args[1]), r(args[0]), imm(args[2]));
      }
      case 'sb': {
        const m = args[1].match(/(-?\d+)\((.+)\)/);
        return m ? this.fmtS(0x23, 0x0, r(m[2]), r(args[0]), parseInt(m[1])) : this.fmtS(0x23, 0x0, r(args[1]), r(args[0]), imm(args[2]));
      }

      case 'beq':  return this.fmtB(0x63, 0x0, r(args[0]), r(args[1]), imm(args[2]) - currentPc);
      case 'bne':  return this.fmtB(0x63, 0x1, r(args[0]), r(args[1]), imm(args[2]) - currentPc);
      case 'bnez': return this.fmtB(0x63, 0x1, r(args[0]), 0, imm(args[1]) - currentPc);
      case 'jal': return this.fmtJ(0x6F, r(args[0]), imm(args[1]) - currentPc);

      case 'li':
      case 'la': {
        const val = imm(args[1]);
        if (val >= -2048 && val <= 2047) return this.fmtI(0x13, 0x0, r(args[0]), 0, val);
        let upper = ((val + 0x800) & 0xfffff000) >>> 0;
        let lower = val - upper;
        // シンボルの場合はpass1で8バイト確保済みなので常にlui+addiを出す
        // リテラルで下位12ビット=0の場合はluiのみ(pass1と整合)
        const isSymbol = this.symbols[args[1]] !== undefined;
        if (lower === 0 && !isSymbol) return this.fmtU(0x37, r(args[0]), upper);
        return [this.fmtU(0x37, r(args[0]), upper), this.fmtI(0x13, 0x0, r(args[0]), r(args[0]), lower)];
      }
      case 'j':   return this.fmtJ(0x6F, 0, imm(args[0]) - currentPc);
      case 'ret': return this.fmtI(0x67, 0x0, 0, 1, 0);
      case 'seqz': return this.fmtI(0x13, 0x3, r(args[0]), r(args[1]), 1);
      case 'snez': return this.fmtR(0x33, 0x3, 0x00, r(args[0]), 0, r(args[1]));
      case 'not':  return this.fmtI(0x13, 0x4, r(args[0]), r(args[1]), -1);
      case 'mv':   return this.fmtI(0x13, 0x0, r(args[0]), r(args[1]), 0);
      case 'neg':  return this.fmtR(0x33, 0x0, 0x20, r(args[0]), 0, r(args[1]));
      case 'divu': return this.fmtR(0x33, 0x5, 0x01, r(args[0]), r(args[1]), r(args[2]));
      case 'remu': return this.fmtR(0x33, 0x7, 0x01, r(args[0]), r(args[1]), r(args[2]));

      // CSR instructions (opcode 0x73)
      case 'csrw': {
        const csrAddr = CSR_MAP[args[0]] !== undefined ? CSR_MAP[args[0]] : imm(args[0]);
        return this.fmtI(0x73, 0x1, 0, r(args[1]), csrAddr);
      }
      case 'csrr': {
        const csrAddr = CSR_MAP[args[1]] !== undefined ? CSR_MAP[args[1]] : imm(args[1]);
        return this.fmtI(0x73, 0x2, r(args[0]), 0, csrAddr);
      }
      case 'mret': return 0x30200073;

      default: throw new Error(`Unknown instruction: ${op}`);
    }
  }

  fmtR(op, f3, f7, rd, r1, r2) { return op | (rd << 7) | (f3 << 12) | (r1 << 15) | (r2 << 20) | (f7 << 25); }
  fmtI(op, f3, rd, r1, imm) { return op | (rd << 7) | (f3 << 12) | (r1 << 15) | ((imm & 0xfff) << 20); }
  fmtS(op, f3, r1, r2, imm) { return op | ((imm & 0x1f) << 7) | (f3 << 12) | (r1 << 15) | (r2 << 20) | (((imm >> 5) & 0x7f) << 25); }
  fmtB(op, f3, r1, r2, imm) {
    return op | (((imm >> 11) & 1) << 7) | (((imm >> 1) & 0xf) << 8) | (f3 << 12) | (r1 << 15) | (r2 << 20) | (((imm >> 5) & 0x3f) << 25) | (((imm >> 12) & 1) << 31);
  }
  fmtJ(op, rd, imm) {
    return op | (rd << 7) | (((imm >> 12) & 0xff) << 12) | (((imm >> 11) & 1) << 20) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 20) & 1) << 31);
  }
  fmtU(op, rd, imm) { return op | (rd << 7) | (imm & 0xfffff000); }

  hexdump() {
    let out = "";
    for (let i = 0; i < this.pc; i += 16) {
      out += i.toString(16).padStart(8, '0') + ": ";
      for (let j = 0; j < 16 && i + j < this.pc; j++) {
        out += this.buffer[i + j].toString(16).padStart(2, '0') + " ";
      }
      out += "\n";
    }
    return out;
  }
}

if (typeof module !== 'undefined') {
  module.exports = { Assembler };
}
