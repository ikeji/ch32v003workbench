
func main() {
    const PC0 = 32;
    const GPIO_BASE = 0x40010800;
    
    // CFGLR: Output 10MHz Push-Pull
    poke(GPIO_BASE, 1);

    loop {
        // BSHR: Set Pin 0 High
        poke(GPIO_BASE + 16, 1);
        // Delay (Simplified)
        var i = 0;
        loop {
            i = i + 1;
            if (i == 10) break;
        }
        // BSHR: Set Pin 0 Low
        poke(GPIO_BASE + 16, 1 << 16);
        i = 0;
        loop {
            i = i + 1;
            if (i == 10) break;
        }
    }
}
