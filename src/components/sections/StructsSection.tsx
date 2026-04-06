import { useState } from 'react';
import type { CStruct, FileRef, LoadedFile } from '../../analyzer/types';
import { findReferences } from '../../utils/findReferences';
import Accordion from '../Accordion';

interface StructsSectionProps {
  structs: CStruct[];
  sourceFiles: LoadedFile[];
  onAddAsMsgStructPattern?: (structName: string) => void;
}

function RefPanel({ structName, sourceFiles, onClose }: {
  structName: string;
  sourceFiles: LoadedFile[];
  onClose: () => void;
}) {
  const refs: FileRef[] = findReferences(structName, sourceFiles);

  return (
    <div className="mt-2 bg-gray-900 border border-gray-700 rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-400 font-mono font-semibold">{structName} — references</span>
        <button className="text-gray-600 hover:text-gray-400 text-xs" onClick={onClose}>✕</button>
      </div>
      {refs.length === 0 ? (
        <p className="text-xs text-gray-600 italic">No references found in loaded source files</p>
      ) : (
        <div className="space-y-3">
          {refs.map((r) => (
            <div key={r.filename}>
              <div className="text-xs font-mono text-gray-500 mb-0.5">{r.filename}</div>
              {r.lines.map((l) => (
                <div key={l.lineNumber} className="flex gap-2 font-mono text-xs leading-5">
                  <span className="text-gray-700 w-8 shrink-0 text-right select-none">{l.lineNumber}</span>
                  <span className="text-gray-400 truncate">{l.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StructCard({ s, sourceFiles, onAddAsMsgStructPattern }: { s: CStruct; sourceFiles: LoadedFile[]; onAddAsMsgStructPattern?: (name: string) => void }) {
  const [showRefs, setShowRefs] = useState(false);

  return (
    <div className="font-mono text-sm bg-gray-950/50 rounded p-3">
      <div className="text-gray-400 mb-1 flex items-center gap-2 flex-wrap">
        <span>
          struct{' '}
          <button
            className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2 decoration-dotted transition-colors"
            onClick={() => setShowRefs((v) => !v)}
            title="Show references"
          >
            {s.name}
          </button>
          {' {'}
        </span>
        {s.conditional && (
          <span className="text-xs text-yellow-500">⚠ conditional</span>
        )}
        {onAddAsMsgStructPattern && (
          <button
            className="text-xs text-gray-600 hover:text-blue-400 transition-colors px-1 ml-auto"
            title={`Add ${s.name} as a message struct pattern`}
            onClick={() => onAddAsMsgStructPattern(s.name)}
          >
            +
          </button>
        )}
      </div>
      {s.fields.map((f, i) => (
        <div key={i} className="pl-4 text-gray-300">
          <span className="text-gray-500">{f.type.padEnd(20)}</span> {f.name};
        </div>
      ))}
      <div className="text-gray-400">{'}'}</div>
      <div className="text-gray-600 text-xs mt-1">from: {s.sourceFile}</div>
      {s.conflictsWith && s.conflictsWith.length > 0 && (
        <div className="text-yellow-500 text-xs mt-0.5">
          ⚠ Conflicts with: {s.conflictsWith.join(', ')}
        </div>
      )}
      {showRefs && (
        <RefPanel
          structName={s.name}
          sourceFiles={sourceFiles}
          onClose={() => setShowRefs(false)}
        />
      )}
    </div>
  );
}

export default function StructsSection({ structs, sourceFiles, onAddAsMsgStructPattern }: StructsSectionProps) {
  if (structs.length === 0) return null;

  return (
    <Accordion title="Structs" count={structs.length}>
      <div className="mt-2 space-y-3">
        {structs.map((s) => (
          <StructCard key={s.name} s={s} sourceFiles={sourceFiles} onAddAsMsgStructPattern={onAddAsMsgStructPattern} />
        ))}
      </div>
    </Accordion>
  );
}
