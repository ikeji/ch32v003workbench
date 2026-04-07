
/**
 * RV32EC Virtual Machine — supports compressed (C) extension and full RV32IM integer set
 */

class VM {
  constructor(hexdump, timer_callback, gpio_callback, log_callback, i2c_callback) {
    this.regs = new Int32Array(32); // x0..x31 (RV32E only uses x0..x15)
    this.pc   = 0;
    this.flash = new Uint8Array(16384); // 16KB
    this.sram  = new Uint8Array(2048);  // 2KB  0x20000000–0x200007FF
    this.csrs  = {};                    // CSR register file

    this.timer_callback = timer_callback;
    this.gpio_callback  = gpio_callback;
    this.log_callback   = log_callback;
    this.i2c_callback   = i2c_callback;

    // I2C1 state machine (base 0x40005400)
    this.i2c = {
      ctlr1: 0,      // +0x00: Control Register 1
      ctlr2: 0,      // +0x04: Control Register 2
      datar: 0,      // +0x10: Data Register
      star1: 0,      // +0x14: Status Register 1
      star2: 0,      // +0x18: Status Register 2
      ckcfgr: 0,     // +0x1C: Clock Configuration
      addr: 0,       // current slave address
      buf: [],       // accumulated data bytes
      state: 'idle', // 'idle' | 'start' | 'addr' | 'data'
    };

    // GPIO port state (A=0x40010800, B=0x40010C00, C=0x40011000, D=0x40011400)
    // Each port has: CFGLR(+0x00), INDR(+0x08), OUTDR(+0x0C), BSHR(+0x10), BCR(+0x14)
    this.gpio = {
      A: { cfglr: 0, indr: 0, outdr: 0 },
      B: { cfglr: 0, indr: 0, outdr: 0 },
      C: { cfglr: 0, indr: 0, outdr: 0 },
      D: { cfglr: 0, indr: 0, outdr: 0 },
    };

    // ADC state (simple PRNG for noise simulation)
    this.adc = {
      seed: (Date.now() ^ 0xDEAD) | 1,  // PRNG state seeded from current time
    };

    this.loadHex(hexdump);
  }

  // ── Hex loading ─────────────────────────────────────────────────────────────

  loadHex(hexdump) {
    const lines = hexdump.split('\n');
    lines.forEach(line => {
      const parts = line.split(':');
      if (parts.length < 2) return;
      const addr = parseInt(parts[0], 16);
      if (isNaN(addr)) return;
      const hexParts = parts[1].trim().split(/\s+/).slice(0, 16);
      hexParts.forEach((hp, i) => {
        if (addr + i < this.flash.length) {
          this.flash[addr + i] = parseInt(hp, 16);
        }
      });
    });
  }

  // ── Instruction fetch & dispatch ────────────────────────────────────────────

  step() {
    if (this.pc < 0 || this.pc >= this.flash.length) return false;

    const lo = this.flash[this.pc] | (this.flash[this.pc + 1] << 8);

    if ((lo & 0x3) !== 0x3) {
      // 16-bit RVC instruction
      return this.stepC(lo);
    }

    // 32-bit instruction
    if (this.pc + 4 > this.flash.length) return false;
    return this.step32(this.read32(this.pc));
  }

  // ── 32-bit instruction executor ─────────────────────────────────────────────

