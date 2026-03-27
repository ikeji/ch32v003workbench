
/**
 * RV32EC Disassembler — supports 32-bit and 16-bit compressed (RVC) instructions
 */

const REV_REG_MAP = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
  's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
  's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'
];

const CSR_NAMES = {
  0x000: 'ustatus', 0x001: 'fflags', 0x002: 'frm', 0x003: 'fcsr',
  0x300: 'mstatus', 0x301: 'misa', 0x302: 'medeleg', 0x303: 'mideleg',
  0x304: 'mie', 0x305: 'mtvec', 0x306: 'mcounteren', 0x310: 'mstatush',
  0x340: 'mscratch', 0x341: 'mepc', 0x342: 'mcause', 0x343: 'mtval',
  0x344: 'mip', 0x3A0: 'pmpcfg0', 0x3B0: 'pmpaddr0',
  0xB00: 'mcycle', 0xB02: 'minstret', 0xB80: 'mcycleh', 0xB82: 'minstreth',
  0xC00: 'cycle', 0xC01: 'time', 0xC02: 'instret',
  0xC80: 'cycleh', 0xC81: 'timeh', 0xC82: 'instreth',
  0xF11: 'mvendorid', 0xF12: 'marchid', 0xF13: 'mimpid', 0xF14: 'mhartid',
};

class Disassembler {
  constructor() {
    this.buffer = null;
  }

  disassemble(hexdump) {
    this.buffer = this.parseHexdump(hexdump);
    const output = [];
    let pc = 0;

    while (pc < this.buffer.length) {
      if (pc + 2 > this.buffer.length) break;
      const lo16 = this.buffer[pc] | (this.buffer[pc + 1] << 8);

      if ((lo16 & 0x3) !== 0x3) {
        // 16-bit compressed instruction
        const decoded = this.decodeC(lo16, pc);
        const addrStr = pc.toString(16).padStart(4, ' ');
        const wordHex = (lo16 & 0xffff).toString(16).padStart(4, '0');
        const spaceIdx = decoded.indexOf(' ');
        const instrStr = spaceIdx === -1
          ? decoded
          : `${decoded.slice(0, spaceIdx)}\t${decoded.slice(spaceIdx + 1)}`;
        output.push(`${addrStr}:\t${wordHex}      \t${instrStr}`);
        pc += 2;
      } else {
        // 32-bit instruction
        if (pc + 4 > this.buffer.length) break;
        const word = this.read32(pc);
        const decoded = this.decode(word, pc);
        const addrStr = pc.toString(16).padStart(4, ' ');
        const wordHex = (word >>> 0).toString(16).padStart(8, '0');
        const spaceIdx = decoded.indexOf(' ');
        const instrStr = spaceIdx === -1
          ? decoded
          : `${decoded.slice(0, spaceIdx)}\t${decoded.slice(spaceIdx + 1)}`;
        output.push(`${addrStr}:\t${wordHex}          \t${instrStr}`);
        pc += 4;
      }
    }

    return output.join('\n');
  }

  parseHexdump(hexdump) {
    const bytes = [];
    const lines = hexdump.split('\n');
    lines.forEach(line => {
      const parts = line.split(':');
      if (parts.length < 2) return;
      const hexParts = parts[1].trim().split(/\s+/).slice(0, 16);
      hexParts.forEach(hp => {
        bytes.push(parseInt(hp, 16));
      });
    });
    return new Uint8Array(bytes);
  }

  read32(pc) {
    return this.buffer[pc] | (this.buffer[pc+1] << 8) | (this.buffer[pc+2] << 16) | (this.buffer[pc+3] << 24);
  }

  // ── 32-bit instruction decoder ──────────────────────────────────────────────

