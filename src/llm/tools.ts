/**
 * Tool surface over the analysis.
 *
 * The model decides *what* to look up; the lookup itself is deterministic
 * TypeScript over the in-memory `StringAnalysis`. Nothing here asks the model
 * for a fact — byte offsets, message directions and payload types come from
 * `structLayoutEngine`, `messagingExtractor` and `payloadResolver`, and the
 * model reads them. If the model is doing alignment arithmetic in prose, that is
 * a bug in the prompt, not a feature.
 *
 * Every executor returns a plain object that is JSON-serialized into a
 * `role: 'tool'` message. Errors are returned as `{ error }` rather than thrown:
 * a model that asked for a struct that does not exist should be told so and get
 * a chance to try another, not have the conversation aborted.
 */

import type { ApplicationGroup, LoadedFile, StringAnalysis } from '../analyzer/types';
import { summarizeComposition } from '../analyzer/messageComposition';
import { findReferences } from '../utils/findReferences';
import { escapeRegExp } from '../utils/escapeRegExp';
import { regexTooDangerous } from '../utils/regexSafety';
import type { ToolDefinition } from './types';

export interface ToolContext {
  apps: ApplicationGroup[];
  /** App the panel is scoped to; tools default to it when no app is named. */
  defaultAppId: string | null;
  /** Gates `getSourceLines`. */
  includeSourceSnippets: boolean;
}

export interface ToolExecution {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  /** True when the result carries an `error` key. */
  failed: boolean;
}

/** Caps so one call cannot blow the context window. */
const MAX_USAGE_FILES = 8;
const MAX_USAGE_LINES = 12;
const MAX_SOURCE_LINES = 120;
const MAX_SEARCH_RESULTS = 40;
const MAX_GRAPH_DEPTH = 8;

