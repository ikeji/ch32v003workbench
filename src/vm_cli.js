#!/usr/bin/env node
const fs = require('fs');
const { VM } = require('./vm');
const { Disassembler } = require('./disassembler');

const REV_REG_MAP = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
  's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5'
];

function main() {
  const input = fs.readFileSync(0, 'utf-8');
  if (!input) return;

  const disasm = new Disassembler();
  const startTime = Date.now();

  const vm = new VM(
    input,
    () => {
      // Simulation ticks based on steps to speed up execution
      return (steps * 1000) >>> 0;
    },
    (addr, val) => {
      // GPIO: Write to 0x400108xx area
      const port = addr >= 0x40010800 && addr < 0x40010c00 ? "A" :
                   addr >= 0x40010c00 && addr < 0x40011000 ? "B" :
                   addr >= 0x40011000 && addr < 0x40011400 ? "C" : "D";
      const offset = addr & 0x3ff;
      
      if (offset === 0) { // CFGLR
         console.log(`GPIO: Port ${port} を出力設定 (0x${val.toString(16)}) にしました。`);
      } else if (offset === 16) { // BSHR
         const setBits = val & 0xffff;
         const resetBits = val >> 16;
         if (setBits) {
           const pin = Math.log2(setBits);
           console.log(`GPIO: Port ${port} Pin ${pin.toFixed(0)} を High にしました。`);
         } else if (resetBits) {
           const pin = Math.log2(resetBits);
           console.log(`GPIO: Port ${port} Pin ${pin.toFixed(0)} を Low にしました。`);
         }
      }
    },
    (msg) => {
      // General VM log callback
      if (msg.startsWith("memWrite")) {
        const regs = Array.from(vm.regs).map((v, i) => `${REV_REG_MAP[i]}=0x${(v >>> 0).toString(16)}`).join(" ");
        console.log(`Detail: ${msg} | ${regs}`);
      } else {
        console.log(`Detail: ${msg}`);
      }
    },
    (addr, data) => {
      // I2C callback
      const hex = data.map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`I2C: addr=0x${addr.toString(16)} data=[${hex}] (${data.length} bytes)`);
    }
  );

  let steps = 0;
  // Step execution loop
  while (steps < 100000) { // High limit for complex programs
    const pc = vm.pc;
    const word = vm.read32(pc);
    if (word === 0) break; // Stop at end of program
    
    // Disassemble for display
    const decoded = disasm.decode(word, pc);
    console.log(`PC: 0x${pc.toString(16).padStart(8, '0')}`);
    console.log(`Instruction: ${decoded}`);
    
    // Execute
    if (!vm.step()) break;
    
    steps++;
    if (steps % 100 === 0) {
      // Optional: Add small delay or just keep running
    }
  }
  console.log(`\nVM halted after ${steps} steps. PC: 0x${vm.pc.toString(16)}`);
}

main();
