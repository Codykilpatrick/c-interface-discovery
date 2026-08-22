import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, describeCall, executeTool, type ToolContext } from '../tools';
import { makeApps } from './fixtures/analysisFixture';

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { apps: makeApps(), defaultAppId: 'cic', includeSourceSnippets: true, ...over };
}

function run(name: string, args: Record<string, unknown> = {}, c: ToolContext = ctx()) {
  return executeTool(name, JSON.stringify(args), c);
}

const asObj = (v: unknown) => v as Record<string, any>;

// ── Contract ──────────────────────────────────────────────────────────────────

describe('tool definitions', () => {
  it('every advertised tool has an executor', () => {
    for (const t of TOOL_DEFINITIONS) {
      const r = executeTool(t.function.name, '{}', ctx());
      expect(String(asObj(r.result).error ?? ''), `${t.function.name} should exist`)
        .not.toContain('Unknown tool');
    }
  });

  it('every tool has a description and an object schema', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.function.description.length).toBeGreaterThan(20);
      expect(t.function.parameters.type).toBe('object');
    }
  });
});

// ── Dispatch robustness ───────────────────────────────────────────────────────

describe('executeTool — malformed input', () => {
  it('returns a recoverable error for an unknown tool, listing the real ones', () => {
    const r = executeTool('getMagicAnswer', '{}', ctx());
    expect(r.failed).toBe(true);
    expect(asObj(r.result).error).toContain('Unknown tool');
    expect(asObj(r.result).hint).toContain('getStructLayout');
  });

  it('returns an error rather than throwing on unparseable arguments', () => {
    // vllm#44522 leaks raw delimiter tokens into arguments; the loop must survive it.
    const r = executeTool('getStructLayout', '<|"|>ContactMsg<|"|>', ctx());
    expect(r.failed).toBe(true);
    expect(asObj(r.result).error).toContain('not valid JSON');
    expect(asObj(r.result).hint).toContain('Re-issue');
  });

  it('treats empty arguments as an empty object', () => {
    const r = executeTool('getStructRoles', '', ctx());
    expect(r.failed).toBe(false);
  });

  it('reports a missing required argument instead of guessing', () => {
    expect(asObj(run('getStructLayout').result).error).toContain('name is required');
    expect(asObj(run('findUsages').result).error).toContain('symbol is required');
  });

  it('errors cleanly when no application has been analyzed', () => {
    const r = run('getStructRoles', {}, ctx({ apps: [] }));
    expect(r.failed).toBe(true);
    expect(asObj(r.result).error).toContain('No analyzed applications');
  });
});

// ── App resolution ────────────────────────────────────────────────────────────

describe('app resolution', () => {
  it('defaults to the scoped application', () => {
    expect(asObj(run('getStructRoles').result).app).toBe('CIC');
  });

  it('accepts an app name, case-insensitively', () => {
    expect(asObj(run('getStructRoles', { app: 'sonar' }).result).app).toBe('Sonar');
  });

  it('lists the real names when an unknown app is asked for', () => {
    const r = run('getStructRoles', { app: 'Radar' });
    expect(asObj(r.result).error).toContain('Available: CIC, Sonar');
  });
});

// ── Layout — the tool that must never be guessed ──────────────────────────────

describe('getStructLayout', () => {
  it('returns real offsets, sizes and both target figures', () => {
    const r = asObj(run('getStructLayout', { name: 'ContactMsg' }).result);
    expect(r.totalSizeBytes).toBe(136);
    expect(r.alignBytes).toBe(8);
    expect(r.fields.find((f: any) => f.name === 'body').offsetBytes).toBe(16);
  });

  it('returns located padding gaps with the type that forced them', () => {
    const r = asObj(run('getStructLayout', { name: 'ContactMsg' }).result);
    expect(r.paddingGaps).toEqual([{
      afterField: 'hdr', beforeField: 'body', offsetBytes: 12, sizeBytes: 4,
      reason: 'align-member', causedByAlign: 8, causedByType: 'FusedContact',
      atCompositionBoundary: true,
    }]);
  });

  it('carries the struct role through, so the model need not re-derive it', () => {
    expect(asObj(run('getStructLayout', { name: 'CicHeader' }).result).role).toBe('envelope');
  });

  it('suggests near-misses on a wrong name instead of just failing', () => {
    const r = asObj(run('getStructLayout', { name: 'Contact' }).result);
    expect(r.error).toContain('No struct named Contact');
    expect(r.hint).toContain('ContactMsg');
  });
});

