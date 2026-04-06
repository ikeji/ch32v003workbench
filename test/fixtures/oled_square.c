// SSD1306 I2C OLED に四角形を描画するサンプル

const SSD1306_W = 128;
const SSD1306_H = 64;
const SSD1306_ADDR = 0x3C;
const FRAMEBUF = 0x20000000;
const FRAMEBUF_SIZE = 1024;
const SCRATCH = 0x20000400;
const I2C1 = 0x40005400;
const I2C_TIMEOUT = 100000;
const RCC = 0x40021000;
const GPIOC = 0x40011000;

data SSD1306_INIT = {
    0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40,
    0x8D, 0x14, 0x20, 0x00, 0xA1, 0xC8, 0xDA, 0x12,
    0x81, 0x8F, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6,
    0xAF, 0xFF
};

func main() {
    SystemInit();
    funGpioInitAll();
    ssd1306_i2c_init();
    ssd1306_init();

    // 外枠
    draw_rect(0, 0, 127, 63, 1);
    // 内側の四角
    draw_rect(10, 10, 117, 53, 1);
    // 中央の塗りつぶし四角
    fill_rect(30, 20, 97, 43, 1);
    // 塗りつぶしの中にくり抜き
    fill_rect(45, 26, 82, 37, 0);

    ssd1306_refresh();
    loop { }
}

// --- 描画関数 ---

func draw_rect(x0, y0, x1, y1, color) {
    draw_hline(x0, x1, y0, color);
    draw_hline(x0, x1, y1, color);
    draw_vline(x0, y0, y1, color);
    draw_vline(x1, y0, y1, color);
}

func fill_rect(x0, y0, x1, y1, color) {
    var y = y0;
    loop {
        if (y > y1) break;
        draw_hline(x0, x1, y, color);
        y = y + 1;
    }
}

func draw_hline(x0, x1, y, color) {
    var x = x0;
    loop {
        if (x > x1) break;
        ssd1306_drawPixel(x, y, color);
        x = x + 1;
    }
}

func draw_vline(x, y0, y1, color) {
    var y = y0;
    loop {
        if (y > y1) break;
        ssd1306_drawPixel(x, y, color);
        y = y + 1;
    }
}

// --- SSD1306 ---

func ssd1306_drawPixel(x, y, color) {
    if (x >= SSD1306_W) return 0;
    if (y >= SSD1306_H) return 0;
    var addr = FRAMEBUF + x + (y / 8) * SSD1306_W;
    var mask = 1 << (y & 7);
    if (color) {
        poke8(addr, peek8(addr) | mask);
    } else {
        poke8(addr, peek8(addr) & ~mask);
    }
    return 0;
}

func ssd1306_setbuf(color) {
    var val = 0;
    if (color) { val = 0xFF; }
    var i = 0;
    loop {
        if (i >= FRAMEBUF_SIZE) break;
        poke8(FRAMEBUF + i, val);
        i = i + 1;
    }
}

func ssd1306_init() {
    ssd1306_setbuf(0);
    var i = 0;
    loop {
        var cmd = peek8(SSD1306_INIT + i);
        if (cmd == 0xFF) break;
        ssd1306_cmd(cmd);
        i = i + 1;
    }
    ssd1306_refresh();
}

func ssd1306_refresh() {
    ssd1306_cmd(0x21); ssd1306_cmd(0); ssd1306_cmd(127);
    ssd1306_cmd(0x22); ssd1306_cmd(0); ssd1306_cmd(7);
    var offset = 0;
    loop {
        if (offset >= FRAMEBUF_SIZE) break;
        poke8(SCRATCH, 0x40);
        var j = 0;
        loop {
            if (j >= 32) break;
            poke8(SCRATCH + 1 + j, peek8(FRAMEBUF + offset + j));
            j = j + 1;
        }
        i2c_send(SSD1306_ADDR, SCRATCH, 33);
        offset = offset + 32;
    }
}

func ssd1306_cmd(cmd) {
    poke8(SCRATCH, 0x00);
    poke8(SCRATCH + 1, cmd);
    return i2c_send(SSD1306_ADDR, SCRATCH, 2);
}

// --- I2C ---

func ssd1306_i2c_init() {
    poke(RCC + 0x1C, peek(RCC + 0x1C) | 0x200);
    poke(RCC + 0x18, peek(RCC + 0x18) | 0x11);
    poke(GPIOC, (peek(GPIOC) & ~(0x0F << 4)) | (0x0D << 4));
    poke(GPIOC, (peek(GPIOC) & ~(0x0F << 8)) | (0x0D << 8));
    i2c_setup();
}

func i2c_setup() {
    poke(RCC + 0x10, peek(RCC + 0x10) | 0x200);
    poke(RCC + 0x10, peek(RCC + 0x10) & ~0x200);
    poke16(I2C1 + 0x04, (peek16(I2C1 + 0x04) & 0xFFC0) | 24);
    poke16(I2C1 + 0x1C, 0xC001);
    poke16(I2C1, peek16(I2C1) | 0x01);
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

// --- システム初期化 ---

func SystemInit() {
    poke(0x40022000, 1);
    poke(RCC, peek(RCC) | (1 << 24));
    loop { if (peek(RCC) & (1 << 25)) break; }
    poke(RCC + 0x04, peek(RCC + 0x04) | 2);
    loop { if ((peek(RCC + 0x04) & 0x0C) == 8) break; }
    poke(0xE000F000, 1);
}

func funGpioInitAll() {
    poke(RCC + 0x18, peek(RCC + 0x18) | 0x35);
}
