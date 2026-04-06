
const test = require('node:test');
const assert = require('node:assert');
const { Assembler } = require('../src/assembler');
const { VM } = require('../src/vm');

test('VM should execute basic math', () => {
  const assembler = new Assembler();
  const asm = `
    li a0, 10
    li a1, 20
    add a2, a0, a1
    sub a3, a1, a0
  `;
  const hexdump = assembler.assemble(asm);
  const vm = new VM(hexdump);
  
  while (vm.step());
  
  assert.strictEqual(vm.regs[10], 10); // a0
  assert.strictEqual(vm.regs[11], 20); // a1
  assert.strictEqual(vm.regs[12], 30); // a2 (10 + 20)
  assert.strictEqual(vm.regs[13], 10); // a3 (20 - 10)
});

test('VM should handle branches', () => {
  const assembler = new Assembler();
  const asm = `
    li a0, 5
    li a1, 0
    loop:
      addi a1, a1, 1
      bne a1, a0, loop
  `;
  const hexdump = assembler.assemble(asm);
  const vm = new VM(hexdump);
  
  // Running with a limit to avoid infinite loop
  let steps = 0;
  while (vm.step() && steps < 100) steps++;
  
  assert.strictEqual(vm.regs[11], 5); // a1 should be 5
});

test('VM should handle memory access in SRAM', () => {
  const assembler = new Assembler();
  const asm = `
    li t0, 0x20000000
    li t1, 123
    sw t1, 0(t0)
    lw t2, 0(t0)
  `;
  const hexdump = assembler.assemble(asm);
  const vm = new VM(hexdump);

  while (vm.step());

  assert.strictEqual(vm.regs[7], 123); // t2 should be 123
});

test('VM I2C callback should receive address and data', () => {
  const assembler = new Assembler();
  // Simulate I2C transaction:
  // 1. Write START to CTLR1 (0x40005400)
  // 2. Write address to DATAR (0x40005410)
  // 3. Write data byte to DATAR
  // 4. Write STOP to CTLR1
  const asm = `
    li t0, 0x40005400
    li t1, 0x100
    sh t1, 0(t0)
    li t1, 0x78
    sh t1, 16(t0)
    li t1, 0xAE
    sh t1, 16(t0)
    li t1, 0x200
    sh t1, 0(t0)
  `;
  const hexdump = assembler.assemble(asm);
  const calls = [];
  const vm = new VM(hexdump, null, null, null, (addr, data) => {
    calls.push({ addr, data: [...data] });
  });

  while (vm.step());

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].addr, 0x3C); // 0x78 >> 1
  assert.deepStrictEqual(calls[0].data, [0xAE]);
});

test('VM I2C registers should be readable', () => {
  const assembler = new Assembler();
  // Write to CTLR2 then read it back
  const asm = `
    li t0, 0x40005400
    li t1, 24
    sh t1, 4(t0)
    lhu t2, 4(t0)
  `;
  const hexdump = assembler.assemble(asm);
  const vm = new VM(hexdump);

  while (vm.step());

  assert.strictEqual(vm.regs[7], 24); // t2 = CTLR2 readback
});

