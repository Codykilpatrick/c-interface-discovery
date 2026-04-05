import { useRef, useState } from 'react';
import type { FileZone } from '../analyzer/types';

interface DropZoneProps {
  zone: FileZone;
  onFiles: (files: File[]) => void;
  label: string;
  accept: string;
  description: string;
}

export default function DropZone({ zone: _zone, onFiles, label, accept, description }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    onFiles(Array.from(files));
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragging(true);
  }

  function onDragLeave() {
    setDragging(false);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  return (
    <div
      className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-8 cursor-pointer transition-colors
        ${dragging ? 'border-blue-500 bg-blue-950/20' : 'border-gray-700 hover:border-gray-500 bg-gray-900/30'}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
        // Reset input so re-dropping same file triggers onChange
        onClick={(e) => { (e.target as HTMLInputElement).value = ''; }}
      />
      <div className="text-sm font-semibold text-gray-300 mb-1">{label}</div>
      <div className="text-xs text-gray-500 text-center">{description}</div>
      <div className="mt-3 text-xs text-gray-600">Click to select or drag files here</div>
    </div>
  );
}
