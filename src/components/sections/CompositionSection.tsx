import { useState } from 'react';
import type { CompositionPart, MessageComposition } from '../../analyzer/messageComposition';
import { summarizeComposition } from '../../analyzer/messageComposition';
import type { StructRole, StructRoleReport } from '../../analyzer/structRoleAnalyzer';
import Accordion from '../Accordion';

interface CompositionSectionProps {
  compositions: MessageComposition[];
  structRoles?: StructRoleReport;
  /** Target the byte offsets were computed for. */
  target: '32bit' | '64bit';
}

const ROLE_LABEL: Record<StructRole, string> = {
  'wire-root': 'message',
  'wire-root-nested': 'message + block',
  'envelope': 'envelope',
  'root-candidate': 'root?',
  'shared-block': 'shared',
  'block': 'block',
  'orphan': 'orphan',
};

const ROLE_CLASS: Record<StructRole, string> = {
  'wire-root': 'text-emerald-400 border-emerald-900/70',
  'wire-root-nested': 'text-emerald-300 border-emerald-800/70',
  'envelope': 'text-violet-300 border-violet-900/70',
  'root-candidate': 'text-amber-300 border-amber-900/70',
  'shared-block': 'text-sky-300 border-sky-900/70',
  'block': 'text-gray-400 border-gray-700',
  'orphan': 'text-gray-600 border-gray-800',
};

function RoleChip({ role }: { role: StructRole }) {
  return (
    <span className={`px-1.5 py-0.5 text-[10px] rounded border ${ROLE_CLASS[role]}`}>
      {ROLE_LABEL[role]}
    </span>
  );
}

/** One row of the expanded byte map. Padding is a row, not an implied gap. */
function PartRow({ part, depth }: { part: CompositionPart; depth: number }) {
  const indent = { paddingLeft: `${depth * 1.25}rem` };

  if (part.kind === 'padding') {
    return (
      <div className="flex gap-3 font-mono text-xs leading-6 text-amber-500/80 bg-amber-950/20">
        <span className="w-14 shrink-0 text-right text-gray-600 select-none">@{part.offsetBytes}</span>
        <span className="w-12 shrink-0 text-right">{part.sizeBytes}B</span>
        <span style={indent} className="truncate">
          ░ padding
          {part.causedByType && (
            <span className="text-gray-500"> — aligning {part.causedByType} to {part.causedByAlign}</span>
          )}
          {part.atCompositionBoundary && (
            <span className="text-amber-400/70"> · between blocks</span>
          )}
        </span>
      </div>
    );
  }

  const isBlock = part.kind === 'block';
  return (
    <>
      <div className="flex gap-3 font-mono text-xs leading-6 hover:bg-gray-800/40">
        <span className="w-14 shrink-0 text-right text-gray-600 select-none">@{part.offsetBytes}</span>
        <span className="w-12 shrink-0 text-right text-gray-500">{part.sizeBytes}B</span>
        <span style={indent} className="truncate flex items-center gap-2">
          <span className={isBlock ? 'text-gray-200' : 'text-gray-400'}>{part.name}</span>
          {isBlock && (
            <>
              <span className="text-gray-600">:</span>
              <span className="text-blue-300">
                {part.typeName}
                {part.arrayLength !== undefined && `[${part.arrayLength}]`}
              </span>
              {part.role && <RoleChip role={part.role} />}
            </>
          )}
        </span>
      </div>
      {part.children?.map((c, i) => (
        <PartRow key={`${c.kind}-${c.offsetBytes}-${i}`} part={c} depth={depth + 1} />
      ))}
    </>
  );
}

