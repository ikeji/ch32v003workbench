
const test = require('node:test');
const assert = require('node:assert');
const { Assembler } = require('../src/assembler');
const { Disassembler } = require('../src/disassembler');

function roundtrip(asm) {
  const hexdump = new Assembler().assemble(asm);
  return new Disassembler().disassemble(hexdump);
}

// Build a hexdump string from raw bytes (addr: bb bb ... format)
function bytesToHexdump(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const addr = i.toString(16).padStart(4, '0');
    const chunk = Array.from(bytes.slice(i, i + 16))
      .map(b => b.toString(16).padStart(2, '0')).join(' ');
    lines.push(`${addr}: ${chunk}`);
  }
  return lines.join('\n');
}

function w32(...words) {
  const bytes = [];
  for (const w of words) {
    bytes.push(w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, (w >> 24) & 0xff);
  }
  return bytesToHexdump(bytes);
}

function w16(...shorts) {
  const bytes = [];
  for (const s of shorts) bytes.push(s & 0xff, (s >> 8) & 0xff);
  return bytesToHexdump(bytes);
}

function disasm(...args) {
  return new Disassembler().disassemble(...args);
}

test('Disassembler should decode assembler output', () => {
  const result = roundtrip(`
    li t0, 10
    addi t1, t0, 5
    add t2, t0, t1
    lw a0, 0(sp)
    sw a1, 4(sp)
    ret
  `);
  assert.ok(result.includes('li\tt0,10'));
  assert.ok(result.includes('addi\tt1,t0,5'));
  assert.ok(result.includes('add\tt2,t0,t1'));
  assert.ok(result.includes('lw\ta0,0(sp)'));
  assert.ok(result.includes('sw\ta1,4(sp)'));
  assert.ok(result.includes('ret'));
});

test('Disassembler should handle jumps and branches', () => {
  const result = roundtrip(`
    loop:
      li a0, 1
      bne a0, zero, loop
      j loop
  `);
  // bne a0, zero は bnez a0 にfold、アドレスはPC相対で0x0 (loop先頭)
  assert.ok(result.includes('bnez\ta0,0x0'));
  assert.ok(result.includes('j\t0x0'));
});

test('Disassembler should decode lui correctly', () => {
  // lui sp, 0x20001 → sp = 0x20001000
  const result = roundtrip('lui sp, 0x20001');
  assert.ok(result.includes('lui\tsp,0x20001'));
});

test('Disassembler should decode mv pseudo (addi rd, rs, 0)', () => {
  const result = roundtrip('mv t1, s0');
  assert.ok(result.includes('mv\tt1,s0'));
});

test('Disassembler should decode not pseudo (xori rd, rs, -1)', () => {
  const result = roundtrip('not t0, t0');
  assert.ok(result.includes('not\tt0,t0'));
});

test('Disassembler should decode seqz pseudo (sltiu rd, rs, 1)', () => {
  const result = roundtrip('seqz t0, t0');
  assert.ok(result.includes('seqz\tt0,t0'));
});

test('Disassembler should decode R-type: sub, mul, sltu', () => {
  const result = roundtrip(`
    sub t0, t0, t1
    mul t0, t0, t1
    sltu t0, t0, t1
  `);
  assert.ok(result.includes('sub\tt0,t0,t1'));
  assert.ok(result.includes('mul\tt0,t0,t1'));
  assert.ok(result.includes('sltu\tt0,t0,t1'));
});

test('Disassembler should decode lhu and lbu', () => {
  const result = roundtrip(`
    lhu t0, 0(t1)
    lbu t0, 0(t1)
  `);
  assert.ok(result.includes('lhu\tt0,0(t1)'));
  assert.ok(result.includes('lbu\tt0,0(t1)'));
});

test('Disassembler should decode sh and sb', () => {
  const result = roundtrip(`
    sh t0, 0(t1)
    sb t0, 0(t1)
  `);
  assert.ok(result.includes('sh\tt0,0(t1)'));
  assert.ok(result.includes('sb\tt0,0(t1)'));
});

test('Disassembler output format matches objdump style', () => {
  const result = roundtrip('addi sp, sp, -4');
  // "   0:\tffc10113\t\taddi\tsp,sp,-4"
  assert.ok(result.includes(':\t'));           // addr: \t
  assert.ok(result.includes('ffc10113'));      // 8桁hex
  assert.ok(result.includes('addi\tsp,sp,-4')); // tab区切り、カンマ後スペースなし
});

