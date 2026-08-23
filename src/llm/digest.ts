/**
 * Analysis digest — the grounded context that goes into the prompt.
 *
 * The raw source never enters the prompt. `StringAnalysis` is an *index*: a
 * million lines of C is ~9M tokens of source but ~120K of index, because the
 * analyzer has already discarded control flow, arithmetic and logging and kept
 * the interface surface.
 *
 * Even so the index is not stuffed in wholesale. Four mechanisms, in order:
 *
 *   1. **Scope** — one application by default, not all of them.
 *   2. **Index in, bodies out** — struct field lists are the bulk of a naive
 *      digest, so each struct gets a one-line stub and the full layout arrives
 *      through a tool call only when a question needs it.
 *   3. **Tools for depth** — a question touches a handful of entities.
 *   4. **Degrade, don't truncate silently** — tiers drop in priority order and
 *      every omission is recorded in `omitted[]`, rendered in the UI *and*
 *      stated in the prompt. A model answering confidently from a context it
 *      does not know was cut is the failure that matters.
 *
 * Output is byte-identical for identical input. That makes it snapshot-testable
 * and lets vLLM's prefix cache hit across every turn of a conversation.
 */

import type { ApplicationGroup, MessageInterface, StringAnalysis } from '../analyzer/types';
import type { MessageComposition } from '../analyzer/messageComposition';
import { summarizeComposition } from '../analyzer/messageComposition';
import type { StructRoleInfo } from '../analyzer/structRoleAnalyzer';
import { crossAppEdges } from './tools';

export type DigestScope =
  | { kind: 'app'; appId: string }
  | { kind: 'all' }
  | { kind: 'message'; appId: string; constant: string };

export interface DigestOptions {
  budgetTokens: number;
  scope: DigestScope;
}

export interface DigestOmission {
  tier: number;
  section: string;
  /** How many entries were withheld. */
  count: number;
  /**
   * Why. `budget` means it did not fit; `relevance` means it was excluded on
   * purpose (orphan structs nothing references). Conflating the two would make
   * the in-prompt notice inaccurate.
   */
  reason: 'budget' | 'relevance';
  /** The tool that can retrieve them. */
  retrievableVia: string;
}

export interface AnalysisDigest {
  text: string;
  estimatedTokens: number;
  omitted: DigestOmission[];
  /** Apps actually represented, for the UI. */
  appNames: string[];
}

/**
 * Pessimistic on purpose. C identifiers are long and tokenize badly, and the
 * cost of over-estimating is a slightly smaller digest, while the cost of
 * under-estimating is an over-length request the server rejects.
 */
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

interface Section {
  tier: number;
  name: string;
  lines: string[];
  /** Entries excluded by relevance, and the tool that retrieves them. */
  overflow?: { count: number; via: string };
  retrievableVia: string;
}

// ── Scope resolution ──────────────────────────────────────────────────────────

interface ScopedApp {
  id: string;
  name: string;
  analysis: StringAnalysis;
}

