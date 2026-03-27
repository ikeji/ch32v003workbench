
SRC_DIR  = src
TEST_DIR = test
SAMPLE   = sample.c

RISCV_AS       = riscv64-unknown-elf-as
RISCV_LD       = riscv64-unknown-elf-ld
RISCV_OBJCOPY  = riscv64-unknown-elf-objcopy
RISCV_OBJDUMP  = riscv64-unknown-elf-objdump
RISCV_ASFLAGS  = -march=rv32em -mabi=ilp32e
RISCV_LDFLAGS  = -T link.ld -m elf32lriscv

.PHONY: all test clean run

all: test

test:
	@echo "Running unit and pipeline tests..."
	node --test $(TEST_DIR)/*.test.js

# Full pipeline (順次実行)
run:
	@echo "--- Compiling $(SAMPLE) ---"
	cat $(SAMPLE) | node $(SRC_DIR)/parser_cli.js > build/ast.json
	cat build/ast.json | node $(SRC_DIR)/stackgen_cli.js > build/stack_code.json
	cat build/stack_code.json | node $(SRC_DIR)/asmgen_cli.js > build/source.asm
	cat build/source.asm | node $(SRC_DIR)/assembler_cli.js > build/output.hex
	$(RISCV_AS) $(RISCV_ASFLAGS) build/source.asm -o build/output-gcc.o
	$(RISCV_LD) $(RISCV_LDFLAGS) build/output-gcc.o -o build/output-gcc.elf
	@echo "--- Disassembling (custom as + custom disasm) ---"
	cat build/output.hex | node $(SRC_DIR)/disassembler_cli.js > build/disasm.txt
	@echo "--- Disassembling (gcc as + gcc objdump) ---"
	$(RISCV_OBJDUMP) -d -z build/output-gcc.elf > build/disasm-gcc.txt
	@echo "--- Disassembling (gcc as + custom disasm) ---"
	$(RISCV_OBJCOPY) -O binary build/output-gcc.elf build/output-gcc.bin
	xxd -g 1 build/output-gcc.bin | node $(SRC_DIR)/disassembler_cli.js > build/disasm-gcc-custom.txt
	@echo "--- Disassembling (custom as + gcc objdump) ---"
	xxd -r build/output.hex > build/output.bin
	$(RISCV_OBJDUMP) -b binary -m riscv:rv32 -D build/output.bin > build/disasm-custom-gcc.txt
	@echo "--- Running in VM ---"
	cat build/output.hex | node $(SRC_DIR)/vm_cli.js

# Ensure build directory exists
$(shell mkdir -p build)

clean:
	rm -rf build/*.json build/*.asm build/*.hex build/*.bin build/*.txt build/*.o build/*.elf