test('VM I2C should work with compiled TinyC i2c_send', () => {
  // Minimal TinyC program that sends I2C data
  const { Tokenizer, Parser } = require('../src/parser');
  const { StackGenerator } = require('../src/stackgen');
  const { AssemblerGenerator } = require('../src/asmgen');

  const source = `
const I2C1 = 0x40005400;
const I2C_TIMEOUT = 1000;

func main() {
    i2c_setup();
    ssd1306_cmd(0xAE);
    ssd1306_cmd(0xAF);
}

func i2c_setup() {
    poke16(I2C1 + 0x04, 24);
    poke16(I2C1 + 0x1C, 0xC001);
    poke16(I2C1, 0x01);
    poke16(I2C1, peek16(I2C1) | 0x0400);
}

func i2c_wait_busy() {
    var timeout = I2C_TIMEOUT;
    loop {
        if ((peek16(I2C1 + 0x18) & 0x02) == 0) return 1;
        timeout = timeout - 1;
        if (timeout == 0) return 0;
    }
}

func i2c_start() {
    poke16(I2C1, peek16(I2C1) | 0x100);
    var timeout = I2C_TIMEOUT;
    loop {
        var star1 = peek16(I2C1 + 0x14);
        var star2 = peek16(I2C1 + 0x18);
        var event = star1 | (star2 << 16);
        if ((event & 0x00030001) == 0x00030001) return 1;
        timeout = timeout - 1;
        if (timeout == 0) return 0;
    }
}

func i2c_send_addr(addr) {
    poke16(I2C1 + 0x10, addr << 1);
    var timeout = I2C_TIMEOUT;
    loop {
        var star1 = peek16(I2C1 + 0x14);
        var star2 = peek16(I2C1 + 0x18);
        var event = star1 | (star2 << 16);
        if ((event & 0x00070082) == 0x00070082) return 1;
        timeout = timeout - 1;
        if (timeout == 0) return 0;
    }
}

func i2c_send_byte(b) {
    var timeout = I2C_TIMEOUT;
    loop {
        if (peek16(I2C1 + 0x14) & 0x80) break;
        timeout = timeout - 1;
        if (timeout == 0) return 0;
    }
    poke16(I2C1 + 0x10, b);
    return 1;
}

func i2c_wait_done() {
    var timeout = I2C_TIMEOUT;
    loop {
        var star1 = peek16(I2C1 + 0x14);
        var star2 = peek16(I2C1 + 0x18);
        var event = star1 | (star2 << 16);
        if (event & 0x00070084) return 1;
        timeout = timeout - 1;
        if (timeout == 0) return 0;
    }
}

func i2c_stop() {
    poke16(I2C1, peek16(I2C1) | 0x200);
}

func i2c_send(addr, data_addr, sz) {
    i2c_wait_busy();
    i2c_start();
    i2c_send_addr(addr);
    var i = 0;
    loop {
        if (i >= sz) break;
        i2c_send_byte(peek8(data_addr + i));
        i = i + 1;
    }
    i2c_wait_done();
    i2c_stop();
    return 0;
}

func ssd1306_cmd(cmd) {
    poke8(0x20000400, 0x00);
    poke8(0x20000401, cmd);
    return i2c_send(0x3C, 0x20000400, 2);
}
`;

  const tok = new Tokenizer(source);
  const par = new Parser(tok);
  const ast = par.parse();
  const ir = new StackGenerator().generate(ast);
  const asm = new AssemblerGenerator().generate(ir);
  const hexdump = new Assembler().assemble(asm);

  const calls = [];
  const vm = new VM(hexdump,
    () => 0,
    null,
    null,
    (addr, data) => { calls.push({ addr, data: [...data] }); }
  );

  let steps = 0;
  while (vm.step() && steps < 500000) steps++;

  // Should have received 2 I2C transactions (two ssd1306_cmd calls)
  assert.ok(calls.length >= 2, `Expected >=2 I2C calls, got ${calls.length}. Steps: ${steps}, PC: 0x${vm.pc.toString(16)}`);
  assert.strictEqual(calls[0].addr, 0x3C, 'First call should be to SSD1306 addr 0x3C');
  assert.deepStrictEqual(calls[0].data, [0x00, 0xAE], 'First cmd should be [0x00, 0xAE]');
  assert.strictEqual(calls[1].addr, 0x3C);
  assert.deepStrictEqual(calls[1].data, [0x00, 0xAF], 'Second cmd should be [0x00, 0xAF]');
});

test('VM I2C badge.c full pipeline should send SSD1306 init and framebuffer', () => {
  const fs = require('fs');
  const path = require('path');
  const { Tokenizer, Parser } = require('../src/parser');
  const { StackGenerator } = require('../src/stackgen');
  const { AssemblerGenerator } = require('../src/asmgen');

  const source = fs.readFileSync(path.join(__dirname, 'fixtures/badge.c'), 'utf-8');
  const tok = new Tokenizer(source);
  const ast = new Parser(tok).parse();
  const ir = new StackGenerator().generate(ast);
  const asm = new AssemblerGenerator().generate(ir);
  const hex = new Assembler().assemble(asm);

  const calls = [];
  const vm = new VM(hex,
    () => (steps * 1000) >>> 0, // timer
    null,
    null,
    (addr, data) => { calls.push({ addr, data: [...data] }); }
  );

  let steps = 0;
  while (vm.step() && steps < 20000000) steps++;

  // badge.c should:
  // 1. Send SSD1306 init commands (0xAE, 0xD5, 0x80, ...)
  // 2. Send column/page address commands
  // 3. Send framebuffer data (1024 bytes in 32-byte chunks)
  // Init sends setbuf(0)+refresh, then after ADC rng+draw, main sends another refresh

  assert.ok(calls.length > 0, `No I2C calls after ${steps} steps, PC=0x${vm.pc.toString(16)}`);

  // All calls should be to SSD1306 (addr 0x3C)
  for (const call of calls) {
    assert.strictEqual(call.addr, 0x3C, `Unexpected I2C addr: 0x${call.addr.toString(16)}`);
  }

  // First init command should be display off [0x00, 0xAE]
  const cmdCalls = calls.filter(c => c.data.length === 2 && c.data[0] === 0x00);
  assert.ok(cmdCalls.length > 0, 'Should have SSD1306 command calls (prefix 0x00)');
  assert.strictEqual(cmdCalls[0].data[1], 0xAE, 'First SSD1306 cmd should be 0xAE (display off)');

  // Should have at least 2 refresh cycles (init + image), each = 32 data chunks
  const dataCalls = calls.filter(c => c.data.length === 33 && c.data[0] === 0x40);
  assert.ok(dataCalls.length >= 64, `Expected >=64 data chunks (2 refreshes), got ${dataCalls.length}`);

  // Log summary
  console.log(`  badge.c: ${steps} steps, ${calls.length} I2C transactions, ${cmdCalls.length} cmds, ${dataCalls.length} data chunks`);
});