// ── Message interface ─────────────────────────────────────────────────────────

describe('getMessageInterface', () => {
  it('returns composition and both target sizes without a second call', () => {
    const r = asObj(run('getMessageInterface', { constant: 'MSG_TYPE_CONTACT' }).result);
    expect(r.struct).toBe('ContactMsg');
    expect(r.composition).toContain('CicHeader + pad(4) + FusedContact');
    expect(r.sizeByTarget).toEqual({ '32bit': 108, '64bit': 136 });
    expect(r.differsAcrossTargets).toBe(true);
  });

  it('reports an unresolved struct honestly rather than inventing one', () => {
    const r = asObj(run('getMessageInterface', { constant: 'MSG_TYPE_MYSTERY' }).result);
    expect(r.structResolved).toBe(false);
    expect(r.struct).toBeNull();
  });

  it('suggests near-misses for an unknown constant', () => {
    const r = asObj(run('getMessageInterface', { constant: 'MSG_TYPE_CONTAC' }).result);
    expect(r.hint).toContain('MSG_TYPE_CONTACT');
  });
});

// ── Struct graph ──────────────────────────────────────────────────────────────

describe('getStructGraph', () => {
  it('walks the containment tree to the requested depth', () => {
    const r = asObj(run('getStructGraph', { name: 'ContactMsg', depth: 3 }).result);
    const body = r.tree.contains.find((c: any) => c.name === 'FusedContact');
    expect(body.contains.find((c: any) => c.name === 'TrackKinematics')).toBeTruthy();
  });

  it('marks truncation rather than silently stopping', () => {
    const r = asObj(run('getStructGraph', { name: 'ContactMsg', depth: 1 }).result);
    const body = r.tree.contains.find((c: any) => c.name === 'FusedContact');
    expect(body.containsTruncated).toContain('TrackKinematics');
  });

  it('caps depth so a deep tree cannot flood the context', () => {
    const r = asObj(run('getStructGraph', { name: 'ContactMsg', depth: 999 }).result);
    expect(JSON.stringify(r).length).toBeLessThan(20_000);
  });
});

// ── Roles ─────────────────────────────────────────────────────────────────────

describe('getStructRoles', () => {
  it('reports wire roots and envelopes', () => {
    const r = asObj(run('getStructRoles').result);
    expect(r.wireRoots).toContain('ContactMsg');
    expect(r.envelopes).toEqual(['CicHeader']);
  });

  it('filters by role, for finding undetected messaging wrappers', () => {
    const r = asObj(run('getStructRoles', { role: 'root-candidate' }).result);
    expect(r.structs.every((s: any) => s.role === 'root-candidate')).toBe(true);
  });
});

// ── Usages and source ─────────────────────────────────────────────────────────

describe('findUsages', () => {
  it('returns file and line for each match', () => {
    const r = asObj(run('findUsages', { symbol: 'link11_write' }).result);
    expect(r.totalMatches).toBe(3);
    expect(r.files[0].lines[0]).toHaveProperty('line');
  });

  it('reports zero matches plainly', () => {
    const r = asObj(run('findUsages', { symbol: 'nonexistent_symbol' }).result);
    expect(r.totalMatches).toBe(0);
  });
});

