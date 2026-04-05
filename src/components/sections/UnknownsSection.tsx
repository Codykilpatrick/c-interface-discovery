import Accordion from '../Accordion';

interface UnknownsSectionProps {
  unknownCalls: string[];
  onAddAsPattern: (fnName: string) => void;
}

export default function UnknownsSection({ unknownCalls, onAddAsPattern }: UnknownsSectionProps) {
  if (unknownCalls.length === 0) return null;

  return (
    <Accordion title="Unknown External Calls" count={unknownCalls.length}>
      <p className="text-xs text-gray-600 mt-2 mb-3">
        Calls not recognized as IPC or stdlib. Click + to add as a custom pattern.
      </p>
      <div className="flex flex-wrap gap-2">
        {unknownCalls.map((name) => (
          <div key={name} className="flex items-center gap-1">
            <span className="font-mono text-sm px-2 py-1 bg-gray-800 rounded text-gray-400">
              {name}()
            </span>
            <button
              className="text-xs text-gray-600 hover:text-blue-400 transition-colors px-1"
              title={`Add ${name} as a custom pattern`}
              onClick={() => onAddAsPattern(name)}
            >
              +
            </button>
          </div>
        ))}
      </div>
    </Accordion>
  );
}