test('VM I2C OLED output image should match expected draw transformation', () => {
  const fs = require('fs');
  const path = require('path');
  const { Tokenizer, Parser } = require('../src/parser');
  const { StackGenerator } = require('../src/stackgen');
  const { AssemblerGenerator } = require('../src/asmgen');

  // Create a test image: simple checkerboard pattern (1024 bytes)
  const testImage = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) {
    testImage[i] = (i & 1) ? 0xAA : 0x55;
  }

  // Build data declaration string
  const imgHex = Array.from(testImage).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ');

  // Minimal TinyC program: init OLED, draw test image, refresh
  const source = `
data SSD1306_INIT = { 0xAE, 0xAF, 0xFF };
data TEST_IMG = { ${imgHex} };
const SSD1306_W = 128;
const SSD1306_H = 64;
const SSD1306_ADDR = 0x3C;
const FRAMEBUF = 0x20000000;
const FRAMEBUF_SIZE = 1024;
const SCRATCH = 0x20000400;
const I2C1 = 0x40005400;
const I2C_TIMEOUT = 1000;

func main() {
    i2c_setup();
    ssd1306_setbuf(0);
    draw(TEST_IMG);
    ssd1306_refresh();
}

func i2c_setup() {
    poke16(I2C1 + 0x04, 24);
    poke16(I2C1 + 0x1C, 0xC001);
    poke16(I2C1, 0x01);
    poke16(I2C1, peek16(I2C1) | 0x0400);
}
func i2c_wait_busy() {
    var timeout = I2C_TIMEOUT;
    loop { if ((peek16(I2C1 + 0x18) & 0x02) == 0) return 1; timeout = timeout - 1; if (timeout == 0) return 0; }
}
func i2c_start() {
    poke16(I2C1, peek16(I2C1) | 0x100);
    var timeout = I2C_TIMEOUT;
    loop { var s1 = peek16(I2C1 + 0x14); var s2 = peek16(I2C1 + 0x18); var ev = s1 | (s2 << 16); if ((ev & 0x00030001) == 0x00030001) return 1; timeout = timeout - 1; if (timeout == 0) return 0; }
}
func i2c_send_addr(addr) {
    poke16(I2C1 + 0x10, addr << 1);
    var timeout = I2C_TIMEOUT;
    loop { var s1 = peek16(I2C1 + 0x14); var s2 = peek16(I2C1 + 0x18); var ev = s1 | (s2 << 16); if ((ev & 0x00070082) == 0x00070082) return 1; timeout = timeout - 1; if (timeout == 0) return 0; }
}
func i2c_send_byte(b) {
    var timeout = I2C_TIMEOUT;
    loop { if (peek16(I2C1 + 0x14) & 0x80) break; timeout = timeout - 1; if (timeout == 0) return 0; }
    poke16(I2C1 + 0x10, b);
    return 1;
}
func i2c_wait_done() {
    var timeout = I2C_TIMEOUT;
    loop { var s1 = peek16(I2C1 + 0x14); var s2 = peek16(I2C1 + 0x18); var ev = s1 | (s2 << 16); if (ev & 0x00070084) return 1; timeout = timeout - 1; if (timeout == 0) return 0; }
}
func i2c_stop() { poke16(I2C1, peek16(I2C1) | 0x200); }
func i2c_send(addr, data_addr, sz) {
    i2c_wait_busy(); i2c_start(); i2c_send_addr(addr);
    var i = 0;
    loop { if (i >= sz) break; i2c_send_byte(peek8(data_addr + i)); i = i + 1; }
    i2c_wait_done(); i2c_stop(); return 0;
}
func ssd1306_cmd(cmd) {
    poke8(SCRATCH, 0x00); poke8(SCRATCH + 1, cmd);
    return i2c_send(SSD1306_ADDR, SCRATCH, 2);
}
func ssd1306_setbuf(color) {
    var val = 0; if (color) { val = 0xFF; }
    var i = 0; loop { if (i >= FRAMEBUF_SIZE) break; poke8(FRAMEBUF + i, val); i = i + 1; }
}
func ssd1306_refresh() {
    ssd1306_cmd(0x21); ssd1306_cmd(0); ssd1306_cmd(127);
    ssd1306_cmd(0x22); ssd1306_cmd(0); ssd1306_cmd(7);
    var offset = 0;
    loop { if (offset >= FRAMEBUF_SIZE) break;
        poke8(SCRATCH, 0x40); var j = 0;
        loop { if (j >= 32) break; poke8(SCRATCH + 1 + j, peek8(FRAMEBUF + offset + j)); j = j + 1; }
        i2c_send(SSD1306_ADDR, SCRATCH, 33); offset = offset + 32;
    }
}
func ssd1306_drawPixel(x, y, color) {
    if (x >= SSD1306_W) return 0; if (y >= SSD1306_H) return 0;
    var addr = FRAMEBUF + x + (y / 8) * SSD1306_W;
    var mask = 1 << (y & 7);
    if (color) { poke8(addr, peek8(addr) | mask); } else { poke8(addr, peek8(addr) & ~mask); }
    return 0;
}
func draw(img_addr) {
    var count = 0;
    loop { if (count >= 8192) break;
        var byte_pos = count / 8; var bit_pos = count & 7;
        var pixel = peek8(img_addr + byte_pos);
        var c = 1; if (pixel & (1 << bit_pos)) { c = 0; }
        var px = SSD1306_W - (count & 127);
        var py = SSD1306_H - count / SSD1306_W;
        ssd1306_drawPixel(px, py, c);
        count = count + 1;
    }
}
`;

  // Compile and run
  const tok = new Tokenizer(source);
  const ast = new Parser(tok).parse();
  const ir = new StackGenerator().generate(ast);
  const asm = new AssemblerGenerator().generate(ir);
  const hex = new Assembler().assemble(asm);

  const calls = [];
  const vm = new VM(hex, () => 0, null, null,
    (addr, data) => { calls.push({ addr, data: [...data] }); }
  );

  let steps = 0;
  while (vm.step() && steps < 100000000) steps++;

  // Extract framebuffer from I2C data chunks (last 32 chunks with prefix 0x40)
  const allDataChunks = calls.filter(c => c.data.length === 33 && c.data[0] === 0x40);
  assert.ok(allDataChunks.length >= 32, `Expected >=32 data chunks, got ${allDataChunks.length}`);

  // Take the last 32 chunks (the refresh after draw)
  const lastChunks = allDataChunks.slice(-32);
  const vmFramebuf = new Uint8Array(1024);
  for (let i = 0; i < 32; i++) {
    for (let j = 0; j < 32; j++) {
      vmFramebuf[i * 32 + j] = lastChunks[i].data[j + 1];
    }
  }

  // Compute expected framebuffer using the same algorithm as draw() + drawPixel()
  // in JavaScript (uint32_t semantics: all operations unsigned 32-bit)
  const expected = new Uint8Array(1024);
  for (let count = 0; count < 8192; count++) {
    const byte_pos = (count / 8) >>> 0;  // uint32 division
    const bit_pos = count & 7;
    const pixel = testImage[byte_pos];
    const c = (pixel & (1 << bit_pos)) ? 0 : 1;
    const px = 128 - (count & 127);
    const py = (64 - ((count / 128) >>> 0)) >>> 0;  // uint32 division, uint32 subtract
    // drawPixel bounds check (unsigned comparison)
    if ((px >>> 0) >= 128) continue;
    if ((py >>> 0) >= 64) continue;
    const addr = px + ((py >>> 3) * 128);
    const mask = 1 << (py & 7);
    if (c) {
      expected[addr] |= mask;
    } else {
      expected[addr] &= ~mask;
    }
  }

  // Compare
  let mismatches = 0;
  const firstMismatch = [];
  for (let i = 0; i < 1024; i++) {
    if (vmFramebuf[i] !== expected[i]) {
      mismatches++;
      if (firstMismatch.length < 5) {
        firstMismatch.push(`  [${i}] VM=0x${vmFramebuf[i].toString(16).padStart(2,'0')} expected=0x${expected[i].toString(16).padStart(2,'0')}`);
      }
    }
  }

  if (mismatches > 0) {
    console.log(`  ${mismatches}/1024 byte mismatches. First few:`);
    firstMismatch.forEach(l => console.log(l));
  }

  assert.strictEqual(mismatches, 0, `Framebuffer mismatch: ${mismatches}/1024 bytes differ`);
});

