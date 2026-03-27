
/**
 * RV32E Virtual Machine for TinyC
 */

class VM {
  constructor(hexdump, timer_callback, gpio_callback, log_callback) {
    this.regs = new Int32Array(16);
    this.pc = 0;
    this.flash = new Uint8Array(16384); // 16KB
    this.sram = new Uint8Array(2048);   // 2KB
    this.timer_callback = timer_callback;
    this.gpio_callback = gpio_callback;
    this.log_callback = log_callback;
    this.startTime = Date.now();

    this.loadHex(hexdump);
  }

  loadHex(hexdump) {
    const lines = hexdump.split('\n');
    lines.forEach(line => {
      const parts = line.split(':');
      if (parts.length < 2) return;
      const addr = parseInt(parts[0], 16);
      const hexParts = parts[1].trim().split(/\s+/);
      hexParts.forEach((hp, i) => {
        if (hp.length === 2 && addr + i < this.flash.length) {
          this.flash[addr + i] = parseInt(hp, 16);
        }
      });
    });
  }

  step() {
    if (this.pc < 0 || this.pc >= this.flash.length) return false;
    
    const w = this.read32(this.pc);
    const op = w & 0x7f;
    const rd = (w >> 7) & 0x1f;
    const f3 = (w >> 12) & 0x7;
    const rs1 = (w >> 15) & 0x1f;
    const rs2 = (w >> 20) & 0x1f;
    const f7 = (w >> 25) & 0x7f;

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

      case 0x33: // R-type
        if (f3 === 0x0) {
          if (f7 === 0x00) this.regs[rd] = this.regs[rs1] + this.regs[rs2];
          else if (f7 === 0x20) this.regs[rd] = this.regs[rs1] - this.regs[rs2];
          else if (f7 === 0x01) this.regs[rd] = Math.imul(this.regs[rs1], this.regs[rs2]);
        } else if (f3 === 0x7) this.regs[rd] = this.regs[rs1] & this.regs[rs2];
        else if (f3 === 0x6) this.regs[rd] = this.regs[rs1] | this.regs[rs2];
        else if (f3 === 0x4) this.regs[rd] = this.regs[rs1] ^ this.regs[rs2];
        else if (f3 === 0x1) this.regs[rd] = this.regs[rs1] << (this.regs[rs2] & 0x1f);
        else if (f3 === 0x5) this.regs[rd] = this.regs[rs1] >>> (this.regs[rs2] & 0x1f);
        else if (f3 === 0x3) this.regs[rd] = (this.regs[rs1] >>> 0 < this.regs[rs2] >>> 0) ? 1 : 0;
        break;

      case 0x13: // I-type
        if (f3 === 0x0) this.regs[rd] = this.regs[rs1] + imm_i;
        else if (f3 === 0x4) this.regs[rd] = this.regs[rs1] ^ imm_i;
        else if (f3 === 0x3) this.regs[rd] = (this.regs[rs1] >>> 0 < imm_i >>> 0) ? 1 : 0;
        break;

      case 0x03: // Load
        this.regs[rd] = this.memRead(this.regs[rs1] + imm_i, f3);
        break;

      case 0x23: // Store
        this.memWrite(this.regs[rs1] + imm_s, this.regs[rs2], f3);
        break;

      case 0x63: // Branch
        let cond = false;
        if (f3 === 0x1) cond = (this.regs[rs1] !== this.regs[rs2]);
        // Add more branch types if needed
        if (cond) next_pc = this.pc + imm_b;
        break;

      case 0x6f: // JAL
        if (rd !== 0) this.regs[rd] = this.pc + 4;
        next_pc = this.pc + imm_j;
        break;

      case 0x67: // JALR
        const target = (this.regs[rs1] + imm_i) & ~1;
        if (rd !== 0) this.regs[rd] = this.pc + 4;
        next_pc = target;
        break;

      default:
        if (w === 0) return false; // プログラム末尾のゼロ埋め領域 = ハルト
        throw new Error(`Unknown opcode: 0x${op.toString(16).padStart(2,'0')} (word=0x${(w>>>0).toString(16).padStart(8,'0')}) at PC=0x${this.pc.toString(16)}`);
    }

    this.regs[0] = 0; // x0 is always 0
    this.pc = next_pc;
    return true;
  }

  read32(addr) {
    if (addr >= 0 && addr < this.flash.length) {
      return this.flash[addr] | (this.flash[addr+1] << 8) | (this.flash[addr+2] << 16) | (this.flash[addr+3] << 24);
    }
    return 0;
  }

  memRead(addr, size) {
    addr >>>= 0;
    if (addr < 16384) { // Flash
      if (size === 0x2) return this.read32(addr);
    } else if (addr >= 0x20000000 && addr < 0x20000800) { // SRAM
      const offset = addr - 0x20000000;
      if (size === 0x2) {
        return (this.sram[offset] | (this.sram[offset+1] << 8) | (this.sram[offset+2] << 16) | (this.sram[offset+3] << 24)) >> 0;
      }
    }
 else if (addr === 0x40021000) { // RCC_CTLR
      return 0x03000000; // PLLRDY=1, HSIRDY=1
    } else if (addr === 0x40021004) { // RCC_CFGR0
      return 0x00000008; // SWS=PLL
    } else if (addr === 0xE000F008) { // STK_CNT (SysTick)
      return this.timer_callback ? this.timer_callback() : 0;
    }
    return 0;
  }


  memWrite(addr, val, size) {
    addr >>>= 0;
    if (this.log_callback) this.log_callback(`memWrite addr=0x${addr.toString(16)} val=0x${val.toString(16)}`);
    if (addr >= 0x20000000 && addr < 0x20000800) { // SRAM
      const offset = addr - 0x20000000;
      if (size === 0x2) {
        this.sram[offset] = val & 0xff;
        this.sram[offset+1] = (val >> 8) & 0xff;
        this.sram[offset+2] = (val >> 16) & 0xff;
        this.sram[offset+3] = (val >> 24) & 0xff;
      }
    } else if (addr >= 0x40010800 && addr < 0x40011400) { // GPIO
      if (this.gpio_callback) this.gpio_callback(addr, val);
    }
  }
}

if (typeof module !== 'undefined') {
  module.exports = { VM };
}
