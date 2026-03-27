#!/usr/bin/env node
const fs = require('fs');
const { StackGenerator } = require('./stackgen');

function main() {
  const input = fs.readFileSync(0, 'utf-8');
  if (!input) return;
  try {
    const ast = JSON.parse(input);
    const stackgen = new StackGenerator();
    const ir = stackgen.generate(ast);
    console.log(JSON.stringify(ir, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