  step32(w) {
    const op  = w & 0x7f;
    const rd  = (w >> 7)  & 0x1f;
    const f3  = (w >> 12) & 0x7;
    const rs1 = (w >> 15) & 0x1f;
    const rs2 = (w >> 20) & 0x1f;
    const f7  = (w >> 25) & 0x7f;

    const sext = (v, bits) => (v << (32 - bits)) >> (32 - bits);

    const imm_i = sext(w >> 20, 12);
    const imm_s = sext(((w >> 7) & 0x1f) | ((w >> 25) << 5), 12);
    const imm_b = sext(((w >> 8) & 0xf) << 1 | ((w >> 25) & 0x3f) << 5 | ((w >> 7) & 0x1) << 11 | (w >> 31) << 12, 13);
    const imm_j = sext(((w >> 21) & 0x3ff) << 1 | ((w >> 20) & 0x1) << 11 | ((w >> 12) & 0xff) << 12 | (w >> 31) << 20, 21);

    let next_pc = this.pc + 4;

    switch (op) {
      case 0x37: // LUI
        this.regs[rd] = w & 0xfffff000;
        break;

      case 0x17: // AUIPC
        this.regs[rd] = this.pc + (w & 0xfffff000);
        break;

      case 0x33: { // R-type
        const s = this.regs[rs1], t = this.regs[rs2];
        const su = s >>> 0, tu = t >>> 0;
        if      (f3 === 0x0 && f7 === 0x00) this.regs[rd] = s + t;
        else if (f3 === 0x0 && f7 === 0x20) this.regs[rd] = s - t;
        else if (f3 === 0x0 && f7 === 0x01) this.regs[rd] = Math.imul(s, t);
        else if (f3 === 0x1 && f7 === 0x00) this.regs[rd] = s << (t & 0x1f);
        else if (f3 === 0x2 && f7 === 0x00) this.regs[rd] = (s < t) ? 1 : 0;
        else if (f3 === 0x3 && f7 === 0x00) this.regs[rd] = (su < tu) ? 1 : 0;
        else if (f3 === 0x4 && f7 === 0x00) this.regs[rd] = s ^ t;
        else if (f3 === 0x5 && f7 === 0x00) this.regs[rd] = su >>> (t & 0x1f);
        else if (f3 === 0x5 && f7 === 0x20) this.regs[rd] = s >> (t & 0x1f);
        else if (f3 === 0x6 && f7 === 0x00) this.regs[rd] = s | t;
        else if (f3 === 0x7 && f7 === 0x00) this.regs[rd] = s & t;
        // M-extension
        else if (f3 === 0x4 && f7 === 0x01) this.regs[rd] = t !== 0 ? (s / t) | 0 : -1;
        else if (f3 === 0x5 && f7 === 0x01) this.regs[rd] = t !== 0 ? (su / tu) >>> 0 : 0xffffffff;
        else if (f3 === 0x6 && f7 === 0x01) this.regs[rd] = t !== 0 ? s % t : s;
        else if (f3 === 0x7 && f7 === 0x01) this.regs[rd] = t !== 0 ? su % tu : su;
        break;
      }

      case 0x13: { // I-type ALU
        const s  = this.regs[rs1];
        const su = s >>> 0;
        const shamt = (w >> 20) & 0x1f;
        if      (f3 === 0x0) this.regs[rd] = s + imm_i;
        else if (f3 === 0x1) this.regs[rd] = s << shamt;
        else if (f3 === 0x2) this.regs[rd] = (s < imm_i) ? 1 : 0;
        else if (f3 === 0x3) this.regs[rd] = (su < (imm_i >>> 0)) ? 1 : 0;
        else if (f3 === 0x4) this.regs[rd] = s ^ imm_i;
        else if (f3 === 0x5 && f7 === 0x00) this.regs[rd] = su >>> shamt;
        else if (f3 === 0x5 && f7 === 0x20) this.regs[rd] = s >> shamt;
        else if (f3 === 0x6) this.regs[rd] = s | imm_i;
        else if (f3 === 0x7) this.regs[rd] = s & imm_i;
        break;
      }

      case 0x03: // Load
        this.regs[rd] = this.memRead(this.regs[rs1] + imm_i, f3);
        break;

      case 0x23: // Store
        this.memWrite(this.regs[rs1] + imm_s, this.regs[rs2], f3);
        break;

      case 0x63: { // Branch
        const s = this.regs[rs1], t = this.regs[rs2];
        let cond = false;
        if      (f3 === 0x0) cond = (s === t);
        else if (f3 === 0x1) cond = (s !== t);
        else if (f3 === 0x4) cond = (s < t);
        else if (f3 === 0x5) cond = (s >= t);
        else if (f3 === 0x6) cond = ((s >>> 0) < (t >>> 0));
        else if (f3 === 0x7) cond = ((s >>> 0) >= (t >>> 0));
        if (cond) next_pc = this.pc + imm_b;
        break;
      }

      case 0x6f: // JAL
        this.regs[rd] = this.pc + 4;
        next_pc = this.pc + imm_j;
        break;

      case 0x67: // JALR
        this.regs[rd] = this.pc + 4;
        next_pc = (this.regs[rs1] + imm_i) & ~1;
        break;

      case 0x73: { // SYSTEM (CSR / ECALL / EBREAK / MRET)
        if (w === 0x30200073) { // mret
          next_pc = (this.csrs[0x341] || 0) >>> 0; // mepc
          break;
        }
        if (w === 0x00100073 || w === 0x00000073) { // ebreak / ecall
          return false;
        }
        const csr_addr = (w >>> 20) & 0xfff;
        const old = this.csrRead(csr_addr);
        if (f3 === 0x1) { // csrrw
          if (rd !== 0) this.regs[rd] = old;
          this.csrWrite(csr_addr, this.regs[rs1]);
        } else if (f3 === 0x2) { // csrrs
          if (rd !== 0) this.regs[rd] = old;
          if (rs1 !== 0) this.csrWrite(csr_addr, old | this.regs[rs1]);
        } else if (f3 === 0x3) { // csrrc
          if (rd !== 0) this.regs[rd] = old;
          if (rs1 !== 0) this.csrWrite(csr_addr, old & ~this.regs[rs1]);
        } else if (f3 === 0x5) { // csrrwi
          if (rd !== 0) this.regs[rd] = old;
          this.csrWrite(csr_addr, rs1);
        } else if (f3 === 0x6) { // csrrsi
          if (rd !== 0) this.regs[rd] = old;
          if (rs1 !== 0) this.csrWrite(csr_addr, old | rs1);
        } else if (f3 === 0x7) { // csrrci
          if (rd !== 0) this.regs[rd] = old;
          if (rs1 !== 0) this.csrWrite(csr_addr, old & ~rs1);
        }
        break;
      }

      default:
        if (w === 0x00000013) break; // nop (addi zero,zero,0)
        if ((w & 0xffff) === 0x0000 || w === 0) return false; // halt on zero-fill
        throw new Error(`Unknown opcode: 0x${op.toString(16).padStart(2,'0')} (word=0x${(w>>>0).toString(16).padStart(8,'0')}) at PC=0x${this.pc.toString(16)}`);
    }

    this.regs[0] = 0; // x0 is always 0
    this.pc = next_pc;
    return true;
  }

