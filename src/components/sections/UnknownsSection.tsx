import Accordion from '../Accordion';

interface UnknownsSectionProps {
  unknownCalls: string[];
}

export default function UnknownsSection({ unknownCalls }: UnknownsSectionProps) {
  if (unknownCalls.length === 0) return null;

  return (
    <Accordion title="Unknown External Calls" count={unknownCalls.length}>
      <div className="mt-2 flex flex-wrap gap-2">
        {unknownCalls.map((name) => (
          <span key={name} className="font-mono text-sm px-2 py-1 bg-gray-800 rounded text-gray-400">
            {name}()
          </span>
        ))}
      </div>
    </Accordion>
  );
}