// ── 新命令テスト ────────────────────────────────────────────────────────────

test('Disassembler should decode auipc', () => {
  // auipc gp,0x20000 = 0x20000197  (from success-example.bin:0x110)
  assert.ok(disasm(w32(0x20000197)).includes('auipc\tgp,0x20000'));
});

test('Disassembler should decode new I-type ALU: andi ori slli srli srai', () => {
  // andi a4,a4,128 = 0x08077713  (from success-example.bin:0xa8)
  assert.ok(disasm(w32(0x08077713)).includes('andi\ta4,a4,128'));
  // ori  a5,a5,133 = 0x0857e793  (from success-example.bin:0xfc)
  assert.ok(disasm(w32(0x0857e793)).includes('ori\ta5,a5,133'));
  // slli a5,a5,0x8 = 0x00879793  (from success-example.bin:0xf8)
  assert.ok(disasm(w32(0x00879793)).includes('slli\ta5,a5,0x8'));
  // srli t0,t0,1: op=0x13 f3=5 f7=0 rd=t0=5 rs1=t0=5 shamt=1
  const srli = 0x13 | (5<<7) | (5<<12) | (5<<15) | (1<<20);
  assert.ok(disasm(w32(srli)).includes('srli\tt0,t0,0x1'));
  // srai t0,t0,1: shamt=1 f7=0x20 → bit[30]=1
  const srai = 0x13 | (5<<7) | (5<<12) | (5<<15) | (1<<20) | (0x20<<25);
  assert.ok(disasm(w32(srai)).includes('srai\tt0,t0,0x1'));
});

test('Disassembler should decode new R-type: slt sra neg', () => {
  // slt t0,t0,t1: op=0x33 f3=2 f7=0 rd=5 rs1=5 rs2=6
  const slt = 0x33 | (5<<7) | (2<<12) | (5<<15) | (6<<20);
  assert.ok(disasm(w32(slt)).includes('slt\tt0,t0,t1'));
  // sra t0,t0,t1: f3=5 f7=0x20
  const sra = 0x33 | (5<<7) | (5<<12) | (5<<15) | (6<<20) | (0x20<<25);
  assert.ok(disasm(w32(sra)).includes('sra\tt0,t0,t1'));
  // neg a5,a5 = sub a5,zero,a5: 0x40f007b3  (from success-example.bin:0xe8)
  assert.ok(disasm(w32(0x40f007b3)).includes('neg\ta5,a5'));
});

test('Disassembler should decode all branch conditions', () => {
  // beq/bne/blt/bge/bgez/bltz/bltu/bgeu
  // beq a0,a1,0 from pc=0: op=0x63 f3=0 rs1=10 rs2=11 imm=0
  const beq = 0x63 | (0<<12) | (10<<15) | (11<<20);
  assert.ok(disasm(w32(beq)).includes('beq\ta0,a1,0x0'));
  // blt a0,a1,0: f3=4
  const blt = 0x63 | (4<<12) | (10<<15) | (11<<20);
  assert.ok(disasm(w32(blt)).includes('blt\ta0,a1,0x0'));
  // bge a0,a1,0: f3=5
  const bge = 0x63 | (5<<12) | (10<<15) | (11<<20);
  assert.ok(disasm(w32(bge)).includes('bge\ta0,a1,0x0'));
  // bgez a0,0 (bge a0,zero,0): f3=5 rs2=0
  const bgez = 0x63 | (5<<12) | (10<<15) | (0<<20);
  assert.ok(disasm(w32(bgez)).includes('bgez\ta0,0x0'));
  // bltz a0,0 (blt a0,zero,0): f3=4 rs2=0
  const bltz = 0x63 | (4<<12) | (10<<15) | (0<<20);
  assert.ok(disasm(w32(bltz)).includes('bltz\ta0,0x0'));
  // bltu/bgeu: f3=6/7
  const bltu = 0x63 | (6<<12) | (10<<15) | (11<<20);
  assert.ok(disasm(w32(bltu)).includes('bltu\ta0,a1,0x0'));
  const bgeu = 0x63 | (7<<12) | (10<<15) | (11<<20);
  assert.ok(disasm(w32(bgeu)).includes('bgeu\ta0,a1,0x0'));
});

