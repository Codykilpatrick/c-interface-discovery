/**
 * The nginx template and entrypoint are deploy-time code that only executes on
 * the airgapped host, where a mistake is expensive to diagnose. These tests pin
 * the contract between the two so an edit to one cannot silently break the other.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const template = fs.readFileSync(path.resolve('nginx.conf.template'), 'utf8');
const entrypoint = fs.readFileSync(path.resolve('docker-entrypoint.sh'), 'utf8');

const lines = template.split('\n');
const start = lines.findIndex((l) => l.includes('# LLM_BLOCK_START'));
const end = lines.findIndex((l) => l.includes('# LLM_BLOCK_END'));
const block = lines.slice(start, end + 1).join('\n');
const outsideBlock = [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');

describe('nginx template', () => {
  it('has the markers the entrypoint strips between', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('confines everything LLM-related to that block, so the strip leaves valid config', () => {
    // A location whose upstream cannot resolve stops nginx booting entirely,
    // which would take the whole app down over an optional feature.
    expect(outsideBlock.toLowerCase()).not.toContain('llm');
    expect(outsideBlock).not.toContain('proxy_pass');
    expect((block.match(/\{/g) ?? []).length).toBe((block.match(/\}/g) ?? []).length);
  });

  it('uses only the one placeholder the entrypoint substitutes', () => {
    expect(block).toContain('proxy_pass http://${LLM_UPSTREAM}/;');
    expect(template).not.toMatch(/\$\{(?!LLM_UPSTREAM)/);
    // nginx's own $name variables use no braces, so envsubst cannot touch them.
    expect(outsideBlock).toContain('try_files $uri $uri/ /index.html;');
  });

  it('disables buffering and allows a long read timeout', () => {
    // Without these the whole answer arrives in one lump, or is cut off.
    expect(block).toContain('proxy_buffering off;');
    expect(block).toMatch(/proxy_read_timeout\s+600s;/);
    expect(block).toContain('client_max_body_size 10m;');
  });

  it('keeps the COEP header the tree-sitter WASM loader depends on', () => {
    expect(outsideBlock).toContain('Cross-Origin-Embedder-Policy "require-corp"');
  });
});

describe('docker-entrypoint.sh', () => {
  it('substitutes only LLM_UPSTREAM, protecting nginx variables', () => {
    expect(entrypoint).toContain("envsubst '${LLM_UPSTREAM}'");
  });

  it('replaces the block with a 404 when unset, so /llm/ does not serve index.html', () => {
    expect(entrypoint).toMatch(/LLM_BLOCK_START.*LLM_BLOCK_END/);
    expect(entrypoint).toContain('return 404');
  });

  it('validates the rendered config before starting, so failures are loud', () => {
    expect(entrypoint).toContain('nginx -t');
    expect(entrypoint).toContain('set -e');
  });

  it('execs the CMD so nginx receives signals as PID 1', () => {
    expect(entrypoint).toMatch(/exec "\$@"/);
  });
});