  // ── 16-bit RVC instruction executor ─────────────────────────────────────────

  stepC(w) {
    const quadrant = w & 0x3;
    const funct3   = (w >> 13) & 0x7;
    const sext = (v, bits) => (v << (32 - bits)) >> (32 - bits);
    const rc = (idx) => (idx & 0x7) + 8; // 3-bit compressed reg → x8..x15

    let next_pc = this.pc + 2;

    if (quadrant === 0x0) {
      const rd_  = (w >> 2) & 0x7;
      const rs1_ = (w >> 7) & 0x7;
      const rs2_ = (w >> 2) & 0x7;

      if (w === 0x0000) return false; // unimp

      if (funct3 === 0x0) { // c.addi4spn  rd', sp, nzuimm
        const uimm = (((w >> 11) & 0x3) << 4) | (((w >> 7) & 0xf) << 6) |
                     (((w >>  6) & 0x1) << 2) | (((w >> 5) & 0x1) << 3);
        this.regs[rc(rd_)] = this.regs[2] + uimm;
      } else if (funct3 === 0x2) { // c.lw  rd', uimm(rs1')
        const uimm = (((w >> 10) & 0x7) << 3) | (((w >> 6) & 0x1) << 2) | (((w >> 5) & 0x1) << 6);
        this.regs[rc(rd_)] = this.memRead(this.regs[rc(rs1_)] + uimm, 0x2);
      } else if (funct3 === 0x6) { // c.sw  rs2', uimm(rs1')
        const uimm = (((w >> 10) & 0x7) << 3) | (((w >> 6) & 0x1) << 2) | (((w >> 5) & 0x1) << 6);
        this.memWrite(this.regs[rc(rs1_)] + uimm, this.regs[rc(rs2_)], 0x2);
      }

    } else if (quadrant === 0x1) {
      const rd   = (w >> 7) & 0x1f;
      const rs1_ = (w >> 7) & 0x7; // for compressed rs1'
      const simm6 = sext((((w >> 12) & 1) << 5) | ((w >> 2) & 0x1f), 6);

      if (funct3 === 0x0) { // c.nop / c.addi
        if (rd !== 0) this.regs[rd] += simm6;
      } else if (funct3 === 0x1) { // c.jal (RV32 only)
        const off = (((w >> 12) & 1) << 11) | (((w >> 11) & 1) << 4) |
                    (((w >>  9) & 3) <<  8) | (((w >>  8) & 1) << 10) |
                    (((w >>  7) & 1) <<  6) | (((w >>  6) & 1) <<  7) |
                    (((w >>  3) & 7) <<  1) | (((w >>  2) & 1) <<  5);
        this.regs[1] = this.pc + 2;
        next_pc = this.pc + sext(off, 12);
      } else if (funct3 === 0x2) { // c.li
        if (rd !== 0) this.regs[rd] = simm6;
      } else if (funct3 === 0x3) {
        if (rd === 2) { // c.addi16sp
          const nzimm = (((w >> 12) & 1) << 9) | (((w >> 6) & 1) << 4) |
                        (((w >>  5) & 1) << 6) | (((w >> 3) & 3) << 7) |
                        (((w >>  2) & 1) << 5);
          this.regs[2] += sext(nzimm, 10);
        } else if (rd !== 0) { // c.lui
          this.regs[rd] = simm6 << 12;
        }
      } else if (funct3 === 0x4) {
        const funct2 = (w >> 10) & 0x3;
        const shamt  = (((w >> 12) & 1) << 5) | ((w >> 2) & 0x1f);
        const rdi    = rc(rs1_);
        if (funct2 === 0x0) { // c.srli
          this.regs[rdi] = (this.regs[rdi] >>> 0) >>> shamt;
        } else if (funct2 === 0x1) { // c.srai
          this.regs[rdi] = this.regs[rdi] >> shamt;
        } else if (funct2 === 0x2) { // c.andi
          this.regs[rdi] &= simm6;
        } else if (funct2 === 0x3) {
          const f1   = (w >> 12) & 0x1;
          const f2b  = (w >>  5) & 0x3;
          const rs2i = rc((w >> 2) & 0x7);
          if (f1 === 0) {
            if (f2b === 0x0) this.regs[rdi] -= this.regs[rs2i]; // c.sub
            else if (f2b === 0x1) this.regs[rdi] ^= this.regs[rs2i]; // c.xor
            else if (f2b === 0x2) this.regs[rdi] |= this.regs[rs2i]; // c.or
            else if (f2b === 0x3) this.regs[rdi] &= this.regs[rs2i]; // c.and
          }
          // f1===1 → RV64 subword ops, ignore
        }
      } else if (funct3 === 0x5) { // c.j
        const off = (((w >> 12) & 1) << 11) | (((w >> 11) & 1) << 4) |
                    (((w >>  9) & 3) <<  8) | (((w >>  8) & 1) << 10) |
                    (((w >>  7) & 1) <<  6) | (((w >>  6) & 1) <<  7) |
                    (((w >>  3) & 7) <<  1) | (((w >>  2) & 1) <<  5);
        next_pc = this.pc + sext(off, 12);
      } else if (funct3 === 0x6) { // c.beqz
        const off = (((w >> 12) & 1) << 8) | (((w >> 10) & 3) << 3) |
                    (((w >>  5) & 3) << 6) | (((w >>  3) & 3) << 1) |
                    (((w >>  2) & 1) << 5);
        if (this.regs[rc(rs1_)] === 0) next_pc = this.pc + sext(off, 9);
      } else if (funct3 === 0x7) { // c.bnez
        const off = (((w >> 12) & 1) << 8) | (((w >> 10) & 3) << 3) |
                    (((w >>  5) & 3) << 6) | (((w >>  3) & 3) << 1) |
                    (((w >>  2) & 1) << 5);
        if (this.regs[rc(rs1_)] !== 0) next_pc = this.pc + sext(off, 9);
      }

    } else if (quadrant === 0x2) {
      const rd  = (w >> 7) & 0x1f;
      const rs2 = (w >>  2) & 0x1f;

      if (funct3 === 0x0) { // c.slli
        const shamt = (((w >> 12) & 1) << 5) | ((w >> 2) & 0x1f);
        if (rd !== 0) this.regs[rd] <<= shamt;
      } else if (funct3 === 0x2) { // c.lwsp
        const uimm = (((w >> 12) & 1) << 5) | (((w >> 4) & 0x7) << 2) | (((w >> 2) & 0x3) << 6);
        if (rd !== 0) this.regs[rd] = this.memRead(this.regs[2] + uimm, 0x2);
      } else if (funct3 === 0x4) {
        const bit12 = (w >> 12) & 0x1;
        if (bit12 === 0) {
          if (rs2 === 0 && rd !== 0) { // c.jr
            next_pc = this.regs[rd] & ~1;
          } else if (rs2 !== 0) { // c.mv
            if (rd !== 0) this.regs[rd] = this.regs[rs2];
          }
        } else {
          if (rd === 0 && rs2 === 0) return false; // c.ebreak
          else if (rs2 === 0 && rd !== 0) { // c.jalr
            const target = this.regs[rd] & ~1;
            this.regs[1] = this.pc + 2;
            next_pc = target;
          } else if (rd !== 0) { // c.add
            this.regs[rd] += this.regs[rs2];
          }
        }
      } else if (funct3 === 0x6) { // c.swsp
        const uimm = (((w >> 9) & 0xf) << 2) | (((w >> 7) & 0x3) << 6);
        this.memWrite(this.regs[2] + uimm, this.regs[rs2], 0x2);
      }
    } else {
      return false; // quadrant 3 = 32-bit, shouldn't arrive here
    }

    this.regs[0] = 0;
    this.pc = next_pc;
    return true;
  }

