const PIN_LED = PC0;

func main()
{
	SystemInit();

	funGpioInitAll(); // Enable GPIOs
	
	funPinMode( PIN_LED, GPIO_Speed_10MHz | GPIO_CNF_OUT_PP );

	loop
	{
		funDigitalWrite( PIN_LED, FUN_HIGH );
		Delay_Ms( 250 );
		funDigitalWrite( PIN_LED, FUN_LOW );
		Delay_Ms( 250 );
	}
}

const PC0 = 32;
const GPIO_Speed_10MHz = 1;
const GPIO_CNF_OUT_PP = 0;
const FUN_LOW = 0;
const FUN_HIGH = 1;

func SystemInit() {
	const FLASH_ACTLR = 0x40022000;
	const RCC_CTLR    = 0x40021000;
	const RCC_CFGR0   = 0x40021004;
	const RCC_INTR    = 0x40021008;
	const STK_CTLR    = 0xE000F000;

	const RCC_PLLRDY  = 0b10000000000000000000000000; // bit 25
	const RCC_SW_PLL  = 0b00000000000000000000000010; // bit 1
	const RCC_SWS_PLL = 0b00000000000000000000001000; // bit 3 (SWS bits are 3:2)

	// FLASH_ACTLR = 1 (Latency 1 for 48MHz)
	poke(FLASH_ACTLR, 1);

	// RCC_CFGR0 = 0 (clear clock config before enabling PLL)
	poke(RCC_CFGR0, 0);

	// RCC_CTLR = HSION | PLLON | HSITRIM_default (0x1080081)
	poke(RCC_CTLR, 0x1080081);

	// Clear PLL, CSSC, HSE, HSI and LSI ready flags
	poke(RCC_INTR, 0x009F0000);

	// Wait for RCC_PLLRDY
	loop {
		if (peek(RCC_CTLR) & RCC_PLLRDY) break;
	}

	// RCC_CFGR0: clear SW bits then select PLL as system clock source
	poke(RCC_CFGR0, (peek(RCC_CFGR0) & ~0b11) | RCC_SW_PLL);

	// Wait for RCC_SWS_PLL (System Clock Switch Status)
	loop {
		if ((peek(RCC_CFGR0) & 0b1100) == RCC_SWS_PLL) break;
	}

	// STK_CTLR = 1 (Enable SysTick, HCLK/8)
	poke(STK_CTLR, 1);
}

func funGpioInitAll() {
	const RCC_APB2PCENR = 0x40021018;
	const RCC_AFIOEN    = 0b000001; // bit 0
	const RCC_IOPAEN    = 0b000100; // bit 2
	const RCC_IOPCEN    = 0b010000; // bit 4
	const RCC_IOPDEN    = 0b100000; // bit 5

	// Enable AFIO, GPIOA, GPIOC, GPIOD
	poke(RCC_APB2PCENR, peek(RCC_APB2PCENR) | RCC_AFIOEN | RCC_IOPAEN | RCC_IOPCEN | RCC_IOPDEN);
}

func funPinMode(pin, mode) {
	const GPIO_BASE_START = 0x40010800;
	var gpio_base = GPIO_BASE_START + ((pin >> 4) << 10);
	var pin_num = pin & 7;
	var shift = pin_num << 2;

	poke(gpio_base, (peek(gpio_base) & (~(0b1111 << shift))) | ((mode & 0b1111) << shift));
}

func funDigitalWrite(pin, mode) {
	const GPIO_BASE_START = 0x40010800;
	const GPIO_BSHR_OFFSET = 16;
	var gpio_base = GPIO_BASE_START + ((pin >> 4) << 10);
	var pin_num = pin & 15;

	if (mode) {
		poke(gpio_base + GPIO_BSHR_OFFSET, 1 << pin_num); // BSHR set
	} else {
		poke(gpio_base + GPIO_BSHR_OFFSET, 1 << (pin_num + 16)); // BSHR reset
	}
}

func Delay_Ms(ms) {
	const STK_CNT = 0xE000F008;
	const TICKS_PER_MS = 6000; // 48MHz / 8 / 1000

	var end_time = peek(STK_CNT) + ms * TICKS_PER_MS;
	loop {
		// Handle wrapping by comparing distance as signed 32-bit (threshold is 2^31)
		if ((peek(STK_CNT) - end_time) < 0b10000000000000000000000000000000) break;
	}
}
