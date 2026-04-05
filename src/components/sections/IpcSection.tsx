import type { IpcCall } from '../../analyzer/types';
import Accordion from '../Accordion';

interface IpcSectionProps {
  ipc: IpcCall[];
}

const typeColor: Partial<Record<string, string>> = {
  socket: 'text-blue-400',
  'socket-send': 'text-blue-300',
  'socket-recv': 'text-blue-300',
  'shared-mem': 'text-purple-400',
  pipe: 'text-yellow-400',
  fifo: 'text-yellow-400',
  mqueue: 'text-orange-400',
  semaphore: 'text-pink-400',
  signal: 'text-red-400',
  thread: 'text-cyan-400',
  'process-fork': 'text-green-400',
  'process-exec': 'text-green-400',
  'file-io': 'text-gray-400',
  ioctl: 'text-gray-400',
  custom: 'text-teal-400',
};

export default function IpcSection({ ipc }: IpcSectionProps) {
  if (ipc.length === 0) return null;

  return (
    <Accordion title="IPC Calls" count={ipc.length}>
      <div className="mt-2 space-y-1">
        {ipc.map((call, i) => (
          <div key={i} className="flex items-start gap-3 py-1 border-b border-gray-800/60 last:border-0">
            <span className={`shrink-0 font-mono text-xs font-semibold mt-0.5 w-28 ${typeColor[call.type] ?? 'text-gray-400'}`}>
              {call.type}
            </span>
            <span className="font-mono text-xs text-gray-400 truncate">{call.detail}</span>
          </div>
        ))}
      </div>
    </Accordion>
  );
}
