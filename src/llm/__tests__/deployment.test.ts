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

/** What the entrypoint's sed does when LLM_UPSTREAM is unset. */
const stripped = template
  .split('\n')
  .reduce<{ out: string[]; skipping: boolean }>((acc, line) => {
    if (line.includes('# LLM_BLOCK_START')) return { ...acc, skipping: true };
    if (line.includes('# LLM_BLOCK_END')) return { ...acc, skipping: false };
    if (!acc.skipping) acc.out.push(line);
    return acc;
  }, { out: [], skipping: false })
  .out.join('\n');

/** What envsubst does with an explicit single-variable list. */
const substituted = template.replace(/\$\{LLM_UPSTREAM\}/g, 'vllm:8000');

describe('nginx template — proxy enabled', () => {
  it('resolves the upstream into a proxy_pass', () => {
    expect(substituted).toContain('proxy_pass http://vllm:8000/;');
  });

  it('leaves no unsubstituted placeholders', () => {
    expect(substituted).not.toMatch(/\$\{/);
  });

  it('keeps nginx runtime variables intact', () => {
    // envsubst is called with an explicit var list precisely so these survive.
    // They use $name, not ${name}, so the substitution cannot touch them.
    expect(substituted).toContain('try_files $uri $uri/ /index.html;');
    expect(substituted).toContain('proxy_set_header Host $host;');
    expect(template).not.toMatch(/\$\{(?!LLM_UPSTREAM)/);
  });

  it('disables buffering, without which the stream arrives in one lump', () => {
    expect(substituted).toContain('proxy_buffering off;');
  });

  it('allows a long read timeout for generations on a shared GPU', () => {
    expect(substituted).toMatch(/proxy_read_timeout\s+600s;/);
  });

  it('keeps the COEP header the tree-sitter WASM loader depends on', () => {
    expect(substituted).toContain('Cross-Origin-Embedder-Policy "require-corp"');
  });
});

describe('nginx template — proxy disabled', () => {
  it('removes every proxy directive, so nginx starts with no upstream', () => {
    // A location whose upstream cannot resolve stops nginx booting entirely,
    // which would take the whole app down over an optional feature.
    expect(stripped).not.toContain('proxy_pass');
    expect(stripped).not.toContain('/llm/');
    expect(stripped).not.toContain('LLM_UPSTREAM');
  });

  it('leaves no dangling comment about a proxy that is not there', () => {
    expect(stripped.toLowerCase()).not.toContain('llm');
  });

  it('still serves the app and the WASM MIME type', () => {
    expect(stripped).toContain('try_files $uri $uri/ /index.html;');
    expect(stripped).toContain('application/wasm');
  });

  it('keeps balanced braces after the strip', () => {
    const open = (stripped.match(/\{/g) ?? []).length;
    const close = (stripped.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });
});

describe('docker-entrypoint.sh', () => {
  it('substitutes only LLM_UPSTREAM, protecting nginx variables', () => {
    expect(entrypoint).toContain("envsubst '${LLM_UPSTREAM}'");
  });

  it('strips the block on the unset branch rather than emitting a broken upstream', () => {
    expect(entrypoint).toMatch(/sed .*LLM_BLOCK_START.*LLM_BLOCK_END.*d/);
  });

  it('validates the rendered config before starting, so failures are loud', () => {
    expect(entrypoint).toContain('nginx -t');
    expect(entrypoint).toContain('set -e');
  });

  it('execs the CMD so nginx receives signals as PID 1', () => {
    expect(entrypoint).toMatch(/exec "\$@"/);
  });
});
