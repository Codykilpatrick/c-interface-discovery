import { describe, it, expect } from 'vitest';
import { ingestFile } from '../fileIngestion';

describe('fileIngestion', () => {
  it('rejects binary files', async () => {
    // Create a file with >10% non-printable bytes
    const binaryData = new Uint8Array(100);
    for (let i = 0; i < 20; i++) binaryData[i] = 0x01; // non-printable
    const file = new File([binaryData], 'test.c', { type: 'text/plain' });
    const result = await ingestFile(file, 'string');
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toMatch(/binary/i);
  });

  it('rejects empty files', async () => {
    const file = new File([], 'empty.c');
    const result = await ingestFile(file, 'string');
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toMatch(/empty/i);
  });

  it('rejects files >2MB', async () => {
    const large = new Uint8Array(2 * 1024 * 1024 + 1).fill(65); // 'A'
    const file = new File([large], 'huge.c');
    const result = await ingestFile(file, 'string');
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toMatch(/2MB/i);
  });

  it('marks files 500KB–2MB as oversized', async () => {
    const data = new Uint8Array(600 * 1024).fill(65);
    const file = new File([data], 'big.c');
    const result = await ingestFile(file, 'string');
    expect(result.rejected).toBe(false);
    expect(result.oversized).toBe(true);
  });

  it('normalizes CRLF to LF', async () => {
    const text = 'line1\r\nline2\r\nline3';
    const file = new File([text], 'test.c');
    const result = await ingestFile(file, 'string');
    expect(result.content).toBe('line1\nline2\nline3');
    expect(result.content).not.toContain('\r');
  });

  it('detects UTF-8 encoding', async () => {
    const file = new File(['int main() {}'], 'test.c');
    const result = await ingestFile(file, 'string');
    expect(result.encoding).toBe('utf-8');
  });

  it('falls back to latin-1 for non-UTF-8 content', async () => {
    // 0x80 0x81 are continuation bytes without a start byte — definitively invalid UTF-8
    const data = new Uint8Array(50).fill(65); // 50 printable 'A' bytes
    data[10] = 0x80; // invalid UTF-8 continuation byte mid-sequence
    data[11] = 0x81;
    const file = new File([data], 'latin.c');
    const result = await ingestFile(file, 'string');
    expect(result.encoding).toBe('latin-1');
    expect(result.rejected).toBe(false);
  });

  it('records correct zone', async () => {
    const file = new File(['int x;'], 'types.h');
    const result = await ingestFile(file, 'external');
    expect(result.zone).toBe('external');
  });
});
