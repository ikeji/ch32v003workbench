#!/usr/bin/env node
const fs = require('fs');
const { Disassembler } = require('./disassembler');

function main() {
  const input = fs.readFileSync(0, 'utf-8');
  if (!input) return;
  try {
    const disassembler = new Disassembler();
    const result = disassembler.disassemble(input);
    process.stdout.write(result + "\n");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