test('VM I2C badge.c IMG0 output should match expected transformation', () => {
  const fs = require('fs');
  const path = require('path');
  const { Tokenizer, Parser } = require('../src/parser');
  const { StackGenerator } = require('../src/stackgen');
  const { AssemblerGenerator } = require('../src/asmgen');

  // Load IMG0 data from the XBM file
  const xbm = fs.readFileSync(path.join(__dirname, '../firmware/image/img0.xbm'), 'utf-8');
  const xbmVals = xbm.match(/0x[0-9A-Fa-f]+/g).slice(2); // skip width/height
  const imgData = new Uint8Array(xbmVals.map(v => parseInt(v, 16)));
  const imgHex = Array.from(imgData).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ');

  // Minimal program: draw IMG0 and refresh
  const source = `
data TEST_IMG = { ${imgHex} };
const SSD1306_W = 128;
const SSD1306_H = 64;
const SSD1306_ADDR = 0x3C;
const FRAMEBUF = 0x20000000;
const FRAMEBUF_SIZE = 1024;
const SCRATCH = 0x20000400;
const I2C1 = 0x40005400;
const I2C_TIMEOUT = 1000;

func main() {
    i2c_setup();
    ssd1306_setbuf(0);
    draw(TEST_IMG);
    ssd1306_refresh();
}
func i2c_setup() { poke16(I2C1+0x04,24); poke16(I2C1+0x1C,0xC001); poke16(I2C1,0x01); poke16(I2C1,peek16(I2C1)|0x0400); }
func i2c_wait_busy() { var t=I2C_TIMEOUT; loop { if((peek16(I2C1+0x18)&0x02)==0) return 1; t=t-1; if(t==0) return 0; } }
func i2c_start() { poke16(I2C1,peek16(I2C1)|0x100); var t=I2C_TIMEOUT; loop { var s1=peek16(I2C1+0x14); var s2=peek16(I2C1+0x18); if(((s1|(s2<<16))&0x00030001)==0x00030001) return 1; t=t-1; if(t==0) return 0; } }
func i2c_send_addr(a) { poke16(I2C1+0x10,a<<1); var t=I2C_TIMEOUT; loop { var s1=peek16(I2C1+0x14); var s2=peek16(I2C1+0x18); if(((s1|(s2<<16))&0x00070082)==0x00070082) return 1; t=t-1; if(t==0) return 0; } }
func i2c_send_byte(b) { var t=I2C_TIMEOUT; loop { if(peek16(I2C1+0x14)&0x80) break; t=t-1; if(t==0) return 0; } poke16(I2C1+0x10,b); return 1; }
func i2c_wait_done() { var t=I2C_TIMEOUT; loop { var s1=peek16(I2C1+0x14); var s2=peek16(I2C1+0x18); if((s1|(s2<<16))&0x00070084) return 1; t=t-1; if(t==0) return 0; } }
func i2c_stop() { poke16(I2C1,peek16(I2C1)|0x200); }
func i2c_send(addr,da,sz) { i2c_wait_busy(); i2c_start(); i2c_send_addr(addr); var i=0; loop { if(i>=sz) break; i2c_send_byte(peek8(da+i)); i=i+1; } i2c_wait_done(); i2c_stop(); return 0; }
func ssd1306_cmd(c) { poke8(SCRATCH,0); poke8(SCRATCH+1,c); return i2c_send(SSD1306_ADDR,SCRATCH,2); }
func ssd1306_setbuf(color) { var v=0; if(color){v=0xFF;} var i=0; loop { if(i>=FRAMEBUF_SIZE) break; poke8(FRAMEBUF+i,v); i=i+1; } }
func ssd1306_refresh() { ssd1306_cmd(0x21); ssd1306_cmd(0); ssd1306_cmd(127); ssd1306_cmd(0x22); ssd1306_cmd(0); ssd1306_cmd(7); var o=0; loop { if(o>=FRAMEBUF_SIZE) break; poke8(SCRATCH,0x40); var j=0; loop { if(j>=32) break; poke8(SCRATCH+1+j,peek8(FRAMEBUF+o+j)); j=j+1; } i2c_send(SSD1306_ADDR,SCRATCH,33); o=o+32; } }
func ssd1306_drawPixel(x,y,color) { if(x>=SSD1306_W) return 0; if(y>=SSD1306_H) return 0; var addr=FRAMEBUF+x+(y/8)*SSD1306_W; var mask=1<<(y&7); if(color){poke8(addr,peek8(addr)|mask);}else{poke8(addr,peek8(addr)&~mask);} return 0; }
func draw(img) { var count=0; loop { if(count>=8192) break; var bp=count/8; var bi=count&7; var px=peek8(img+bp); var c=1; if(px&(1<<bi)){c=0;} ssd1306_drawPixel(SSD1306_W-(count&127), SSD1306_H-count/SSD1306_W, c); count=count+1; } }
`;

  const tok = new Tokenizer(source);
  const ast = new Parser(tok).parse();
  const ir = new StackGenerator().generate(ast);
  const asm = new AssemblerGenerator().generate(ir);
  const hex = new Assembler().assemble(asm);

  const calls = [];
  const vm = new VM(hex, () => 0, null, null,
    (addr, data) => { calls.push({ addr, data: [...data] }); }
  );
  let steps = 0;
  while (vm.step() && steps < 100000000) steps++;

  // Extract last 32 data chunks as framebuffer
  const dataChunks = calls.filter(c => c.data.length === 33 && c.data[0] === 0x40);
  assert.ok(dataChunks.length >= 32, `Expected >=32 data chunks, got ${dataChunks.length}`);
  const lastChunks = dataChunks.slice(-32);
  const vmFb = new Uint8Array(1024);
  for (let i = 0; i < 32; i++) {
    for (let j = 0; j < 32; j++) vmFb[i * 32 + j] = lastChunks[i].data[j + 1];
  }

  // Compute expected using same algorithm
  const expected = new Uint8Array(1024);
  for (let count = 0; count < 8192; count++) {
    const byte_pos = (count / 8) >>> 0;
    const bit_pos = count & 7;
    const c = (imgData[byte_pos] & (1 << bit_pos)) ? 0 : 1;
    const px = 128 - (count & 127);
    const py = (64 - ((count / 128) >>> 0)) >>> 0;
    if ((px >>> 0) >= 128 || (py >>> 0) >= 64) continue;
    const addr = px + (((py >>> 0) >>> 3) * 128);
    const mask = 1 << (py & 7);
    if (c) expected[addr] |= mask;
    else expected[addr] &= ~mask;
  }

  let mismatches = 0;
  const examples = [];
  for (let i = 0; i < 1024; i++) {
    if (vmFb[i] !== expected[i]) {
      mismatches++;
      if (examples.length < 10) {
        examples.push(`  [${i}] VM=0x${vmFb[i].toString(16).padStart(2,'0')} expected=0x${expected[i].toString(16).padStart(2,'0')}`);
      }
    }
  }
  if (mismatches > 0) {
    console.log(`  ${mismatches}/1024 bytes mismatch:`);
    examples.forEach(l => console.log(l));
  }
  assert.strictEqual(mismatches, 0, `IMG0 framebuffer: ${mismatches}/1024 bytes differ`);
});

test('VM I2C multi-byte transaction', () => {
  const assembler = new Assembler();
  const asm = `
    li t0, 0x40005400
    li t1, 0x100
    sh t1, 0(t0)
    li t1, 0x78
    sh t1, 16(t0)
    li t1, 0x00
    sh t1, 16(t0)
    li t1, 0xAE
    sh t1, 16(t0)
    li t1, 0x200
    sh t1, 0(t0)
  `;
  const hexdump = assembler.assemble(asm);
  const calls = [];
  const vm = new VM(hexdump, null, null, null, (addr, data) => {
    calls.push({ addr, data: [...data] });
  });

  while (vm.step());

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].addr, 0x3C);
  assert.deepStrictEqual(calls[0].data, [0x00, 0xAE]);
});