function MessageCard({ comp, target }: { comp: MessageComposition; target: '32bit' | '64bit' }) {
  const [open, setOpen] = useState(false);
  const other = target === '64bit' ? '32bit' : '64bit';

  return (
    <div className="border border-gray-800 rounded mb-1.5 bg-gray-900/40">
      <button
        className="w-full text-left px-3 py-2 hover:bg-gray-800/40"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-gray-600 text-xs">{open ? '▾' : '▸'}</span>
            <span className="font-mono text-sm text-emerald-300">{comp.msgConstant}</span>
            <span className="text-gray-600 text-xs">→</span>
            <span className="font-mono text-sm text-blue-300">{comp.rootStruct}</span>
          </div>
          <div className="flex items-center gap-2 text-xs shrink-0">
            <span className="text-gray-400 font-mono">
              {comp.sizeByTarget[target]}B
              <span className="text-gray-600"> ({target.replace('bit', '-bit')})</span>
            </span>
            {comp.differsAcrossTargets && (
              <span
                className="px-1.5 py-0.5 rounded border border-red-900/70 text-red-300"
                title={`${comp.sizeByTarget[other]}B on ${other} — a receiver built for the other target reads every field after the first mismatch at the wrong offset`}
              >
                ⚠ {comp.sizeByTarget[other]}B on {other.replace('bit', '-bit')}
              </span>
            )}
            {comp.packAttribute !== undefined && (
              <span className="px-1.5 py-0.5 rounded border border-violet-900/70 text-violet-300">
                packed({comp.packAttribute})
              </span>
            )}
            {comp.isEstimated && (
              <span
                className="px-1.5 py-0.5 rounded border border-amber-900/70 text-amber-300"
                title="Some member types could not be resolved — offsets are estimates"
              >
                estimated
              </span>
            )}
          </div>
        </div>
        <div className="font-mono text-xs text-gray-500 mt-1 pl-5 break-all">
          = {summarizeComposition(comp)}
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-800 px-3 py-2">
          <div className="flex gap-3 font-mono text-[10px] text-gray-600 uppercase tracking-wide mb-1">
            <span className="w-14 shrink-0 text-right">offset</span>
            <span className="w-12 shrink-0 text-right">size</span>
            <span>member</span>
          </div>
          {comp.parts.map((p, i) => (
            <PartRow key={`${p.kind}-${p.offsetBytes}-${i}`} part={p} depth={0} />
          ))}

          {(comp.pointerWarnings.length > 0 || comp.variableArrayWarnings.length > 0) && (
            <div className="mt-2 pt-2 border-t border-gray-800 space-y-1">
              {comp.pointerWarnings.length > 0 && (
                <p className="text-xs text-amber-400/90">
                  ⚠ Pointer members — not flat-serializable:{' '}
                  <span className="font-mono text-gray-400">{comp.pointerWarnings.join(', ')}</span>
                </p>
              )}
              {comp.variableArrayWarnings.length > 0 && (
                <p className="text-xs text-amber-400/90">
                  ⚠ Macro-length arrays — <code>sizeof</code> misreports these:{' '}
                  <span className="font-mono text-gray-400">
                    {comp.variableArrayWarnings.join(', ')}
                  </span>
                </p>
              )}
            </div>
          )}
          <p className="text-[11px] text-gray-600 mt-2">
            Offsets are absolute within {comp.rootStruct}, computed for the {target.replace('bit', '-bit')} target.
          </p>
        </div>
      )}
    </div>
  );
}

export default function CompositionSection({
  compositions,
  structRoles,
  target,
}: CompositionSectionProps) {
  if (compositions.length === 0) return null;

  const differing = compositions.filter((c) => c.differsAcrossTargets);
  const packingSeen = compositions.some((c) => c.packAttribute !== undefined);
  const envelopes = structRoles?.envelopes ?? [];
  const candidates = structRoles?.roles.filter((r) => r.role === 'root-candidate') ?? [];

  return (
    <Accordion title="Message Composition" count={compositions.length} defaultOpen>
      {differing.length > 0 && (
        <div className="mb-3 p-2.5 border border-red-900/60 bg-red-950/20 rounded text-xs text-red-300">
          <strong>{differing.length} of {compositions.length} messages change size between
          32-bit and 64-bit.</strong>{' '}
          <span className="text-gray-400">
            Exchanged between hosts of different word size, every field after the first
            mismatch is read at the wrong offset.
          </span>
        </div>
      )}

      {envelopes.length > 0 && (
        <p className="mb-2 text-xs text-gray-500">
          Envelope{envelopes.length > 1 ? 's' : ''}:{' '}
          <span className="font-mono text-violet-300">{envelopes.join(', ')}</span>
          {' '}— prepended to multiple messages.
        </p>
      )}

      {compositions.map((c) => (
        <MessageCard key={c.msgConstant} comp={c} target={target} />
      ))}

      {candidates.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-800">
          <p className="text-xs text-gray-500 mb-1">
            Root candidates — nothing embeds them and they are used in source, but no message
            constant resolved. Often a messaging wrapper the pattern registry has not learned yet:
          </p>
          <p className="font-mono text-xs text-amber-300">
            {candidates.map((r) => r.name).join(', ')}
          </p>
        </div>
      )}

      {!packingSeen && (
        <p className="mt-3 text-[11px] text-gray-600">
          No <code>__attribute__((packed))</code> or <code>#pragma pack</code> detected in the
          loaded headers. Offsets assume natural alignment — a packed struct compiled from
          headers not loaded here would lay out differently.
        </p>
      )}
    </Accordion>
  );
}
