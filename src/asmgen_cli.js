#!/usr/bin/env node
const fs = require('fs');
const { AssemblerGenerator } = require('./asmgen');

function main() {
  const input = fs.readFileSync(0, 'utf-8');
  if (!input) return;
  try {
    const instructions = JSON.parse(input);
    const asmgen = new AssemblerGenerator();
    const asm = asmgen.generate(instructions);
    process.stdout.write(asm + "\n");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
