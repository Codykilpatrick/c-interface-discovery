import type {
  CEnum,
  CStruct,
  FileAnalysis,
  HeaderGenBundle,
  HeaderGenReview,
  HeaderGenType,
  LoadedFile,
  MessageInterface,
  TypeDict,
} from './types';
import type { PayloadResolution } from './payloadResolver';
import { findReferences } from '../utils/findReferences';

const PRIMITIVES = new Set([
  'char', 'short', 'int', 'long', 'float', 'double', 'void',
  'signed', 'unsigned', '_Bool', 'bool',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'size_t', 'ssize_t', 'uintptr_t', 'intptr_t', 'ptrdiff_t', 'wchar_t',
]);

const INCLUDE_RE = /^[ \t]*#[ \t]*include[ \t]*([<"])([^>"]+)[>"]/gm;

export function extractIncludes(content: string): { path: string; isLocal: boolean }[] {
  const out: { path: string; isLocal: boolean }[] = [];
  INCLUDE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INCLUDE_RE.exec(content)) !== null) {
    out.push({ path: m[2], isLocal: m[1] === '"' });
  }
  return out;
}

export function dirOf(path: string): string {
  const i = path.replace(/\\/g, '/').lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function dirsOf(paths: string[]): string[] {
  const set = new Set<string>();
  for (const f of paths) {
    const d = dirOf(f);
    if (d) set.add(d);
  }
  return [...set].sort();
}

function joinPath(dir: string, rel: string): string {
  const parts = [...dir.split('/'), ...rel.replace(/\\/g, '/').split('/')];
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

export function resolveInclude(
  fromFile: string,
  includePath: string,
  loaded: string[],
): { file?: string; ambiguous?: string[] } {
  const want = includePath.replace(/\\/g, '/');
  const sibling = joinPath(dirOf(fromFile), want);
  if (loaded.includes(sibling)) return { file: sibling };
  if (loaded.includes(want)) return { file: want };

  const suffix = loaded.filter((f) => f === want || f.endsWith(`/${want}`));
  if (suffix.length === 1) return { file: suffix[0] };
  if (suffix.length > 1) return { ambiguous: suffix };
  return {};
}

function isHeader(path: string): boolean {
  return /\.h$/i.test(path);
}

/**
 * Strip qualifiers, pointers and array extents from a member type and follow
 * typedef aliases to the underlying name. Shared with `structRoleAnalyzer`.
 */
export function canonicalName(raw: string, typeDict: TypeDict): string {
  let name = raw
    .replace(/\b(const|volatile|restrict|struct|union|enum)\b/g, '')
    .replace(/\*/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = name.split(' ').filter((t) => t && t !== 'signed' && t !== 'unsigned');
  name = tokens[tokens.length - 1] ?? '';
  for (let hops = 0; hops < 4; hops++) {
    const alias = typeDict.typedefAliases?.[name];
    if (!alias || alias === name) break;
    name = alias;
  }
  return name;
}

function lookupType(name: string, typeDict: TypeDict): CStruct | CEnum | null {
  return typeDict.structs.find((s) => s.name === name)
    ?? typeDict.enums.find((e) => e.name === name)
    ?? null;
}

export interface HeaderGenBundleInput {
  messageInterfaces: MessageInterface[];
  payloadResolutions: PayloadResolution[];
  typeDict: TypeDict;
  files: LoadedFile[];
  analyses?: FileAnalysis[];
}

export function buildHeaderGenBundle(input: HeaderGenBundleInput): HeaderGenBundle {
  const { messageInterfaces, payloadResolutions, typeDict, files, analyses = [] } = input;
  const loaded = files.map((f) => f.filename);
  const contentByFile = new Map(files.map((f) => [f.filename, f.content]));
  const review: HeaderGenReview[] = [];

  const topLevel: { name: string; file: string }[] = [];
  const pendingUnresolved: MessageInterface[] = [];
  const sources = files.filter((f) => /\.(c|cpp)$/i.test(f.filename));

  function usedInSources(name: string): boolean {
    return name.length > 0 && findReferences(name, sources).length > 0;
  }

  for (const msg of messageInterfaces) {
    const constantUsed = usedInSources(msg.msgTypeConstant);
    const structUsed = Boolean(msg.struct && usedInSources(msg.struct.name));
    if (!constantUsed && !structUsed) continue;

    if (!msg.structResolved || !msg.struct) {
      pendingUnresolved.push(msg);
      continue;
    }
    topLevel.push({ name: msg.struct.name, file: msg.struct.sourceFile });
  }

  for (const res of payloadResolutions) {
    if (res.confidence !== 'high' && res.confidence !== 'medium') {
      if (res.resolvedStructName) {
        review.push({
          kind: 'unresolved-type',
          message: `${res.resolvedStructName} at ${res.sendSiteFile}:${res.sendSiteLine} (${res.confidence})`,
        });
      }
      continue;
    }
    const file = res.resolvedStruct?.sourceFile;
    const name = res.resolvedStruct?.name ?? res.resolvedStructName;
    if (!name || !file) {
      review.push({
        kind: 'unresolved-type',
        message: `${res.resolvedStructName ?? 'payload'} at ${res.sendSiteFile}:${res.sendSiteLine}: no defining header`,
      });
      continue;
    }
    topLevel.push({ name, file });
  }

  for (const s of typeDict.structs) {
    if (usedInSources(s.name)) {
      topLevel.push({ name: s.name, file: s.sourceFile });
    }
  }
  for (const fa of analyses) {
    for (const ipc of fa.ipc) {
      for (const name of ipc.impliedStructs ?? []) {
        const found = typeDict.structs.find((s) => s.name === name);
        if (found) topLevel.push({ name: found.name, file: found.sourceFile });
      }
    }
  }

  for (const src of sources) {
    for (const inc of extractIncludes(src.content)) {
      if (!inc.isLocal) continue;
      const hit = resolveInclude(src.filename, inc.path, loaded);
      if (hit.file && isHeader(hit.file)) {
        for (const s of typeDict.structs) {
          if (s.sourceFile === hit.file) topLevel.push({ name: s.name, file: s.sourceFile });
        }
      } else if (hit.ambiguous) {
        review.push({
          kind: 'ambiguous-include',
          message: `${src.filename} includes "${inc.path}" — matches ${hit.ambiguous.join(', ')}`,
        });
      } else {
        review.push({
          kind: 'unresolved-include',
          message: `${src.filename} includes "${inc.path}" — not in loaded files`,
        });
      }
    }
  }

  const roots: string[] = [];
  const seenRoot = new Set<string>();
  for (const t of topLevel) {
    if (!isHeader(t.file)) {
      review.push({ kind: 'source-root', message: `${t.name} is defined in ${t.file}, not a header` });
      continue;
    }
    if (seenRoot.has(t.file)) continue;
    seenRoot.add(t.file);
    roots.push(t.file);
  }

  const reachedFrom = new Map<string, Set<string>>();
  const typeFile = new Map<string, string>();
  const seenType = new Set<string>();

  function addReached(name: string, root: string) {
    let set = reachedFrom.get(name);
    if (!set) {
      set = new Set();
      reachedFrom.set(name, set);
    }
    set.add(root);
  }

  function walkType(raw: string, root: string) {
    const name = canonicalName(raw, typeDict);
    if (!name || PRIMITIVES.has(name)) return;
    const key = `${root}::${name}`;
    if (seenType.has(key)) return;
    seenType.add(key);

    const found = lookupType(name, typeDict);
    if (!found) {
      review.push({ kind: 'unresolved-type', message: `${name} (from ${root}): not in type dictionary` });
      return;
    }
    typeFile.set(name, found.sourceFile);
    addReached(name, root);
    if ('fields' in found) {
      for (const field of found.fields) walkType(field.type, root);
    }
  }

  for (const t of topLevel) {
    if (!isHeader(t.file)) continue;
    walkType(t.name, t.file);
  }

  const inputSet = new Set<string>();
  for (const file of typeFile.values()) {
    if (isHeader(file)) inputSet.add(file);
  }

  const includeReached = new Set<string>();
  const seenIncludeWalk = new Set<string>();

  function walkIncludes(file: string) {
    if (seenIncludeWalk.has(file)) return;
    seenIncludeWalk.add(file);
    includeReached.add(file);
    const content = contentByFile.get(file);
    if (content === undefined) return;
    for (const inc of extractIncludes(content)) {
      if (!inc.isLocal) continue;
      const hit = resolveInclude(file, inc.path, loaded);
      if (hit.file) {
        walkIncludes(hit.file);
      } else if (hit.ambiguous) {
        review.push({
          kind: 'ambiguous-include',
          message: `${file} includes "${inc.path}" — matches ${hit.ambiguous.join(', ')}`,
        });
      } else {
        review.push({
          kind: 'unresolved-include',
          message: `${file} includes "${inc.path}" — not in loaded files`,
        });
      }
    }
  }

  for (const root of roots) walkIncludes(root);
  for (const file of inputSet) walkIncludes(file);

  const includeFiles = [...includeReached].filter((f) => isHeader(f) && !inputSet.has(f)).sort();
  const inputFiles = [...inputSet].sort();
  const rootFiles = [...roots].sort();
  const selected = new Set([...rootFiles, ...inputFiles, ...includeFiles]);
  const selectedBase = new Set([...selected].map((f) => f.split('/').pop() ?? f));

  for (const msg of pendingUnresolved) {
    const from = msg.definedIn;
    if (from && (selected.has(from) || selectedBase.has(from.split('/').pop() ?? from))) continue;
    review.push({
      kind: 'unresolved-type',
      message: `${msg.msgTypeConstant}: struct not resolved`,
    });
  }

  const inputDirs = dirsOf(inputFiles);
  const dirSet = new Set<string>([...inputDirs, ...dirsOf(includeFiles)]);

  const types: HeaderGenType[] = [...typeFile.entries()]
    .map(([name, file]) => ({
      name,
      file,
      reachedFrom: [...(reachedFrom.get(name) ?? [])].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const seenReview = new Set<string>();
  const dedupedReview = review.filter((r) => {
    const k = `${r.kind}:${r.message}`;
    if (seenReview.has(k)) return false;
    seenReview.add(k);
    return true;
  });

  return {
    root: rootFiles,
    input: inputFiles,
    inputDirs,
    include: includeFiles,
    includeDirs: [...dirSet].sort(),
    types,
    review: dedupedReview,
  };
}
