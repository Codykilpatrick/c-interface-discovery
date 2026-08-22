import { describe, it, expect } from 'vitest';
import { SseParser, readTextChunks } from '../sse';
import { sseResponseBytes } from './mockServer';

describe('SseParser — framing', () => {
  it('extracts a single data payload', () => {
    expect(new SseParser().push('data: hello\n\n')).toEqual(['hello']);
  });

  it('extracts several payloads from one chunk', () => {
    expect(new SseParser().push('data: a\n\ndata: b\n\ndata: c\n\n')).toEqual(['a', 'b', 'c']);
  });

  it('reassembles a payload split across chunks', () => {
    const p = new SseParser();
    expect(p.push('data: hel')).toEqual([]);
    expect(p.push('lo\n\n')).toEqual(['hello']);
  });

  it('reassembles a payload split on the newline itself', () => {
    const p = new SseParser();
    expect(p.push('data: hello\n')).toEqual(['hello']);
    expect(p.push('\ndata: world\n\n')).toEqual(['world']);
  });

  it('reassembles JSON split mid-object across three chunks', () => {
    const p = new SseParser();
    expect(p.push('data: {"cho')).toEqual([]);
    expect(p.push('ices":[{"delta":{"content":"x')).toEqual([]);
    expect(p.push('"}}]}\n\n')).toEqual(['{"choices":[{"delta":{"content":"x"}}]}']);
  });

  it('handles CRLF line endings', () => {
    expect(new SseParser().push('data: hello\r\n\r\n')).toEqual(['hello']);
  });

  it('ignores comment and keep-alive lines', () => {
    expect(new SseParser().push(': ping\n\ndata: real\n\n')).toEqual(['real']);
  });

  it('ignores non-data fields', () => {
    expect(new SseParser().push('event: message\nid: 7\nretry: 100\ndata: payload\n\n')).toEqual(['payload']);
  });

  it('preserves a payload that is itself empty', () => {
    expect(new SseParser().push('data:\n\n')).toEqual(['']);
  });

  it('strips only one leading space after the colon', () => {
    expect(new SseParser().push('data:  two-spaces\n\n')).toEqual([' two-spaces']);
  });

  it('does not emit a trailing partial line until flushed', () => {
    const p = new SseParser();
    expect(p.push('data: complete\n\ndata: partial')).toEqual(['complete']);
    expect(p.flush()).toEqual(['partial']);
  });

  it('flushes to nothing when the buffer holds only whitespace', () => {
    const p = new SseParser();
    p.push('data: x\n\n');
    expect(p.flush()).toEqual([]);
  });

  it('survives a byte-at-a-time feed', () => {
    const src = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
    const p = new SseParser();
    const out: string[] = [];
    for (const ch of src) out.push(...p.push(ch));
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('readTextChunks — decoding', () => {
  it('decodes a stream split inside a multi-byte character', async () => {
    // '≈' is E2 89 88 — split between the first and second byte.
    const bytes = new TextEncoder().encode('data: ≈ok\n\n');
    const res = sseResponseBytes([bytes.slice(0, 7), bytes.slice(7)]);
    let text = '';
    for await (const c of readTextChunks(res.body!)) text += c;
    expect(text).toBe('data: ≈ok\n\n');
    expect(text).not.toContain('�');
  });

  it('yields nothing for an empty body', async () => {
    const res = sseResponseBytes([]);
    const out: string[] = [];
    for await (const c of readTextChunks(res.body!)) out.push(c);
    expect(out).toEqual([]);
  });

  it('stops early when the signal is already aborted', async () => {
    const res = sseResponseBytes([new TextEncoder().encode('data: x\n\n')]);
    const ac = new AbortController();
    ac.abort();
    const out: string[] = [];
    for await (const c of readTextChunks(res.body!, ac.signal)) out.push(c);
    expect(out).toEqual([]);
  });
});