// ── Tool definitions sent to the model ────────────────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'getMessageInterface',
      description:
        'Full detail for one message constant: resolved struct, direction, transport, ' +
        'per-file producer/consumer roles, composition and both target sizes.',
      parameters: {
        type: 'object',
        properties: {
          constant: { type: 'string', description: 'e.g. MSG_TYPE_CONTACT' },
          app: { type: 'string', description: 'Application name. Defaults to the scoped app.' },
        },
        required: ['constant'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getStructLayout',
      description:
        'Byte-level layout of one struct: every field with its offset and size, located padding ' +
        'gaps with the alignment that forced them, total size and alignment for both 32-bit and ' +
        '64-bit targets. Use this for any question about offsets, sizes or padding.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Struct name, e.g. ContactMsg' },
          app: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getStructGraph',
      description:
        'Containment tree below a struct — which blocks it embeds, recursively, with roles. ' +
        'Use for "what is X made of" and for tracing why an alignment requirement exists.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          depth: { type: 'integer', description: 'Default 4, max 8.' },
          app: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getStructRoles',
      description:
        'Classification of every struct: wire root, envelope, shared block, root candidate, ' +
        'orphan. Use for "what are my top-level structures" and to find messaging wrappers the ' +
        'pattern registry has not learned yet (root candidates).',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Optional filter, e.g. root-candidate' },
          app: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'findUsages',
      description: 'Every source line referencing a symbol, with file and line number.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string' }, app: { type: 'string' } },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getPayloadResolutions',
      description:
        'How the analyzer resolved the payload struct at each send site, with confidence and ' +
        'the strategy used. Use to explain why something is unresolved or low confidence.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          constant: { type: 'string' },
          app: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getSourceLines',
      description: 'Verbatim source lines from one file, inclusive 1-based range.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          from: { type: 'integer' },
          to: { type: 'integer' },
          app: { type: 'string' },
        },
        required: ['file', 'from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getUnknownCalls',
      description:
        'Function calls the analyzer could not classify, frequency-ranked with sample call ' +
        'sites. These are the candidates for a new custom messaging pattern.',
      parameters: { type: 'object', properties: { app: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getCrossAppEdges',
      description: 'Message flows between applications, optionally filtered to one constant.',
      parameters: {
        type: 'object',
        properties: { constant: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchMessages',
      description:
        'Search message constants and struct names by substring or regex. Use when the digest ' +
        'says entries were withheld, or to find a constant whose exact name is unknown.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          app: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function err(message: string, hint?: string) {
  return hint ? { error: message, hint } : { error: message };
}

function resolveApp(ctx: ToolContext, named?: unknown): { name: string; analysis: StringAnalysis; files: LoadedFile[] } | { error: string } {
  const analyzed = ctx.apps.filter((a) => a.analysis !== null);
  if (analyzed.length === 0) return { error: 'No analyzed applications are loaded.' };

  if (typeof named === 'string' && named.trim() !== '') {
    const want = named.trim().toLowerCase();
    const hit = analyzed.find((a) => a.name.toLowerCase() === want)
      ?? analyzed.find((a) => a.name.toLowerCase().includes(want));
    if (!hit) {
      return { error: `No application named "${named}". Available: ${analyzed.map((a) => a.name).join(', ')}` };
    }
    return { name: hit.name, analysis: hit.analysis!, files: hit.files };
  }

  const scoped = analyzed.find((a) => a.id === ctx.defaultAppId) ?? analyzed[0];
  return { name: scoped.name, analysis: scoped.analysis!, files: scoped.files };
}

/** `.c`/`.cpp` files that parsed — the only ones worth grepping. */
export function sourceFilesOf(files: LoadedFile[]): LoadedFile[] {
  return files.filter((f) => /\.(c|cpp)$/i.test(f.filename) && !f.rejected);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function int(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Suggest near-misses so the model can retry instead of guessing again. */
function nearest(name: string, candidates: string[]): string[] {
  const lower = name.toLowerCase();
  return candidates
    .filter((c) => c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase()))
    .slice(0, 8);
}

export interface CrossAppEdge {
  constant: string;
  producers: string[];
  consumers: string[];
  /** Apps on both sides of the same constant — a transit/broker hop. */
  transitApps?: string[];
  /** One side has no app, so nothing actually flows. */
  unmatched: boolean;
}

/**
 * Message flow between applications. Shared with the context digest so the two
 * cannot report different graphs for the same analysis.
 */
export function crossAppEdges(
  apps: { name: string; analysis: StringAnalysis }[],
  constant?: string,
): CrossAppEdge[] {
  const producersOf = new Map<string, Set<string>>();
  const consumersOf = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, key: string, app: string) => {
    const set = m.get(key) ?? new Set<string>();
    set.add(app);
    m.set(key, set);
  };
  for (const a of apps) {
    for (const m of a.analysis.messageInterfaces) {
      if (constant && m.msgTypeConstant !== constant) continue;
      if (m.fileRoles.some((r) => r.role !== 'consumer')) add(producersOf, m.msgTypeConstant, a.name);
      if (m.fileRoles.some((r) => r.role !== 'producer')) add(consumersOf, m.msgTypeConstant, a.name);
    }
  }
  return [...new Set([...producersOf.keys(), ...consumersOf.keys()])].sort().map((c) => {
    const producers = [...(producersOf.get(c) ?? [])].sort();
    const consumers = [...(consumersOf.get(c) ?? [])].sort();
    const transit = producers.filter((x) => consumers.includes(x));
    return {
      constant: c, producers, consumers,
      ...(transit.length && { transitApps: transit }),
      unmatched: producers.length === 0 || consumers.length === 0,
    };
  });
}

// ── Executors ─────────────────────────────────────────────────────────────────

type Executor = (args: Record<string, unknown>, ctx: ToolContext) => unknown;

const EXECUTORS: Record<string, Executor> = {
  getMessageInterface(args, ctx) {
    const app = resolveApp(ctx, args.app);
    if ('error' in app) return app;
    const constant = str(args.constant);
    if (!constant) return err('constant is required');

    const m = app.analysis.messageInterfaces.find((x) => x.msgTypeConstant === constant);
    if (!m) {
      const all = app.analysis.messageInterfaces.map((x) => x.msgTypeConstant);
      const near = nearest(constant, all);
      return err(`No message interface named ${constant} in ${app.name}.`,
        near.length ? `Did you mean: ${near.join(', ')}` : `Known: ${all.slice(0, 20).join(', ')}`);
    }
    const comp = app.analysis.messageCompositions?.find((c) => c.msgConstant === constant);
    return {
      app: app.name,
      constant: m.msgTypeConstant,
      value: m.msgTypeValue,
      struct: m.struct?.name ?? null,
      structResolved: m.structResolved,
      direction: m.direction,
      directionConfident: m.directionConfident,
      transport: m.transport,
      definedIn: m.definedIn,
      incomplete: m.incomplete ?? false,
      fileRoles: m.fileRoles,
      ...(comp && {
        composition: summarizeComposition(comp),
        sizeByTarget: comp.sizeByTarget,
        differsAcrossTargets: comp.differsAcrossTargets,
        isEstimated: comp.isEstimated,
        pointerWarnings: comp.pointerWarnings,
        variableArrayWarnings: comp.variableArrayWarnings,
      }),
    };
  },

  getStructLayout(args, ctx) {
    const app = resolveApp(ctx, args.app);
    if ('error' in app) return app;
    const name = str(args.name);
    if (!name) return err('name is required');

    const catalog = app.analysis.structCatalog;
    const here = catalog?.layouts.find((l) => l.name === name);
    if (!here) {
      const near = nearest(name, (catalog?.layouts ?? []).map((l) => l.name));
      return err(`No struct named ${name} in ${app.name}.`,
        near.length ? `Did you mean: ${near.join(', ')}` : undefined);
    }
    const target = app.analysis.layoutTarget ?? '64bit';
    const role = app.analysis.structRoles?.byName.get(name);
    return {
      app: app.name,
      name: here.name,
      sourceFile: here.sourceFile,
      layoutTarget: target,
      totalSizeBytes: here.totalSizeBytes,
      alignBytes: here.alignBytes,
      paddingBytes: here.paddingBytes,
      isEstimated: here.isEstimated,
      ...(here.packAttribute !== undefined && {
        packAttribute: here.packAttribute, packSource: here.packSource,
      }),
      ...(role && { role: role.role, inDegree: role.inDegree }),
      fields: here.fields.map((f) => ({
        name: f.name, type: f.type,
        offsetBytes: f.offsetBytes, sizeBytes: f.sizeBytes, alignBytes: f.alignBytes,
        ...(f.isStructMember && { isStruct: true, structType: f.structTypeName }),
        ...(f.isPointer && { isPointer: true }),
        ...(f.isArray && { isArray: true, arrayLength: f.arrayLength }),
      })),
      paddingGaps: here.paddingGaps,
      note: here.isEstimated
        ? 'Some member types could not be resolved; offsets are estimates.'
        : undefined,
    };
  },

  getStructGraph(args, ctx) {
    const app = resolveApp(ctx, args.app);
    if ('error' in app) return app;
    const name = str(args.name);
    if (!name) return err('name is required');
    const roles = app.analysis.structRoles;
    if (!roles?.byName.has(name)) {
      const near = nearest(name, [...(roles?.byName.keys() ?? [])]);
      return err(`No struct named ${name} in ${app.name}.`,
        near.length ? `Did you mean: ${near.join(', ')}` : undefined);
    }
    const maxDepth = Math.min(int(args.depth) ?? 4, MAX_GRAPH_DEPTH);
    const sizeOf = new Map((app.analysis.structCatalog?.layouts ?? []).map((l) => [l.name, l.totalSizeBytes]));

    const walk = (n: string, depth: number, seen: Set<string>): unknown => {
      const info = roles.byName.get(n);
      if (!info) return { name: n, unknown: true };
      const node: Record<string, unknown> = {
        name: n, role: info.role, fields: info.fieldCount, sizeBytes: sizeOf.get(n),
      };
      if (info.pointerFields.length) node.pointerFields = info.pointerFields;
      if (info.variableArrayFields.length) node.variableArrayFields = info.variableArrayFields;
      if (depth < maxDepth && info.contains.length > 0) {
        node.contains = info.contains.map((c) =>
          seen.has(c) ? { name: c, cycle: true } : walk(c, depth + 1, new Set([...seen, c])),
        );
      } else if (info.contains.length > 0) {
        node.containsTruncated = info.contains;
      }
      return node;
    };
    return { app: app.name, tree: walk(name, 0, new Set([name])) };
  },

  getStructRoles(args, ctx) {
    const app = resolveApp(ctx, args.app);
    if ('error' in app) return app;
    const roles = app.analysis.structRoles?.roles ?? [];
    const filter = str(args.role);
    const selected = filter ? roles.filter((r) => r.role === filter) : roles;
    return {
      app: app.name,
      wireRoots: app.analysis.structRoles?.wireRoots ?? [],
      envelopes: app.analysis.structRoles?.envelopes ?? [],
      structs: selected.slice(0, 200).map((r) => ({
        name: r.name, role: r.role, inDegree: r.inDegree, depth: r.depth,
        fields: r.fieldCount, sourceFile: r.sourceFile,
        containedBy: r.containedBy.map((e) => e.parent),
        boundConstants: r.boundConstants,
        ...(r.pointerFields.length && { pointerFields: r.pointerFields }),
        ...(r.variableArrayFields.length && { variableArrayFields: r.variableArrayFields }),
      })),
      ...(selected.length > 200 && { truncated: selected.length - 200 }),
    };
  },

  findUsages(args, ctx) {
    const app = resolveApp(ctx, args.app);
    if ('error' in app) return app;
    const symbol = str(args.symbol);
    if (!symbol) return err('symbol is required');

    const refs = findReferences(symbol, sourceFilesOf(app.files));
    const total = refs.reduce((n, r) => n + r.lines.length, 0);
    return {
      app: app.name, symbol, totalMatches: total, filesMatched: refs.length,
      files: refs.slice(0, MAX_USAGE_FILES).map((r) => ({
        filename: r.filename,
        lines: r.lines.slice(0, MAX_USAGE_LINES).map((l) => ({ line: l.lineNumber, text: l.text })),
        ...(r.lines.length > MAX_USAGE_LINES && { moreLines: r.lines.length - MAX_USAGE_LINES }),
      })),
      ...(refs.length > MAX_USAGE_FILES && { moreFiles: refs.length - MAX_USAGE_FILES }),
    };
  },

  getPayloadResolutions(args, ctx) {
    const app = resolveApp(ctx, args.app);
    if ('error' in app) return app;
    const file = str(args.file);
    const constant = str(args.constant);
    let list = app.analysis.payloadResolutions ?? [];
    if (file) list = list.filter((r) => r.sendSiteFile.includes(file));
    if (constant) list = list.filter((r) => r.msgIdConstant === constant);
    return {
      app: app.name, count: list.length,
      resolutions: list.slice(0, 60).map((r) => ({
        file: r.sendSiteFile, line: r.sendSiteLine, text: r.sendSiteText,
        pattern: r.patternName, struct: r.resolvedStructName,
        msgId: r.msgIdConstant, confidence: r.confidence, strategy: r.strategy, notes: r.notes,
      })),
    };
  },

  getSourceLines(args, ctx) {
    if (!ctx.includeSourceSnippets) {
      return err('Source snippets are disabled for this workstation.',
        'Answer from the analysis metadata, or ask the analyst to enable snippets in settings.');
    }
    const app = resolveApp(ctx, args.app);
    if ('error' in app) return app;
    const file = str(args.file);
    const from = int(args.from);
    const to = int(args.to);
    if (!file || from === undefined || to === undefined) return err('file, from and to are required');

    const hit = app.files.find((f) => f.filename === file)
      ?? app.files.find((f) => f.filename.endsWith(`/${file}`))
      ?? app.files.find((f) => f.filename.includes(file));
    if (!hit) {
      return err(`No file matching "${file}" in ${app.name}.`,
        `Loaded: ${app.files.slice(0, 20).map((f) => f.filename).join(', ')}`);
    }
    const all = hit.content.split('\n');
    const start = Math.max(1, from);
    const end = Math.min(all.length, Math.max(start, to), start + MAX_SOURCE_LINES - 1);
    const lines = all.slice(start - 1, end).map((text, i) => ({ line: start + i, text }));
    return { app: app.name, file: hit.filename, from: start, to: end, totalLines: all.length, lines,
      ...(to > end && { truncated: `requested through ${to}, capped at ${MAX_SOURCE_LINES} lines` }) };
  },

  getUnknownCalls(args, ctx) {
    const app = resolveApp(ctx, args.app);
    if ('error' in app) return app;
    const counts = new Map<string, { count: number; files: Set<string> }>();
    for (const f of app.analysis.files) {
      for (const call of f.unknownCalls) {
        const e = counts.get(call) ?? { count: 0, files: new Set<string>() };
        e.count++;
        e.files.add(f.filename);
        counts.set(call, e);
      }
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
    const sources = sourceFilesOf(app.files);
    return {
      app: app.name, count: ranked.length,
      calls: ranked.slice(0, 40).map(([name, e]) => {
        const refs = findReferences(name, sources);
        return {
          name, sites: e.count, files: [...e.files].sort(),
          samples: refs.slice(0, 2).flatMap((r) =>
            r.lines.slice(0, 2).map((l) => `${r.filename}:${l.lineNumber}: ${l.text}`)),
        };
      }),
    };
  },

  getCrossAppEdges(args, ctx) {
    const analyzed = ctx.apps.filter((a) => a.analysis !== null);
    if (analyzed.length === 0) return err('No analyzed applications are loaded.');
    return { edges: crossAppEdges(analyzed.map((a) => ({ name: a.name, analysis: a.analysis! })), str(args.constant)) };
  },

  searchMessages(args, ctx) {
    const app = resolveApp(ctx, args.app);
    if ('error' in app) return app;
    const pattern = str(args.pattern);
    if (!pattern) return err('pattern is required');

    let re: RegExp;
    try {
      if (regexTooDangerous(pattern)) throw new Error('unsafe');
      re = new RegExp(pattern, 'i');
    } catch {
      // Fall back to a literal substring rather than failing the turn.
      re = new RegExp(escapeRegExp(pattern), 'i');
    }
    const messages = app.analysis.messageInterfaces
      .filter((m) => re.test(m.msgTypeConstant) || (m.struct ? re.test(m.struct.name) : false))
      .slice(0, MAX_SEARCH_RESULTS)
      .map((m) => ({ constant: m.msgTypeConstant, struct: m.struct?.name ?? null, direction: m.direction }));
    const structs = (app.analysis.structRoles?.roles ?? [])
      .filter((r) => re.test(r.name))
      .slice(0, MAX_SEARCH_RESULTS)
      .map((r) => ({ name: r.name, role: r.role, fields: r.fieldCount }));
    return { app: app.name, pattern, messages, structs };
  },
};

// ── Dispatch ──────────────────────────────────────────────────────────────────

export function executeTool(name: string, rawArgs: string, ctx: ToolContext): ToolExecution {
  let args: Record<string, unknown> = {};
  if (rawArgs.trim() !== '') {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      return {
        name, args: {}, failed: true,
        result: err(`Arguments for ${name} were not valid JSON.`,
          `Received: ${rawArgs.slice(0, 200)}. Re-issue the call with a JSON object.`),
      };
    }
  }

  const exec = EXECUTORS[name];
  if (!exec) {
    return {
      name, args, failed: true,
      result: err(`Unknown tool "${name}".`, `Available: ${TOOL_DEFINITIONS.map((t) => t.function.name).join(', ')}`),
    };
  }

  try {
    const result = exec(args, ctx);
    const failed = typeof result === 'object' && result !== null && 'error' in result;
    return { name, args, result, failed };
  } catch (e) {
    // A crash in an executor must not kill the conversation.
    return {
      name, args, failed: true,
      result: err(`${name} failed: ${(e as Error)?.message ?? String(e)}`),
    };
  }
}

/** Short human-readable label for the tool-call trace in the UI. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const primary = args.constant ?? args.name ?? args.symbol ?? args.pattern ?? args.file ?? args.role;
  return primary !== undefined ? `${name}(${String(primary)})` : `${name}()`;
}
