import type { MessageInterface } from '../../analyzer/types';
import Accordion from '../Accordion';

interface MessagingSectionProps {
  messages: MessageInterface[];
}

const directionBadge: Record<string, { label: string; cls: string }> = {
  producer: { label: 'PRODUCER', cls: 'bg-blue-900/60 text-blue-300' },
  consumer: { label: 'CONSUMER', cls: 'bg-green-900/60 text-green-300' },
  both: { label: 'BOTH', cls: 'bg-purple-900/60 text-purple-300' },
  unknown: { label: 'UNKNOWN', cls: 'bg-gray-700 text-gray-400' },
};

export default function MessagingSection({ messages }: MessagingSectionProps) {
  if (messages.length === 0) return null;

  return (
    <Accordion title="Messaging Interfaces" count={messages.length} defaultOpen>
      <div className="space-y-3 mt-2">
        {messages.map((msg) => {
          const dir = directionBadge[msg.direction] ?? directionBadge.unknown;
          return (
            <div
              key={msg.msgTypeConstant}
              className="border border-gray-700 rounded-lg p-4 bg-gray-900/40"
            >
              {/* Header row */}
              <div className="flex items-center gap-3 flex-wrap mb-3">
                <span className="font-mono font-semibold text-gray-100">{msg.msgTypeConstant}</span>
                <span className="font-mono text-gray-500 text-sm">{msg.msgTypeValue}</span>
                <span className={`px-2 py-0.5 rounded text-xs font-semibold ${dir.cls}`}>
                  {dir.label}
                </span>
                {msg.transport && (
                  <span className="px-2 py-0.5 rounded text-xs bg-gray-800 text-gray-400">
                    via {msg.transport}
                  </span>
                )}
              </div>

              {/* Struct */}
              {msg.struct ? (
                <div className="font-mono text-sm bg-gray-950/60 rounded p-3 mb-2">
                  <div className="text-gray-400 mb-1">
                    struct <span className="text-cyan-400">{msg.struct.name}</span> {'{'}
                  </div>
                  {msg.struct.fields.map((field, i) => (
                    <div key={i} className="pl-4 text-gray-300">
                      <span className="text-gray-500">{field.type.padEnd(20)}</span> {field.name};
                    </div>
                  ))}
                  <div className="text-gray-400">{'}'}</div>
                  <div className="text-gray-600 text-xs mt-1">defined in: {msg.struct.sourceFile}</div>
                  {msg.struct.conditional && (
                    <div className="text-yellow-500 text-xs mt-0.5">⚠ conditionally defined</div>
                  )}
                </div>
              ) : null}

              {/* Referenced in */}
              {msg.usedIn.length > 0 && (
                <div className="text-xs text-gray-500 mb-2">
                  referenced in: {msg.usedIn.join(', ')}
                </div>
              )}
              <div className="text-xs text-gray-600">defined in: {msg.definedIn}</div>

              {/* Inline warnings */}
              {!msg.structResolved && (
                <div className="mt-2 text-xs text-yellow-500">
                  ⚠ Struct not resolved — may be in an unloaded header
                </div>
              )}
              {!msg.directionConfident && (
                <div className="mt-1 text-xs text-yellow-500">
                  ⚠ Direction unknown — manual review needed
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Accordion>
  );
}