  // ── CSR access ───────────────────────────────────────────────────────────────

  csrRead(addr) {
    // mcycle: return step-based timer
    if (addr === 0xB00 || addr === 0xC00) {
      return this.timer_callback ? this.timer_callback() : 0;
    }
    return (this.csrs[addr] || 0) | 0;
  }

  csrWrite(addr, val) {
    this.csrs[addr] = val | 0;
  }

  // ── Memory helpers ───────────────────────────────────────────────────────────

  read32(addr) {
    return this.flash[addr] | (this.flash[addr+1] << 8) |
           (this.flash[addr+2] << 16) | (this.flash[addr+3] << 24);
  }

  _readByte(addr) {
    addr >>>= 0;
    if (addr < this.flash.length) return this.flash[addr];
    if (addr >= 0x20000000 && addr < 0x20000800) return this.sram[addr - 0x20000000];
    return 0;
  }

  memRead(addr, f3) {
    addr >>>= 0;

    if (f3 === 0x0) { // lb
      const b = this._readByte(addr);
      return (b << 24) >> 24;
    }
    if (f3 === 0x1) { // lh
      const h = this._readByte(addr) | (this._readByte(addr + 1) << 8);
      return (h << 16) >> 16;
    }
    if (f3 === 0x2) { // lw
      if (addr < this.flash.length) return this.read32(addr);
      if (addr >= 0x20000000 && addr < 0x20000800) {
        const o = addr - 0x20000000;
        return (this.sram[o] | (this.sram[o+1] << 8) |
                (this.sram[o+2] << 16) | (this.sram[o+3] << 24)) | 0;
      }
      return this._peripheralRead(addr);
    }
    if (f3 === 0x4) return this._readByte(addr);          // lbu
    if (f3 === 0x5) {                                      // lhu
      // Peripheral 16-bit reads need special handling
      if (addr >= 0x40000000) return this._peripheralRead(addr) & 0xffff;
      return this._readByte(addr) | (this._readByte(addr + 1) << 8);
    }
    return 0;
  }

