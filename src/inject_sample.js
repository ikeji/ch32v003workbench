#!/usr/bin/env node
// index.html の SAMPLE_XXX テンプレートリテラルをサンプルファイルの内容で置き換える
const fs = require('fs');

const samples = {
  SAMPLE_BLINK:  'sample.c',
  SAMPLE_SQUARE: 'test/fixtures/oled_square.c',
  SAMPLE_BADGE:  'test/fixtures/badge.c',
};

let html = fs.readFileSync('index.html', 'utf8');
let changed = false;

for (const [varName, filePath] of Object.entries(samples)) {
  if (!fs.existsSync(filePath)) {
    console.log(`skip: ${filePath} not found`);
    continue;
  }
  const content = fs.readFileSync(filePath, 'utf8').trimEnd();
  const re = new RegExp('const ' + varName + ' = `[\\s\\S]*?`;');
  if (!re.test(html)) {
    console.error(`Error: ${varName} marker not found in index.html`);
    continue;
  }
  const updated = html.replace(re, 'const ' + varName + ' = `' + content + '`;');
  if (updated !== html) {
    html = updated;
    changed = true;
    console.log(`${varName} ← ${filePath}`);
  } else {
    console.log(`${varName}: no change`);
  }
}

if (changed) {
  fs.writeFileSync('index.html', html);
  console.log('index.html updated');
} else {
  console.log('no changes');
}