describe('getSourceLines', () => {
  it('returns the requested inclusive range', () => {
    const r = asObj(run('getSourceLines', { file: 'cic/track_router.c', from: 2, to: 4 }).result);
    expect(r.lines.map((l: any) => l.line)).toEqual([2, 3, 4]);
    expect(r.lines[1].text).toContain('link11_write');
  });

  it('matches a file by basename', () => {
    const r = asObj(run('getSourceLines', { file: 'track_router.c', from: 1, to: 1 }).result);
    expect(r.file).toBe('cic/track_router.c');
  });

  it('caps a huge range and says it did', () => {
    const r = asObj(run('getSourceLines', { file: 'cic/track_router.c', from: 1, to: 9999 }).result);
    expect(r.lines.length).toBeLessThanOrEqual(120);
    expect(r.to).toBeLessThanOrEqual(r.totalLines);
  });

  it('refuses when snippets are disabled, and says what to do instead', () => {
    const r = run('getSourceLines',
      { file: 'cic/track_router.c', from: 1, to: 2 },
      ctx({ includeSourceSnippets: false }));
    expect(r.failed).toBe(true);
    expect(asObj(r.result).error).toContain('disabled');
    expect(asObj(r.result).hint).toContain('analysis metadata');
  });

  it('applies the redaction hook to returned source', () => {
    const r = asObj(run('getSourceLines',
      { file: 'cic/track_router.c', from: 3, to: 3 },
      ctx({ redact: (s) => s.replace(/link11_write/g, 'XXX') }),
    ).result);
    expect(r.lines[0].text).toContain('XXX');
    expect(r.lines[0].text).not.toContain('link11_write');
  });

  it('lists loaded files when the name does not match', () => {
    const r = asObj(run('getSourceLines', { file: 'nope.c', from: 1, to: 2 }).result);
    expect(r.error).toContain('No file matching');
    expect(r.hint).toContain('cic/track_router.c');
  });
});

// ── Pattern-suggestion inputs ─────────────────────────────────────────────────

describe('getUnknownCalls', () => {
  it('ranks by frequency and attaches real call sites', () => {
    const r = asObj(run('getUnknownCalls').result);
    expect(r.calls[0].name).toBe('link11_write');
    expect(r.calls[0].sites).toBe(3);
    expect(r.calls[0].samples[0]).toMatch(/track_router\.c:\d+:/);
  });
});

// ── Cross-app ─────────────────────────────────────────────────────────────────

describe('getCrossAppEdges', () => {
  it('pairs producers with consumers across applications', () => {
    const r = asObj(run('getCrossAppEdges').result);
    const contact = r.edges.find((e: any) => e.constant === 'MSG_TYPE_CONTACT');
    expect(contact.producers).toEqual(['Sonar']);
    expect(contact.consumers).toEqual(['CIC']);
    expect(contact.unmatched).toBe(false);
  });

  it('flags a message with only one side present', () => {
    const r = asObj(run('getCrossAppEdges').result);
    const frame = r.edges.find((e: any) => e.constant === 'MSG_TYPE_SONAR_FRAME');
    expect(frame.unmatched).toBe(true);
  });

  it('filters to one constant', () => {
    const r = asObj(run('getCrossAppEdges', { constant: 'MSG_TYPE_CONTACT' }).result);
    expect(r.edges).toHaveLength(1);
  });
});

// ── Search ────────────────────────────────────────────────────────────────────

describe('searchMessages', () => {
  it('matches constants and structs by substring', () => {
    const r = asObj(run('searchMessages', { pattern: 'contact' }).result);
    expect(r.messages.map((m: any) => m.constant)).toContain('MSG_TYPE_CONTACT');
    expect(r.structs.map((s: any) => s.name)).toContain('ContactMsg');
  });

  it('accepts a regex', () => {
    const r = asObj(run('searchMessages', { pattern: '^MSG_TYPE_(CONTACT|TRACK)$' }).result);
    expect(r.messages).toHaveLength(2);
  });

  it('falls back to a literal match on an invalid regex rather than failing', () => {
    const r = run('searchMessages', { pattern: 'Contact(' });
    expect(r.failed).toBe(false);
  });
});

// ── Trace labels ──────────────────────────────────────────────────────────────

describe('describeCall', () => {
  it('names the primary argument for the UI trace', () => {
    expect(describeCall('getStructLayout', { name: 'ContactMsg' })).toBe('getStructLayout(ContactMsg)');
    expect(describeCall('getStructRoles', {})).toBe('getStructRoles()');
  });
});
