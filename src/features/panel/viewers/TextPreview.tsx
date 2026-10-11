import { TruncatedNote } from "./TruncatedNote";

export function TextPreview({ text, truncated }: { text: string; truncated: boolean }) {
  return (
    <div className="h-full overflow-auto">
      {truncated ? <TruncatedNote /> : null}
      <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-5 text-zinc-200">
        {text}
      </pre>
    </div>
  );
}
