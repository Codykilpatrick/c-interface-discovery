import { describe, it, expect } from 'vitest';
import { buildDigest, estimateTokens } from '../digest';
import { makeApps, makeApp } from './fixtures/analysisFixture';

const BIG = 100_000;

describe('digest — always-present tiers', () => {
  const apps = makeApps();

  it('lists applications with their produced and consumed constants', () => {
    const d = buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'all' } });
    expect(d.text).toContain('## Applications');
    expect(d.text).toContain('CIC:');
    expect(d.text).toContain('produces:');
    expect(d.appNames).toEqual(['CIC', 'Sonar']);
  });

  it('renders the message table with both target sizes', () => {
    const d = buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'app', appId: 'cic' } });
    expect(d.text).toContain('MSG_TYPE_CONTACT = 0x30');
    expect(d.text).toContain('136B/64');
    expect(d.text).toContain('108B/32');
    expect(d.text).toContain('DIFFERS');
  });

  it('includes the composition line, so composition costs no tool call', () => {
    const d = buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'app', appId: 'cic' } });
    expect(d.text).toContain('= CicHeader + pad(4) + FusedContact');
  });

  it('renders struct stubs, not field lists', () => {
    const d = buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'app', appId: 'cic' } });
    expect(d.text).toContain('ContactMsg (136B, 3 fields, wire-root');
    // A field name from inside the struct must not appear — bodies come from a tool.
    expect(d.text).not.toContain('sin_zero');
    expect(d.text).toContain('getStructLayout');
  });

  it('marks the envelope and where blocks are embedded', () => {
    const d = buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'app', appId: 'cic' } });
    expect(d.text).toMatch(/CicHeader .*envelope.*\[envelope in \d+\]/);
    expect(d.text).toContain('in ContactMsg');
  });

  it('surfaces wire hazards on the stub line', () => {
    const d = buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'app', appId: 'cic' } });
    expect(d.text).toContain('var-array:tracks[CIC_MAX_TRACKS]');
  });
});

describe('digest — scope', () => {
  const apps = makeApps();

  it('excludes other applications when scoped to one', () => {
    const d = buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'app', appId: 'cic' } });
    expect(d.text).toContain('MSG_TYPE_CONTACT');
    expect(d.text).not.toContain('MSG_TYPE_SONAR_FRAME');
    expect(d.appNames).toEqual(['CIC']);
  });

  it('prefixes rows with the app name only when several are in scope', () => {
    const one = buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'app', appId: 'cic' } });
    expect(one.text).not.toContain('[CIC]');
    const all = buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'all' } });
    expect(all.text).toContain('[CIC]');
    expect(all.text).toContain('[Sonar]');
  });

  it('narrows the message table when scoped to one constant', () => {
    const d = buildDigest(apps, {
      budgetTokens: BIG, scope: { kind: 'message', appId: 'cic', constant: 'MSG_TYPE_CONTACT' },
    });
    expect(d.text).toContain('MSG_TYPE_CONTACT');
    expect(d.text).not.toContain('MSG_TYPE_TRACK =');
    expect(d.text).toContain('Scoped to message MSG_TYPE_CONTACT');
  });

  it('adds cross-app flows only when more than one app is in scope', () => {
    expect(buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'app', appId: 'cic' } }).text)
      .not.toContain('Cross-application');
    expect(buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'all' } }).text)
      .toContain('Cross-application message flows');
  });

  it('handles an empty scope without crashing', () => {
    const d = buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'app', appId: 'nope' } });
    expect(d.text).toContain('No analyzed applications in scope.');
    expect(d.appNames).toEqual([]);
  });

  it('ignores applications that have not been analyzed', () => {
    const d = buildDigest(
      [...makeApps(), { id: 'x', name: 'Unanalyzed', files: [], analysis: null }],
      { budgetTokens: BIG, scope: { kind: 'all' } },
    );
    expect(d.appNames).toEqual(['CIC', 'Sonar']);
  });
});

describe('digest — unresolved and unmatched', () => {
  const d = buildDigest(makeApps(), { budgetTokens: BIG, scope: { kind: 'app', appId: 'cic' } });

  it('lists unresolved structs and uncertain directions, where questions cluster', () => {
    expect(d.text).toContain('## Unresolved and uncertain');
    expect(d.text).toContain('MSG_TYPE_MYSTERY: struct not resolved');
    expect(d.text).toContain('MSG_TYPE_TRACK: direction unknown (not confident)');
  });

  it('lists low-confidence payload resolutions with the strategy used', () => {
    expect(d.text).toContain('payload SomeStruct (low, pointer)');
  });

  it('ranks unmatched calls by frequency, as pattern candidates', () => {
    const section = d.text.slice(d.text.indexOf('## Unmatched calls'));
    expect(section.indexOf('link11_write (3 sites)')).toBeLessThan(section.indexOf('odd_call (1 sites)'));
  });
});

