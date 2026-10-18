import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import { isImeKey } from "../keyboard";
import { THREAD_FIND_COPY as COPY } from "./copy";

export function FindBar({
  query,
  count,
  index,
  inputRef,
  onQuery,
  onNext,
  onPrevious,
  onClose,
}: {
  query: string;
  count: number;
  index: number;
  inputRef: RefObject<HTMLInputElement>;
  onQuery: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}) {
  const status = query.trim().length === 0 ? "" : count === 0 ? COPY.empty : `${index + 1}/${count}`;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isImeKey({ composing: event.nativeEvent.isComposing, keyCode: event.keyCode })) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) onPrevious();
    else onNext();
  };

  return (
    <div
      data-thread-find
      role="search"
      className="absolute right-3 top-2 z-30 flex items-center gap-0.5 rounded-lg border border-[#2a2a2a] bg-[#1c1c1c] py-1 pl-2.5 pr-1 shadow-lg shadow-black/40"
    >
      <input
        ref={inputRef}
        value={query}
        aria-label={COPY.find}
        placeholder={COPY.find}
        className="h-7 w-40 bg-transparent text-sm text-[#e8e8e8] outline-none placeholder:text-[#777]"
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span data-thread-find-status className="min-w-14 px-1 text-right text-xs text-[#9a9a9a]">
        {status}
      </span>
      <FindButton label={COPY.previous} disabled={count === 0} onClick={onPrevious}>
        <ChevronUp className="h-4 w-4" />
      </FindButton>
      <FindButton label={COPY.next} disabled={count === 0} onClick={onNext}>
        <ChevronDown className="h-4 w-4" />
      </FindButton>
      <FindButton label={COPY.close} onClick={onClose}>
        <X className="h-4 w-4" />
      </FindButton>
    </div>
  );
}

function FindButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="flex h-7 w-7 items-center justify-center rounded-md text-[#cfcfcf] hover:bg-white/10 disabled:text-[#555] disabled:hover:bg-transparent"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