test('Disassembler should decode CSR instructions and mret', () => {
  // csrw mstatus,a0 = csrrw zero,0x300,a0: imm=0x300 rs1=10 f3=1 rd=0 op=0x73
  const csrw = 0x73 | (0<<7) | (1<<12) | (10<<15) | (0x300<<20);
  assert.ok(disasm(w32(csrw)).includes('csrw\tmstatus,a0'));
  // csrr a0,mepc = csrrs a0,0x341,zero: imm=0x341 rs1=0 f3=2 rd=10 op=0x73
  const csrr = 0x73 | (10<<7) | (2<<12) | (0<<15) | (0x341<<20);
  assert.ok(disasm(w32(csrr)).includes('csrr\ta0,mepc'));
  // mret = 0x30200073
  assert.ok(disasm(w32(0x30200073)).includes('mret'));
  // ecall = 0x00000073
  assert.ok(disasm(w32(0x00000073)).includes('ecall'));
});

// ── RVC (16-bit圧縮命令) テスト ────────────────────────────────────────────

test('Disassembler should decode RVC quadrant 0: unimp c.addi4spn c.lw c.sw', () => {
  // unimp = 0x0000
  assert.ok(disasm(w16(0x0000)).includes('unimp'));
  // c.addi4spn a0,sp,4: Q0 funct3=000 rd'=(a0-8=2)=010 nzuimm=4
  // nzuimm=4: bit2=1→inst[6]=1, others=0
  // [15:13]=000 [12:11]=00 [10:7]=0000 [6]=1 [5]=0 [4:2]=010 [1:0]=00
  // = 0x0050 | 0x8 = 0x0058? Let me compute:
  // inst = (0<<13)|(0<<11)|(0<<7)|(1<<6)|(0<<5)|(2<<2)|(0)
  // = 0|0|0|0x40|0|0x8|0 = 0x48
  // Check: uimm[2]=inst[6]=1→bit2=1 → nzuimm=4 ✓; rd'=2→a0 ✓
  assert.ok(disasm(w16(0x0048)).includes('c.addi4spn\ta0,sp,4'));
});

test('Disassembler should decode RVC quadrant 1: c.nop c.li c.addi c.j c.beqz c.bnez', () => {
  // c.nop = 0x0001
  assert.ok(disasm(w16(0x0001)).includes('c.nop'));
  // c.li a0,1: Q1 funct3=010 rd=10 imm=1
  // [15:13]=010 [12]=0 [11:7]=01010 [6:2]=00001 [1:0]=01
  // = (2<<13)|(0<<12)|(10<<7)|(1<<2)|1 = 0x4000|0|0x500|4|1 = 0x4505
  assert.ok(disasm(w16(0x4505)).includes('c.li\ta0,1'));
  // c.addi a0,-1: Q1 funct3=000 rd=10 imm=-1 (simm6=-1: [12]=1,[6:2]=11111)
  // [15:13]=000 [12]=1 [11:7]=01010 [6:2]=11111 [1:0]=01
  // = 0|0x1000|0x500|0x7c|1 = 0x157d
  assert.ok(disasm(w16(0x157d)).includes('c.addi\ta0,-1'));
  // c.j 0: Q1 funct3=101 all offset bits=0 rs1'=don't care
  // offset=0 → all 0 except [1:0]=01 and [15:13]=101
  // = (5<<13)|1 = 0xA001
  assert.ok(disasm(w16(0xa001)).includes('c.j\t0x0'));
  // c.beqz a0,0: Q1 funct3=110 rs1'=(a0-8=2)=010 offset=0
  // [15:13]=110 [12]=0 [11:10]=00 [9:7]=010 [6:5]=00 [4:3]=00 [2]=0 [1:0]=01
  // = (6<<13)|(0<<10)|(2<<7)|1 = 0xC000|0|0x100|1 = 0xC101
  assert.ok(disasm(w16(0xC101)).includes('c.beqz\ta0,0x0'));
  // c.bnez a0,0: funct3=111 same encoding but different funct3
  // = (7<<13)|(2<<7)|1 = 0xE000|0x100|1 = 0xE101
  assert.ok(disasm(w16(0xE101)).includes('c.bnez\ta0,0x0'));
});