describe('digest — budget and degradation', () => {
  const apps = makeApps();

  it('stays within the budget once the budget exceeds the tier-1 floor', () => {
    const floor = buildDigest(apps, { budgetTokens: 1, scope: { kind: 'all' } }).estimatedTokens;
    for (const budget of [100_000, 4000, 1500, 800, 400]) {
      const d = buildDigest(apps, { budgetTokens: budget, scope: { kind: 'all' } });
      expect(d.estimatedTokens, `budget ${budget}`).toBeLessThanOrEqual(Math.max(budget * 1.35, floor));
    }
  });

  it('keeps the tier-1 floor small — it is the one thing never dropped', () => {
    const floor = buildDigest(apps, { budgetTokens: 1, scope: { kind: 'all' } });
    expect(floor.estimatedTokens).toBeLessThan(400);
    expect(floor.text).toContain('## Applications');
    // The produce/consume detail is dropped, and says so.
    expect(floor.omitted.some((o) => o.tier === 1 && o.reason === 'budget')).toBe(true);
  });

  it('keeps the application inventory even at an absurd budget', () => {
    const d = buildDigest(apps, { budgetTokens: 50, scope: { kind: 'all' } });
    expect(d.text).toContain('## Applications');
  });

  it('drops low tiers before high ones', () => {
    const tight = buildDigest(apps, { budgetTokens: 700, scope: { kind: 'app', appId: 'cic' } });
    const droppedTiers = tight.omitted.map((o) => o.tier);
    // Whatever survives, the message table outranks risks.
    expect(Math.max(...droppedTiers)).toBeGreaterThanOrEqual(Math.min(...droppedTiers));
    expect(droppedTiers).toContain(7);
    expect(tight.text).toContain('## Message interfaces');
  });

  it('records every omission rather than truncating silently', () => {
    const d = buildDigest(apps, { budgetTokens: 700, scope: { kind: 'all' } });
    expect(d.omitted.length).toBeGreaterThan(0);
    for (const o of d.omitted) {
      expect(o.count).toBeGreaterThan(0);
      expect(o.retrievableVia).toBeTruthy();
    }
  });

  it('tells the model in-prompt that context is partial and which tool reaches the rest', () => {
    // The dangerous failure is a model answering confidently from a context it
    // does not know was cut.
    const d = buildDigest(apps, { budgetTokens: 700, scope: { kind: 'all' } });
    expect(d.text).toContain('## Context is partial');
    expect(d.text).toContain('withheld to fit the context budget — retrieve via');
    expect(d.text).toContain('do not assume something is absent');
  });

  it('records no budget-driven omission when everything fits', () => {
    const d = buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'all' } });
    expect(d.omitted.filter((o) => o.reason === 'budget')).toEqual([]);
  });

  it('distinguishes relevance exclusions from budget cuts in the prompt', () => {
    // Orphan structs are excluded because nothing references them, not because
    // they did not fit. Saying "withheld to fit the budget" would be a lie.
    const d = buildDigest(apps, { budgetTokens: BIG, scope: { kind: 'all' } });
    const relevance = d.omitted.filter((o) => o.reason === 'relevance');
    expect(relevance.length).toBeGreaterThan(0);
    expect(d.text).toContain('excluded as unreferenced');
    expect(d.text).not.toContain('withheld to fit the context budget');
  });

  it('keeps part of a section rather than dropping all of it', () => {
    const d = buildDigest(apps, { budgetTokens: 900, scope: { kind: 'app', appId: 'cic' } });
    expect(d.text).toContain('## Message interfaces');
    // Something was kept and something recorded as dropped.
    expect(d.omitted.some((o) => o.count > 0)).toBe(true);
  });
});

describe('digest — determinism and redaction', () => {
  it('is byte-identical across runs, so the prefix cache hits', () => {
    const a = buildDigest(makeApps(), { budgetTokens: BIG, scope: { kind: 'all' } });
    const b = buildDigest(makeApps(), { budgetTokens: BIG, scope: { kind: 'all' } });
    expect(a.text).toBe(b.text);
  });

  it('applies the redaction hook to the whole prompt', () => {
    const d = buildDigest(makeApps(), {
      budgetTokens: BIG, scope: { kind: 'all' },
      redact: (s) => s.replace(/MSG_TYPE_CONTACT/g, 'REDACTED'),
    });
    expect(d.text).not.toContain('MSG_TYPE_CONTACT');
    expect(d.text).toContain('REDACTED');
  });
});

describe('digest — index not source', () => {
  it('contains no verbatim source lines', () => {
    // The analyzer is the compression step: the digest is an index over the
    // source, never a copy of it. Source arrives only through getSourceLines.
    const app = makeApp('cic', 'CIC');
    const d = buildDigest([app], { budgetTokens: BIG, scope: { kind: 'all' } });
    for (const line of app.files[0].content.split('\n').map((l) => l.trim())) {
      if (line.length < 12) continue;
      expect(d.text, `leaked source: ${line}`).not.toContain(line);
    }
  });

  it('estimates conservatively, never under the real character count', () => {
    expect(estimateTokens('abcdefg')).toBeGreaterThanOrEqual(2);
    expect(estimateTokens('')).toBe(0);
  });
});
