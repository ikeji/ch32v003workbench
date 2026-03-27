
/**
 * RV32E Disassembler for TinyC
 */

const REV_REG_MAP = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
  's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5'
];

class Disassembler {
  constructor() {
    this.buffer = null;
  }

  disassemble(hexdump) {
    this.buffer = this.parseHexdump(hexdump);
    let output = [];

    for (let pc = 0; pc < this.buffer.length; pc += 4) {
      if (pc + 4 > this.buffer.length) break;
      const word = this.read32(pc);
      const decoded = this.decode(word, pc);

      // objdump形式: "  addr:\twordHex\t\tmnemonic\toperands"
      const wordHex = (word >>> 0).toString(16).padStart(8, '0');
      const addrStr = pc.toString(16).padStart(4, ' ');
      const spaceIdx = decoded.indexOf(' ');
      const instrStr = spaceIdx === -1
        ? decoded
        : `${decoded.slice(0, spaceIdx)}\t${decoded.slice(spaceIdx + 1)}`;

      output.push(`${addrStr}:\t${wordHex}          \t${instrStr}`);
    }

    return output.join('\n');
  }

  parseHexdump(hexdump) {
    const bytes = [];
    const lines = hexdump.split('\n');
    lines.forEach(line => {
      const parts = line.split(':');
      if (parts.length < 2) return;
      const hexParts = parts[1].trim().split(/\s+/);
      hexParts.forEach(hp => {
        if (hp.length === 2) bytes.push(parseInt(hp, 16));
      });
    });
    return new Uint8Array(bytes);
  }

  read32(pc) {
    return this.buffer[pc] | (this.buffer[pc+1] << 8) | (this.buffer[pc+2] << 16) | (this.buffer[pc+3] << 24);
  }

  decode(w, pc) {
    const op = w & 0x7f;
    const rd = (w >> 7) & 0x1f;
    const f3 = (w >> 12) & 0x7;
    const rs1 = (w >> 15) & 0x1f;
    const rs2 = (w >> 20) & 0x1f;
    const f7 = (w >> 25) & 0x7f;

    const r = (idx) => REV_REG_MAP[idx] || `x${idx}`;
    const sext = (v, bits) => (v << (32 - bits)) >> (32 - bits);

    const imm_i = sext(w >> 20, 12);
    const imm_s = sext(((w >> 7) & 0x1f) | ((w >> 25) << 5), 12);
    const imm_b = sext(((w >> 8) & 0xf) << 1 | ((w >> 25) & 0x3f) << 5 | ((w >> 7) & 0x1) << 11 | (w >> 31) << 12, 13);
    const imm_j = sext(((w >> 21) & 0x3ff) << 1 | ((w >> 20) & 0x1) << 11 | ((w >> 12) & 0xff) << 12 | (w >> 31) << 20, 21);
    const imm_u = (w >>> 12) & 0xfffff;

    const tgt = (v) => "0x" + ((pc + v) >>> 0).toString(16);

    switch (op) {
      case 0x37: // LUI
        return `lui ${r(rd)},0x${imm_u.toString(16)}`;

      case 0x33: { // R-type (f3 + f7 で命令を特定)
        if (f3 === 0x0 && f7 === 0x00) return `add ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x0 && f7 === 0x20) return `sub ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x0 && f7 === 0x01) return `mul ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x7 && f7 === 0x00) return `and ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x6 && f7 === 0x00) return `or ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x4 && f7 === 0x00) return `xor ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x1 && f7 === 0x00) return `sll ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x5 && f7 === 0x00) return `srl ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x3 && f7 === 0x00) return `sltu ${r(rd)},${r(rs1)},${r(rs2)}`;
        return `unknown_r ${r(rd)},${r(rs1)},${r(rs2)}`;
      }

      case 0x13: // I-type ALU
        if (f3 === 0x0) {
          if (rs1 === 0) return `li ${r(rd)},${imm_i}`;
          if (imm_i === 0) return `mv ${r(rd)},${r(rs1)}`;
          return `addi ${r(rd)},${r(rs1)},${imm_i}`;
        }
        if (f3 === 0x4) {
          if (imm_i === -1) return `not ${r(rd)},${r(rs1)}`;
          return `xori ${r(rd)},${r(rs1)},${imm_i}`;
        }
        if (f3 === 0x3) {
          if (imm_i === 1) return `seqz ${r(rd)},${r(rs1)}`;
          return `sltiu ${r(rd)},${r(rs1)},${imm_i}`;
        }
        return `unknown_i ${r(rd)},${r(rs1)},${imm_i}`;

      case 0x03: // Load
        if (f3 === 0x2) return `lw ${r(rd)},${imm_i}(${r(rs1)})`;
        if (f3 === 0x5) return `lhu ${r(rd)},${imm_i}(${r(rs1)})`;
        if (f3 === 0x4) return `lbu ${r(rd)},${imm_i}(${r(rs1)})`;
        return `unknown_l ${r(rd)},${imm_i}(${r(rs1)})`;

      case 0x23: // Store
        if (f3 === 0x2) return `sw ${r(rs2)},${imm_s}(${r(rs1)})`;
        if (f3 === 0x1) return `sh ${r(rs2)},${imm_s}(${r(rs1)})`;
        if (f3 === 0x0) return `sb ${r(rs2)},${imm_s}(${r(rs1)})`;
        return `unknown_s ${r(rs2)},${imm_s}(${r(rs1)})`;

      case 0x63: // Branch
        if (f3 === 0x0) {
          if (rs2 === 0) return `beqz ${r(rs1)},${tgt(imm_b)}`;
          return `beq ${r(rs1)},${r(rs2)},${tgt(imm_b)}`;
        }
        if (f3 === 0x1) {
          if (rs2 === 0) return `bnez ${r(rs1)},${tgt(imm_b)}`;
          return `bne ${r(rs1)},${r(rs2)},${tgt(imm_b)}`;
        }
        return `unknown_b ${r(rs1)},${r(rs2)},${tgt(imm_b)}`;

      case 0x6f: // JAL
        if (rd === 0) return `j ${tgt(imm_j)}`;
        return `jal ${r(rd)},${tgt(imm_j)}`;

      case 0x67: // JALR
        if (rd === 0 && rs1 === 1 && imm_i === 0) return `ret`;
        return `jalr ${r(rd)},${r(rs1)},${imm_i}`;

      default:
        return `.word 0x${(w >>> 0).toString(16).padStart(8, '0')}`;
    }
  }
}

if (typeof module !== 'undefined') {
  module.exports = { Disassembler };
}
