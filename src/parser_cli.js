#!/usr/bin/env node
const fs = require('fs');
const { Tokenizer, Parser } = require('./parser');

function main() {
  const source = fs.readFileSync(0, 'utf-8');
  if (!source) return;
  try {
    const tokenizer = new Tokenizer(source);
    const parser = new Parser(tokenizer);
    const ast = parser.parse();
    console.log(JSON.stringify(ast, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
