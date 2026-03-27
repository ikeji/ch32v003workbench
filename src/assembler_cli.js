#!/usr/bin/env node
const fs = require('fs');
const { Assembler } = require('./assembler');

function main() {
  const input = fs.readFileSync(0, 'utf-8');
  if (!input) return;
  try {
    const assembler = new Assembler();
    const result = assembler.assemble(input);
    process.stdout.write(result);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