  _peripheralRead(addr) {
    // GPIO registers (0x40010800-0x40011800)
    if (addr >= 0x40010800 && addr < 0x40011800) return this._gpioRead(addr);
    if (addr === 0x40021000) return 0x03000000; // RCC_CTLR: PLLRDY|HSIRDY set
    if (addr === 0x40021004) return 0x00000008; // RCC_CFGR0: SWS=PLL
    if (addr === 0xE000F008) return this.timer_callback ? this.timer_callback() : 0; // SysTick CNT
    // I2C1 registers (0x40005400-0x4000541F)
    if (addr >= 0x40005400 && addr < 0x40005420) return this._i2cRead(addr);
    // ADC1 registers (base 0x40012400)
    if (addr >= 0x40012400 && addr < 0x40012500) return this._adcRead(addr);
    // All other peripheral reads: return 0 (UART ready = not-busy = 0)
    return 0;
  }

  _i2cRead(addr) {
    const off = addr - 0x40005400;
    switch (off) {
      case 0x00: return this.i2c.ctlr1;
      case 0x04: return this.i2c.ctlr2;
      case 0x10: return this.i2c.datar;
      case 0x14: return this.i2c.star1;
      case 0x18: return this.i2c.star2;
      case 0x1C: return this.i2c.ckcfgr;
      default: return 0;
    }
  }

