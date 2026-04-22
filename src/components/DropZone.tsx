import { useRef, useState } from 'react';
import type { FileZone } from '../analyzer/types';

interface DropZoneProps {
  zone: FileZone;
  onFiles: (files: File[]) => void;
  label: string;
  accept: string;
  description: string;
  allowDirectory?: boolean;
}

export default function DropZone({ zone: _zone, onFiles, label, accept, description, allowDirectory }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const ACCEPT_EXTS = accept.split(',').map((s) => s.trim().toLowerCase());

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const filtered = Array.from(files).filter((f) =>
      ACCEPT_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext))
    );
    onFiles(filtered);
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
      className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-8 transition-colors
        ${dragging ? 'border-blue-500 bg-blue-950/20' : 'border-gray-700 hover:border-gray-500 bg-gray-900/30'}`}
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
        onClick={(e) => { (e.target as HTMLInputElement).value = ''; }}
      />
      {allowDirectory && (
        <input
          ref={dirInputRef}
          type="file"
          className="hidden"
          // @ts-expect-error webkitdirectory is not in React's typings
          webkitdirectory=""
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          onClick={(e) => { (e.target as HTMLInputElement).value = ''; }}
        />
      )}
      <div className="text-sm font-semibold text-gray-300 mb-1">{label}</div>
      <div className="text-xs text-gray-500 text-center">{description}</div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          className="text-xs text-gray-600 hover:text-gray-400 underline underline-offset-2 transition-colors cursor-pointer"
          onClick={() => inputRef.current?.click()}
        >
          Select files
        </button>
        {allowDirectory && (
          <>
            <span className="text-gray-700 text-xs">or</span>
            <button
              type="button"
              className="text-xs text-gray-600 hover:text-gray-400 underline underline-offset-2 transition-colors cursor-pointer"
              onClick={() => dirInputRef.current?.click()}
            >
              ingest directory
            </button>
          </>
        )}
        {!allowDirectory && (
          <span className="text-xs text-gray-600">or drag files here</span>
        )}
      </div>
    </div>
  );
}