function resolveScope(apps: ApplicationGroup[], scope: DigestScope): ScopedApp[] {
  const analyzed = apps.flatMap((a) =>
    a.analysis ? [{ id: a.id, name: a.name, analysis: a.analysis }] : [],
  );
  if (scope.kind === 'all') return analyzed;
  return analyzed.filter((a) => a.id === scope.appId);
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function messageRow(m: MessageInterface, comp?: MessageComposition): string {
  const dir = m.directionConfident ? m.direction : `${m.direction}?`;
  const struct = m.structResolved && m.struct ? m.struct.name : 'UNRESOLVED';
  const producers = m.fileRoles.filter((r) => r.role !== 'consumer').map((r) => r.filename);
  const consumers = m.fileRoles.filter((r) => r.role !== 'producer').map((r) => r.filename);
  const size = comp
    ? ` ${comp.sizeByTarget['64bit']}B/64 ${comp.sizeByTarget['32bit']}B/32${comp.differsAcrossTargets ? ' DIFFERS' : ''}`
    : '';
  return (
    `- ${m.msgTypeConstant} = ${m.msgTypeValue} | ${struct} | ${dir} | ${m.transport ?? 'unknown'}` +
    `${size} | def:${m.definedIn}` +
    `${producers.length ? ` | P:${producers.join(',')}` : ''}` +
    `${consumers.length ? ` | C:${consumers.join(',')}` : ''}`
  );
}

function structStub(r: StructRoleInfo, sizeBytes?: number): string {
  const size = sizeBytes !== undefined ? `${sizeBytes}B, ` : '';
  const extra: string[] = [];
  if (r.role === 'envelope') extra.push(`envelope in ${r.inDegree}`);
  else if (r.inDegree > 0) extra.push(`in ${r.containedBy.map((e) => e.parent).join(',')}`);
  if (r.pointerFields.length) extra.push(`ptr:${r.pointerFields.join(',')}`);
  if (r.variableArrayFields.length) extra.push(`var-array:${r.variableArrayFields.join(',')}`);
  return `- ${r.name} (${size}${r.fieldCount} fields, ${r.role}, ${r.sourceFile})` +
    (extra.length ? ` [${extra.join('; ')}]` : '');
}

// ── Section builders ──────────────────────────────────────────────────────────

/** Per-app sections, tier 2 upward. Tier 1 is global. */
function buildSections(scoped: ScopedApp[], scope: DigestScope): Section[] {
  const sections: Section[] = [];
  const single = scoped.length === 1;
  const prefix = (app: ScopedApp) => (single ? '' : `[${app.name}] `);

  // ── Tier 2: message interfaces, with composition and both target sizes ──
  const msgLines: string[] = [];
  for (const app of scoped) {
    const comps = new Map(
      (app.analysis.messageCompositions ?? []).map((c) => [c.msgConstant, c]),
    );
    let interfaces = app.analysis.messageInterfaces;
    if (scope.kind === 'message') {
      interfaces = interfaces.filter((m) => m.msgTypeConstant === scope.constant);
    }
    for (const m of interfaces) {
      const comp = comps.get(m.msgTypeConstant);
      msgLines.push(prefix(app) + messageRow(m, comp).slice(2));
      if (comp) msgLines.push(`    = ${summarizeComposition(comp)}`);
    }
  }
  if (msgLines.length > 0) {
    sections.push({
      tier: 2,
      name: 'MESSAGE INTERFACES',
      lines: [
        '## Message interfaces',
        'constant = value | struct | direction | transport | size64/size32 | defined-in | P:producers C:consumers',
        'The `=` line under each is its composition: named parts are embedded structs, pad(n) is alignment.',
        ...msgLines.map((l) => (l.startsWith('    ') ? l : `- ${l}`)),
      ],
      retrievableVia: 'searchMessages',
    });
  }

  // ── Tier 3: cross-app edges ──
  if (scoped.length > 1) {
    const edgeLines = crossAppEdges(scoped)
      .filter((e) => !e.unmatched)
      .map((e) => `- ${e.producers.join('/')} -> ${e.consumers.join('/')} : ${e.constant}`);
    if (edgeLines.length > 0) {
      sections.push({
        tier: 3, name: 'CROSS-APP FLOWS',
        lines: ['## Cross-application message flows', ...edgeLines],
        retrievableVia: 'getCrossAppEdges',
      });
    }
  }

  // ── Tier 4: struct stubs (bodies via getStructLayout) ──
  const stubLines: string[] = [];
  let stubOverflow = 0;
  for (const app of scoped) {
    const roles = app.analysis.structRoles?.roles ?? [];
    const sizeOf = new Map(
      (app.analysis.structCatalog?.layouts ?? []).map((l) => [l.name, l.totalSizeBytes]),
    );
    // Only structs reachable from a message: everything else is tool-reachable.
    const relevant = roles.filter((r) => r.role !== 'orphan');
    for (const r of relevant) stubLines.push(prefix(app) + structStub(r, sizeOf.get(r.name)).slice(2));
    stubOverflow += roles.length - relevant.length;
  }
  if (stubLines.length > 0) {
    sections.push({
      tier: 4, name: 'STRUCTS',
      lines: [
        '## Structs (stubs — call getStructLayout for field offsets)',
        ...stubLines.map((l) => `- ${l}`),
      ],
      retrievableVia: 'getStructLayout',
      ...(stubOverflow > 0 && { overflow: { count: stubOverflow, via: 'getStructLayout' } }),
    });
  }

  // ── Tier 5: unresolved items — where analyst questions cluster ──
  const unresolvedLines: string[] = [];
  for (const app of scoped) {
    for (const m of app.analysis.messageInterfaces) {
      if (!m.structResolved) unresolvedLines.push(`${prefix(app)}${m.msgTypeConstant}: struct not resolved`);
      else if (m.direction === 'unknown' || !m.directionConfident) {
        unresolvedLines.push(`${prefix(app)}${m.msgTypeConstant}: direction ${m.direction} (not confident)`);
      }
      if (m.incomplete) unresolvedLines.push(`${prefix(app)}${m.msgTypeConstant}: only one side found in loaded files`);
    }
    for (const r of app.analysis.payloadResolutions ?? []) {
      if (r.confidence === 'low' || r.confidence === 'unresolved') {
        unresolvedLines.push(
          `${prefix(app)}${r.sendSiteFile}:${r.sendSiteLine} payload ${r.resolvedStructName ?? '?'} (${r.confidence}, ${r.strategy})`,
        );
      }
    }
    for (const rev of app.analysis.headerGenBundle?.review ?? []) {
      unresolvedLines.push(`${prefix(app)}[${rev.kind}] ${rev.message}`);
    }
    for (const w of app.analysis.warnings) {
      unresolvedLines.push(`${prefix(app)}[${w.kind}] ${w.message}`);
    }
  }
  if (unresolvedLines.length > 0) {
    sections.push({
      tier: 5, name: 'UNRESOLVED',
      lines: ['## Unresolved and uncertain', ...unresolvedLines.map((l) => `- ${l}`)],
      retrievableVia: 'getPayloadResolutions',
    });
  }

  // ── Tier 6: unmatched calls — feeds pattern suggestion ──
  const unknownLines: string[] = [];
  for (const app of scoped) {
    const counts = new Map<string, number>();
    for (const f of app.analysis.files) {
      for (const call of f.unknownCalls) counts.set(call, (counts.get(call) ?? 0) + 1);
    }
    const ranked = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [call, n] of ranked) unknownLines.push(`${prefix(app)}${call} (${n} sites)`);
  }
  if (unknownLines.length > 0) {
    sections.push({
      tier: 6, name: 'UNMATCHED CALLS',
      lines: [
        '## Unmatched calls (candidate messaging wrappers)',
        ...unknownLines.map((l) => `- ${l}`),
      ],
      retrievableVia: 'getUnknownCalls',
    });
  }

  // ── Tier 7: everything else, first to be dropped ──
  const miscLines: string[] = [];
  for (const app of scoped) {
    const risks = app.analysis.files.flatMap((f) =>
      f.risks.map((r) => `${prefix(app)}${f.filename}: [${r.severity}] ${r.msg}`),
    );
    miscLines.push(...risks);
    const ipcTypes = [...new Set(app.analysis.files.flatMap((f) => f.ipc.map((c) => c.type)))].sort();
    if (ipcTypes.length) miscLines.push(`${prefix(app)}IPC mechanisms: ${ipcTypes.join(', ')}`);
  }
  if (miscLines.length > 0) {
    sections.push({
      tier: 7, name: 'RISKS AND IPC',
      lines: ['## Risks and IPC mechanisms', ...miscLines.map((l) => `- ${l}`)],
      retrievableVia: 'getSourceLines',
    });
  }

  return sections;
}