  _gpioPort(addr) {
    if (addr >= 0x40011400) return this.gpio.D;
    if (addr >= 0x40011000) return this.gpio.C;
    if (addr >= 0x40010C00) return this.gpio.B;
    return this.gpio.A;
  }

  _gpioRead(addr) {
    const port = this._gpioPort(addr);
    const off = addr & 0x3FF;
    switch (off) {
      case 0x00: return port.cfglr;
      case 0x08: return port.indr | port.outdr; // input reads both external input and output state
      case 0x0C: return port.outdr;
      default: return 0;
    }
  }

  _gpioWrite(addr, val) {
    const port = this._gpioPort(addr);
    const off = addr & 0x3FF;
    switch (off) {
      case 0x00: // CFGLR
        port.cfglr = val;
        break;
      case 0x0C: // OUTDR
        port.outdr = val;
        break;
      case 0x10: { // BSHR
        const setBits = val & 0xFFFF;
        const resetBits = (val >>> 16) & 0xFFFF;
        port.outdr = (port.outdr | setBits) & ~resetBits;
        break;
      }
      case 0x14: // BCR
        port.outdr &= ~(val & 0xFFFF);
        break;
    }
  }

  /**
   * Set a GPIO input pin from outside the VM.
   * @param {string} portName - "A", "B", "C", or "D"
   * @param {number} pin - pin number 0-7
   * @param {boolean} high - true for HIGH, false for LOW
   */
  setGpioPin(portName, pin, high) {
    const port = this.gpio[portName];
    if (!port) throw new Error(`Unknown GPIO port: ${portName}`);
    if (pin < 0 || pin > 7) throw new Error(`Invalid pin number: ${pin}`);
    if (high) {
      port.indr |= (1 << pin);
    } else {
      port.indr &= ~(1 << pin);
    }
  }

