// Copies required WASM files to public/ after npm install.
// Run automatically via the "postinstall" npm script.
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const publicDir = join(root, 'public');

mkdirSync(publicDir, { recursive: true });

const copies = [
  ['node_modules/web-tree-sitter/tree-sitter.wasm', 'public/tree-sitter.wasm'],
  ['node_modules/tree-sitter-wasms/out/tree-sitter-c.wasm', 'public/tree-sitter-c.wasm'],
];

for (const [src, dest] of copies) {
  const srcPath = join(root, src);
  const destPath = join(root, dest);
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, destPath);
    console.log(`Copied ${src} → ${dest}`);
  } else {
    console.warn(`Warning: ${src} not found, skipping`);
  }
}