  decode(w, pc) {
    const op  = w & 0x7f;
    const rd  = (w >> 7)  & 0x1f;
    const f3  = (w >> 12) & 0x7;
    const rs1 = (w >> 15) & 0x1f;
    const rs2 = (w >> 20) & 0x1f;
    const f7  = (w >> 25) & 0x7f;

    const r    = (idx) => REV_REG_MAP[idx] || `x${idx}`;
    const sext = (v, bits) => (v << (32 - bits)) >> (32 - bits);

    const imm_i = sext(w >> 20, 12);
    const imm_s = sext(((w >> 7) & 0x1f) | ((w >> 25) << 5), 12);
    const imm_b = sext(((w >> 8) & 0xf) << 1 | ((w >> 25) & 0x3f) << 5 | ((w >> 7) & 0x1) << 11 | (w >> 31) << 12, 13);
    const imm_j = sext(((w >> 21) & 0x3ff) << 1 | ((w >> 20) & 0x1) << 11 | ((w >> 12) & 0xff) << 12 | (w >> 31) << 20, 21);
    const imm_u = (w >>> 12) & 0xfffff;

    const tgt = (v) => '0x' + ((pc + v) >>> 0).toString(16);

    switch (op) {
      case 0x37: // LUI
        return `lui ${r(rd)},0x${imm_u.toString(16)}`;

      case 0x17: // AUIPC
        return `auipc ${r(rd)},0x${imm_u.toString(16)}`;

      case 0x33: { // R-type
        if (f3 === 0x0 && f7 === 0x00) return `add ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x0 && f7 === 0x20) {
          if (rs1 === 0) return `neg ${r(rd)},${r(rs2)}`;
          return `sub ${r(rd)},${r(rs1)},${r(rs2)}`;
        }
        if (f3 === 0x0 && f7 === 0x01) return `mul ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x1 && f7 === 0x00) return `sll ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x2 && f7 === 0x00) return `slt ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x3 && f7 === 0x00) return `sltu ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x4 && f7 === 0x00) return `xor ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x5 && f7 === 0x00) return `srl ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x5 && f7 === 0x20) return `sra ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x6 && f7 === 0x00) return `or ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x7 && f7 === 0x00) return `and ${r(rd)},${r(rs1)},${r(rs2)}`;
        // M-extension
        if (f3 === 0x1 && f7 === 0x01) return `mulh ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x2 && f7 === 0x01) return `mulhsu ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x3 && f7 === 0x01) return `mulhu ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x4 && f7 === 0x01) return `div ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x5 && f7 === 0x01) return `divu ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x6 && f7 === 0x01) return `rem ${r(rd)},${r(rs1)},${r(rs2)}`;
        if (f3 === 0x7 && f7 === 0x01) return `remu ${r(rd)},${r(rs1)},${r(rs2)}`;
        return `.word 0x${(w >>> 0).toString(16).padStart(8, '0')}`;
      }

      case 0x13: { // I-type ALU
        const shamt = (w >> 20) & 0x1f;
        if (f3 === 0x0) {
          if (rs1 === 0) return `li ${r(rd)},${imm_i}`;
          if (imm_i === 0) return `mv ${r(rd)},${r(rs1)}`;
          return `addi ${r(rd)},${r(rs1)},${imm_i}`;
        }
        if (f3 === 0x1 && f7 === 0x00) return `slli ${r(rd)},${r(rs1)},0x${shamt.toString(16)}`;
        if (f3 === 0x2) return `slti ${r(rd)},${r(rs1)},${imm_i}`;
        if (f3 === 0x3) {
          if (imm_i === 1) return `seqz ${r(rd)},${r(rs1)}`;
          return `sltiu ${r(rd)},${r(rs1)},${imm_i}`;
        }
        if (f3 === 0x4) {
          if (imm_i === -1) return `not ${r(rd)},${r(rs1)}`;
          return `xori ${r(rd)},${r(rs1)},${imm_i}`;
        }
        if (f3 === 0x5 && f7 === 0x00) return `srli ${r(rd)},${r(rs1)},0x${shamt.toString(16)}`;
        if (f3 === 0x5 && f7 === 0x20) return `srai ${r(rd)},${r(rs1)},0x${shamt.toString(16)}`;
        if (f3 === 0x6) return `ori ${r(rd)},${r(rs1)},${imm_i}`;
        if (f3 === 0x7) return `andi ${r(rd)},${r(rs1)},${imm_i}`;
        return `.word 0x${(w >>> 0).toString(16).padStart(8, '0')}`;
      }

      case 0x03: // Load
        if (f3 === 0x0) return `lb ${r(rd)},${imm_i}(${r(rs1)})`;
        if (f3 === 0x1) return `lh ${r(rd)},${imm_i}(${r(rs1)})`;
        if (f3 === 0x2) return `lw ${r(rd)},${imm_i}(${r(rs1)})`;
        if (f3 === 0x4) return `lbu ${r(rd)},${imm_i}(${r(rs1)})`;
        if (f3 === 0x5) return `lhu ${r(rd)},${imm_i}(${r(rs1)})`;
        return `.word 0x${(w >>> 0).toString(16).padStart(8, '0')}`;

      case 0x23: // Store
        if (f3 === 0x0) return `sb ${r(rs2)},${imm_s}(${r(rs1)})`;
        if (f3 === 0x1) return `sh ${r(rs2)},${imm_s}(${r(rs1)})`;
        if (f3 === 0x2) return `sw ${r(rs2)},${imm_s}(${r(rs1)})`;
        return `.word 0x${(w >>> 0).toString(16).padStart(8, '0')}`;

      case 0x63: { // Branch
        const bop = (rs2 === 0)
          ? { 0x0: 'beqz', 0x1: 'bnez', 0x4: 'bltz', 0x5: 'bgez', 0x6: 'bltuz', 0x7: 'bgeuz' }
          : {};
        if (f3 === 0x0) return rs2 === 0 ? `beqz ${r(rs1)},${tgt(imm_b)}` : `beq ${r(rs1)},${r(rs2)},${tgt(imm_b)}`;
        if (f3 === 0x1) return rs2 === 0 ? `bnez ${r(rs1)},${tgt(imm_b)}` : `bne ${r(rs1)},${r(rs2)},${tgt(imm_b)}`;
        if (f3 === 0x4) return rs2 === 0 ? `bltz ${r(rs1)},${tgt(imm_b)}` : `blt ${r(rs1)},${r(rs2)},${tgt(imm_b)}`;
        if (f3 === 0x5) return rs2 === 0 ? `bgez ${r(rs1)},${tgt(imm_b)}` : `bge ${r(rs1)},${r(rs2)},${tgt(imm_b)}`;
        if (f3 === 0x6) return `bltu ${r(rs1)},${r(rs2)},${tgt(imm_b)}`;
        if (f3 === 0x7) return `bgeu ${r(rs1)},${r(rs2)},${tgt(imm_b)}`;
        return `.word 0x${(w >>> 0).toString(16).padStart(8, '0')}`;
      }

      case 0x6f: // JAL
        if (rd === 0) return `j ${tgt(imm_j)}`;
        if (rd === 1) return `jal ${tgt(imm_j)}`;
        return `jal ${r(rd)},${tgt(imm_j)}`;

      case 0x67: // JALR
        if (rd === 0 && rs1 === 1 && imm_i === 0) return `ret`;
        if (rd === 0 && imm_i === 0) return `jr ${r(rs1)}`;
        if (rd === 1 && imm_i === 0) return `jalr ${r(rs1)}`;
        return `jalr ${r(rd)},${r(rs1)},${imm_i}`;

      case 0x73: { // SYSTEM (CSR / ECALL / EBREAK / MRET ...)
        if (w === 0x00000073) return 'ecall';
        if (w === 0x00100073) return 'ebreak';
        if (w === 0x30200073) return 'mret';
        if (w === 0x10200073) return 'sret';
        if (w === 0x00200073) return 'uret';
        if (w === 0x10500073) return 'wfi';
        const csr = (w >>> 20) & 0xfff;
        const csrName = CSR_NAMES[csr] || `0x${csr.toString(16)}`;
        if (f3 === 0x1) {
          if (rd === 0) return `csrw ${csrName},${r(rs1)}`;
          return `csrrw ${r(rd)},${csrName},${r(rs1)}`;
        }
        if (f3 === 0x2) {
          if (rs1 === 0) return `csrr ${r(rd)},${csrName}`;
          return `csrrs ${r(rd)},${csrName},${r(rs1)}`;
        }
        if (f3 === 0x3) {
          if (rs1 === 0) return `csrr ${r(rd)},${csrName}`;
          return `csrrc ${r(rd)},${csrName},${r(rs1)}`;
        }
        if (f3 === 0x5) return `csrrwi ${r(rd)},${csrName},${rs1}`;
        if (f3 === 0x6) return `csrrsi ${r(rd)},${csrName},${rs1}`;
        if (f3 === 0x7) return `csrrci ${r(rd)},${csrName},${rs1}`;
        return `.word 0x${(w >>> 0).toString(16).padStart(8, '0')}`;
      }

      default:
        return `.word 0x${(w >>> 0).toString(16).padStart(8, '0')}`;
    }
  }

  // ── 16-bit RVC instruction decoder ─────────────────────────────────────────

  decodeC(w, pc) {
    const quadrant = w & 0x3;
    const funct3   = (w >> 13) & 0x7;
    // "prime" registers: 3-bit field → x8..x15
    const rc  = (idx) => REV_REG_MAP[8 + (idx & 0x7)];
    const r   = (idx) => REV_REG_MAP[idx & 0x1f] || `x${idx & 0x1f}`;
    const hex = () => `.2byte 0x${(w & 0xffff).toString(16).padStart(4, '0')}`;
    const tgt = (v) => '0x' + ((pc + v) >>> 0).toString(16);

    // Common 6-bit sign-extended immediate from bits [12,6:2]
    const simm6 = (((w >> 12) & 1) << 5 | ((w >> 2) & 0x1f)) << 26 >> 26;

    if (quadrant === 0x0) {
      const rd_  = (w >> 2) & 0x7;
      const rs1_ = (w >> 7) & 0x7;
      const rs2_ = (w >> 2) & 0x7;

      if (w === 0x0000) return 'unimp';

      if (funct3 === 0x0) { // c.addi4spn  rd', sp, nzuimm
        const uimm = (((w >> 11) & 0x3) << 4) | (((w >> 7) & 0xf) << 6) |
                     (((w >> 6) & 0x1) << 2)  | (((w >> 5) & 0x1) << 3);
        if (uimm === 0) return hex();
        return `c.addi4spn ${rc(rd_)},sp,${uimm}`;
      }
      if (funct3 === 0x2) { // c.lw  rd', uimm(rs1')
        const uimm = (((w >> 10) & 0x7) << 3) | (((w >> 6) & 0x1) << 2) | (((w >> 5) & 0x1) << 6);
        return `c.lw ${rc(rd_)},${uimm}(${rc(rs1_)})`;
      }
      if (funct3 === 0x6) { // c.sw  rs2', uimm(rs1')
        const uimm = (((w >> 10) & 0x7) << 3) | (((w >> 6) & 0x1) << 2) | (((w >> 5) & 0x1) << 6);
        return `c.sw ${rc(rs2_)},${uimm}(${rc(rs1_)})`;
      }
      return hex();
    }

    if (quadrant === 0x1) {
      const rd  = (w >> 7) & 0x1f;
      const rs1_= (w >> 7) & 0x7;
      const rs2_= (w >> 2) & 0x7;

      if (funct3 === 0x0) { // c.nop / c.addi
        if (rd === 0) return 'c.nop';
        return `c.addi ${r(rd)},${simm6}`;
      }
      if (funct3 === 0x1) { // c.jal (RV32 only)
        const off = (((w >> 12) & 1) << 11) | (((w >> 11) & 1) << 4) |
                    (((w >>  9) & 3) <<  8) | (((w >>  8) & 1) << 10) |
                    (((w >>  7) & 1) <<  6) | (((w >>  6) & 1) <<  7) |
                    (((w >>  3) & 7) <<  1) | (((w >>  2) & 1) <<  5);
        const soff = (off << 20) >> 20;
        return `c.jal ${tgt(soff)}`;
      }
      if (funct3 === 0x2) { // c.li
        return `c.li ${r(rd)},${simm6}`;
      }
      if (funct3 === 0x3) {
        if (rd === 2) { // c.addi16sp
          const nzimm = (((w >> 12) & 1) << 9) | (((w >> 6) & 1) << 4) |
                        (((w >>  5) & 1) << 6) | (((w >> 3) & 3) << 7) |
                        (((w >>  2) & 1) << 5);
          const snzimm = (nzimm << 22) >> 22;
          return `c.addi16sp sp,${snzimm}`;
        }
        // c.lui
        return `c.lui ${r(rd)},0x${(simm6 & 0xfffff).toString(16)}`;
      }
      if (funct3 === 0x4) {
        const funct2 = (w >> 10) & 0x3;
        const shamt  = (((w >> 12) & 1) << 5) | ((w >> 2) & 0x1f);
        if (funct2 === 0x0) return `c.srli ${rc(rs1_)},${shamt}`;
        if (funct2 === 0x1) return `c.srai ${rc(rs1_)},${shamt}`;
        if (funct2 === 0x2) return `c.andi ${rc(rs1_)},${simm6}`;
        if (funct2 === 0x3) {
          const f1   = (w >> 12) & 0x1;
          const f2b  = (w >>  5) & 0x3;
          const rs2i = (w >>  2) & 0x7;
          if (f1 === 0) {
            if (f2b === 0x0) return `c.sub ${rc(rs1_)},${rc(rs2i)}`;
            if (f2b === 0x1) return `c.xor ${rc(rs1_)},${rc(rs2i)}`;
            if (f2b === 0x2) return `c.or  ${rc(rs1_)},${rc(rs2i)}`;
            if (f2b === 0x3) return `c.and ${rc(rs1_)},${rc(rs2i)}`;
          }
          return hex(); // RV64 subword ops
        }
      }
      if (funct3 === 0x5) { // c.j
        const off = (((w >> 12) & 1) << 11) | (((w >> 11) & 1) << 4) |
                    (((w >>  9) & 3) <<  8) | (((w >>  8) & 1) << 10) |
                    (((w >>  7) & 1) <<  6) | (((w >>  6) & 1) <<  7) |
                    (((w >>  3) & 7) <<  1) | (((w >>  2) & 1) <<  5);
        const soff = (off << 20) >> 20;
        return `c.j ${tgt(soff)}`;
      }
      if (funct3 === 0x6) { // c.beqz
        const off = (((w >> 12) & 1) << 8) | (((w >> 10) & 3) << 3) |
                    (((w >>  5) & 3) << 6) | (((w >>  3) & 3) << 1) |
                    (((w >>  2) & 1) << 5);
        const soff = (off << 23) >> 23;
        return `c.beqz ${rc(rs1_)},${tgt(soff)}`;
      }
      if (funct3 === 0x7) { // c.bnez
        const off = (((w >> 12) & 1) << 8) | (((w >> 10) & 3) << 3) |
                    (((w >>  5) & 3) << 6) | (((w >>  3) & 3) << 1) |
                    (((w >>  2) & 1) << 5);
        const soff = (off << 23) >> 23;
        return `c.bnez ${rc(rs1_)},${tgt(soff)}`;
      }
      return hex();
    }

    if (quadrant === 0x2) {
      const rd  = (w >> 7) & 0x1f;
      const rs2 = (w >>  2) & 0x1f;

      if (funct3 === 0x0) { // c.slli
        const shamt = (((w >> 12) & 1) << 5) | ((w >> 2) & 0x1f);
        return `c.slli ${r(rd)},${shamt}`;
      }
      if (funct3 === 0x2) { // c.lwsp
        const uimm = (((w >> 12) & 1) << 5) | (((w >> 4) & 0x7) << 2) | (((w >> 2) & 0x3) << 6);
        return `c.lwsp ${r(rd)},${uimm}(sp)`;
      }
      if (funct3 === 0x4) {
        const bit12 = (w >> 12) & 0x1;
        if (bit12 === 0) {
          if (rs2 === 0 && rd !== 0) return `c.jr ${r(rd)}`;
          if (rs2 !== 0 && rd !== 0) return `c.mv ${r(rd)},${r(rs2)}`;
          return hex();
        } else {
          if (rd === 0 && rs2 === 0) return 'c.ebreak';
          if (rs2 === 0 && rd !== 0) return `c.jalr ${r(rd)}`;
          if (rs2 !== 0 && rd !== 0) return `c.add ${r(rd)},${r(rs2)}`;
          return hex();
        }
      }
      if (funct3 === 0x6) { // c.swsp
        const uimm = (((w >> 9) & 0xf) << 2) | (((w >> 7) & 0x3) << 6);
        return `c.swsp ${r(rs2)},${uimm}(sp)`;
      }
      return hex();
    }

    return hex();
  }
}

if (typeof module !== 'undefined') {
  module.exports = { Disassembler };
}