// ── Assembly ──────────────────────────────────────────────────────────────────

export function buildDigest(apps: ApplicationGroup[], opts: DigestOptions): AnalysisDigest {
  const scoped = resolveScope(apps, opts.scope);
  const omitted: DigestOmission[] = [];

  // Tier 1 is never dropped: without it the model does not know what it is
  // looking at, and cannot even choose a tool argument.
  const header: string[] = ['# C interface analysis'];
  if (scoped.length === 0) {
    header.push('', 'No analyzed applications in scope.');
    const text = header.join('\n');
    return { text, estimatedTokens: estimateTokens(text), omitted, appNames: [] };
  }

  header.push('', '## Applications');
  // The one-line-per-app inventory is never dropped — without it the model does
  // not know what it is looking at. The produce/consume detail is, when the
  // budget is too small to hold even that.
  const inventory: string[] = [];
  const detail: string[] = [];
  for (const app of scoped) {
    const produced = new Set<string>();
    const consumed = new Set<string>();
    for (const m of app.analysis.messageInterfaces) {
      for (const r of m.fileRoles) {
        if (r.role !== 'consumer') produced.add(m.msgTypeConstant);
        if (r.role !== 'producer') consumed.add(m.msgTypeConstant);
      }
    }
    inventory.push(
      `- ${app.name}: ${app.analysis.files.length} source files, ` +
      `${app.analysis.messageInterfaces.length} message interfaces, ` +
      `${app.analysis.typeDict.structs.length} structs` +
      ` | layout target ${app.analysis.layoutTarget ?? '64bit'}`,
    );
    if (produced.size) detail.push(`    produces: ${[...produced].sort().join(', ')}`);
    if (consumed.size) detail.push(`    consumes: ${[...consumed].sort().join(', ')}`);
  }
  header.push(...inventory);
  const withDetail = estimateTokens([...header, ...detail].join('\n'));
  if (detail.length > 0 && withDetail <= opts.budgetTokens) {
    header.push(...detail);
  } else if (detail.length > 0) {
    omitted.push({
      tier: 1, section: 'APPLICATION PRODUCE/CONSUME LISTS',
      count: detail.length, reason: 'budget', retrievableVia: 'getCrossAppEdges',
    });
  }
  if (opts.scope.kind === 'message') {
    header.push('', `Scoped to message ${opts.scope.constant}.`);
  }

  const headerText = header.join('\n') + '\n';
  let used = estimateTokens(headerText);
  const parts: string[] = [headerText];

  // Reserve room for the partial-context notice up front. Appending it
  // afterwards would push the digest past the budget precisely when the budget
  // is tightest — the case the notice exists for.
  const notionalReserve = Math.min(Math.max(80, Math.floor(opts.budgetTokens * 0.1)), 400);
  const fillBudget = Math.max(0, opts.budgetTokens - notionalReserve);

  // Fill the remaining budget in tier order.
  for (const section of buildSections(scoped, opts.scope)) {
    const body = `${section.lines.join('\n')}\n`;
    const cost = estimateTokens(body);
    const entryCount = section.lines.length - 1;

    if (used + cost <= fillBudget) {
      parts.push(body);
      used += cost;
      if (section.overflow) {
        omitted.push({
          tier: section.tier, section: section.name,
          count: section.overflow.count, reason: 'relevance',
          retrievableVia: section.overflow.via,
        });
      }
      continue;
    }

    // Partial fit: keep as many entries as the remaining budget allows rather
    // than dropping the whole section.
    const kept: string[] = [];
    let cursor = used + estimateTokens(`${section.lines[0]}\n`);
    for (const line of section.lines.slice(1)) {
      const lineCost = estimateTokens(`${line}\n`);
      if (cursor + lineCost > fillBudget) break;
      kept.push(line);
      cursor += lineCost;
    }
    if (kept.length > 0) {
      const partial = `${[section.lines[0], ...kept].join('\n')}\n`;
      parts.push(partial);
      used = cursor;
    }
    omitted.push({
      tier: section.tier, section: section.name,
      count: entryCount - kept.length, reason: 'budget',
      retrievableVia: section.retrievableVia,
    });
    if (section.overflow) {
      omitted.push({
        tier: section.tier, section: section.name,
        count: section.overflow.count, reason: 'relevance',
        retrievableVia: section.overflow.via,
      });
    }
  }

  // State the omissions in the prompt itself. The model must know the context
  // is partial, and which tool reaches the rest.
  if (omitted.length > 0) {
    const noticeLines = [
      '',
      '## Context is partial',
      'These entries are not shown above. Use the named tool to retrieve any you need;',
      'do not assume something is absent because it is missing here.',
      ...omitted.map((o) =>
        `- ${o.section}: ${o.count} entries ` +
        `${o.reason === 'budget' ? 'withheld to fit the context budget' : 'excluded as unreferenced'}` +
        ` — retrieve via ${o.retrievableVia}`),
      '',
    ];
    // Trim rather than overrun: a notice that blows the budget defeats itself.
    while (noticeLines.length > 5 && estimateTokens(noticeLines.join('\n')) > notionalReserve) {
      noticeLines.splice(noticeLines.length - 2, 1);
    }
    const notice = noticeLines.join('\n');
    parts.push(notice);
    used += estimateTokens(notice);
  }

  const text = parts.join('\n');

  return {
    text,
    estimatedTokens: estimateTokens(text),
    omitted,
    appNames: scoped.map((a) => a.name),
  };
}
