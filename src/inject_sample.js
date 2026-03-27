#!/usr/bin/env node
// index.html の SAMPLE_BLINK を sample.c の内容で置き換える
const fs = require('fs');
const sample = fs.readFileSync('sample.c', 'utf8').trimEnd();
let html = fs.readFileSync('index.html', 'utf8');
if (!/const SAMPLE_BLINK = `[\s\S]*?`;/.test(html)) {
  console.error('Error: SAMPLE_BLINK marker not found in index.html');
  process.exit(1);
}
const updated = html.replace(
  /const SAMPLE_BLINK = `[\s\S]*?`;/,
  'const SAMPLE_BLINK = `' + sample + '`;'
);
if (updated === html) {
  console.log('sample.c は既に index.html と同じ内容です（変更なし）');
} else {
  fs.writeFileSync('index.html', updated);
  console.log('sample.c を index.html に挿入しました');
}