test('Disassembler should decode RVC quadrant 2: c.slli c.lwsp c.swsp c.mv c.add c.jr c.jalr c.ebreak', () => {
  // c.slli a0,1: Q2 funct3=000 rd=10 shamt=1
  // [15:13]=000 [12]=0 [11:7]=01010 [6:2]=00001 [1:0]=10
  // = 0|0|0x500|4|2 = 0x0506
  assert.ok(disasm(w16(0x0506)).includes('c.slli\ta0,1'));
  // c.lwsp a0,4(sp): Q2 funct3=010 rd=10 uimm=4 (uimm[4:2]=001,uimm[7:6]=00,uimm[5]=0)
  // inst[12]=0 inst[6:4]=001 inst[3:2]=00 → [15:13]=010[12]=0[11:7]=01010[6:4]=001[3:2]=00[1:0]=10
  // = (2<<13)|0|(10<<7)|(1<<4)|2 = 0x4000|0x500|0x10|2 = 0x4512
  assert.ok(disasm(w16(0x4512)).includes('c.lwsp\ta0,4(sp)'));
  // c.swsp a0,4(sp): Q2 funct3=110 rs2=10 uimm=4 (uimm[5:2]=0001,uimm[7:6]=00)
  // inst[12:9]=0001 inst[8:7]=00 inst[6:2]=01010 inst[1:0]=10
  // = (6<<13)|(1<<9)|(0<<7)|(10<<2)|2 = 0xC000|0x200|0|0x28|2 = 0xC22A
  assert.ok(disasm(w16(0xC22A)).includes('c.swsp\ta0,4(sp)'));
  // c.mv a0,a1: Q2 funct3=100 bit12=0 rd=10 rs2=11
  // = (4<<13)|0|(10<<7)|(11<<2)|2 = 0x8000|0x500|0x2c|2 = 0x852E
  assert.ok(disasm(w16(0x852E)).includes('c.mv\ta0,a1'));
  // c.add a0,a1: same but bit12=1
  // = (4<<13)|(1<<12)|(10<<7)|(11<<2)|2 = 0x8000|0x1000|0x500|0x2c|2 = 0x952E
  assert.ok(disasm(w16(0x952E)).includes('c.add\ta0,a1'));
  // c.jr a0: Q2 funct3=100 bit12=0 rd=10 rs2=0
  // = (4<<13)|0|(10<<7)|0|2 = 0x8000|0x500|2 = 0x8502
  assert.ok(disasm(w16(0x8502)).includes('c.jr\ta0'));
  // c.jalr a0: bit12=1 rd=10 rs2=0
  // = (4<<13)|(1<<12)|(10<<7)|0|2 = 0x8000|0x1000|0x500|2 = 0x9502
  assert.ok(disasm(w16(0x9502)).includes('c.jalr\ta0'));
  // c.ebreak = 0x9002
  assert.ok(disasm(w16(0x9002)).includes('c.ebreak'));
});

test('Disassembler should handle mixed 32-bit and 16-bit instructions', () => {
  // lui a5,0xe0000 (32-bit) followed by c.nop (16-bit)
  // lui: 0xe00007b7, c.nop: 0x0001
  const bytes = [
    0xb7, 0x07, 0x00, 0xe0,  // lui a5,0xe0000
    0x01, 0x00,               // c.nop
  ];
  const result = disasm(bytesToHexdump(bytes));
  assert.ok(result.includes('lui\ta5,0xe0000'));
  assert.ok(result.includes('c.nop'));
  // アドレスが正しくインクリメントされること: lui は4バイト→次は0x4、c.nopは2バイト
  assert.ok(result.includes('   0:'));  // lui at addr 0
  assert.ok(result.includes('   4:'));  // c.nop at addr 4
});

test('Disassembler should not corrupt bytes from xxd ASCII section', () => {
  // xxd -g 1 形式: 各行は16バイト分のhex + ASCII表示
  // ASCII部分を slice(0,16) で切り捨てることで混入を防ぐ
  const xxdLine = '000001b0: 73 90 17 34 73 00 20 30 00 00 00 00 00 00 00 00  s% 4s. 0........';
  const result = disasm(xxdLine);
  // アドレス0x1b0から始まる正しいバイト列が使われること
  // 0x34179073 = csrw mepc,a5
  assert.ok(result.includes('csrw\tmepc,a5'));
  // ASCII部分("s%"など)が17バイト目以降として混入しないこと
  assert.ok(!result.includes('.word'));
});