  memWrite(addr, val, f3) {
    addr >>>= 0;
    if (this.log_callback) {
      this.log_callback(`memWrite addr=0x${addr.toString(16)} val=0x${(val>>>0).toString(16)}`);
    }

    if (addr >= 0x20000000 && addr < 0x20000800) {
      const o = addr - 0x20000000;
      if (f3 === 0x2) { // sw
        this.sram[o]   =  val        & 0xff;
        this.sram[o+1] = (val >>  8) & 0xff;
        this.sram[o+2] = (val >> 16) & 0xff;
        this.sram[o+3] = (val >> 24) & 0xff;
      } else if (f3 === 0x1) { // sh
        this.sram[o]   =  val       & 0xff;
        this.sram[o+1] = (val >> 8) & 0xff;
      } else if (f3 === 0x0) { // sb
        this.sram[o] = val & 0xff;
      }
    } else if (addr >= 0x40010800 && addr < 0x40011800) { // GPIO
      this._gpioWrite(addr, val);
      if (this.gpio_callback) this.gpio_callback(addr, val);
    } else if (addr >= 0x40005400 && addr < 0x40005420) { // I2C1
      this._i2cWrite(addr, val, f3);
    }
    // Other peripheral writes are silently ignored
  }

  _i2cWrite(addr, val, f3) {
    const off = addr - 0x40005400;
    // For 16-bit writes (sh), mask to 16 bits
    if (f3 === 0x1) val = val & 0xffff;

    switch (off) {
      case 0x00: { // CTLR1
        const prevCtlr1 = this.i2c.ctlr1;
        this.i2c.ctlr1 = val;
        // Detect newly set bits
        const rising = val & ~prevCtlr1;
        if (rising & 0x200) { // STOP bit newly set
          // Transaction complete — invoke callback
          if (this.i2c_callback && this.i2c.buf.length > 0) {
            this.i2c_callback(this.i2c.addr, this.i2c.buf);
          }
          this.i2c.state = 'idle';
          this.i2c.star1 = 0;
          this.i2c.star2 = 0;
          this.i2c.buf = [];
          this.i2c.ctlr1 = val & ~0x300; // clear START+STOP bits
        } else if (rising & 0x100) { // START bit newly set
          this.i2c.state = 'start';
          this.i2c.buf = [];
          // SB=1 (bit 0), BUSY=1 (STAR2 bit 1), MSL=1 (STAR2 bit 0)
          this.i2c.star1 = 0x0001;
          this.i2c.star2 = 0x0003;
          this.i2c.ctlr1 = val & ~0x100; // clear START bit
        }
        break;
      }
      case 0x04: // CTLR2
        this.i2c.ctlr2 = val;
        break;
      case 0x10: { // DATAR
        this.i2c.datar = val;
        if (this.i2c.state === 'start') {
          // First byte after START is address
          this.i2c.addr = (val >> 1) & 0x7f;
          this.i2c.state = 'addr';
          // ADDR=1 (bit 1), TXE=1 (bit 7), BUSY+MSL+TRA set in STAR2
          this.i2c.star1 = 0x0082;
          this.i2c.star2 = 0x0007;
        } else {
          // Data byte
          this.i2c.state = 'data';
          this.i2c.buf.push(val & 0xff);
          // TXE=1 (bit 7), BTF=1 (bit 2)
          this.i2c.star1 = 0x0084;
          this.i2c.star2 = 0x0007;
        }
        break;
      }
      case 0x1C: // CKCFGR
        this.i2c.ckcfgr = val;
        break;
    }
  }

  _adcRead(addr) {
    const off = addr - 0x40012400;
    switch (off) {
      case 0x00: // STATR — always report EOC (bit 1) so adc_get() doesn't spin
        return 0x02;
      case 0x08: // CTLR2 — report ADON, clear RSTCAL/CAL bits so init loops finish
        return 0x01;
      case 0x4C: { // RDATAR — return pseudo-random 10-bit value (ADC noise)
        this.adc.seed ^= this.adc.seed << 13;
        this.adc.seed ^= this.adc.seed >>> 17;
        this.adc.seed ^= this.adc.seed << 5;
        return (this.adc.seed >>> 0) & 0x3FF;
      }
      default:
        return 0;
    }
  }
}

if (typeof module !== 'undefined') {
  module.exports = { VM };
}
