export interface SubmitFlight {
  sessionId: string;
  fingerprint: string;
}

/** 同一份草稿没变之前，不能再送出一次。 */
export function submitFingerprint(input: {
  editingId: string | null;
  text: string;
  fileCount: number;
  snippetCount: number;
}): string {
  return `${input.editingId ?? ""}\0${input.text}\0${input.fileCount}\0${input.snippetCount}`;
}

export function claimSubmit(
  flight: SubmitFlight | null,
  next: SubmitFlight,
): { flight: SubmitFlight; claimed: boolean } {
  if (flight && flight.sessionId === next.sessionId && flight.fingerprint === next.fingerprint) {
    return { flight, claimed: false };
  }
  return { flight: next, claimed: true };
}

/** 草稿变了就放行下一次发送。还是同一份时继续占着。 */
export function releaseSubmitOnEdit(
  flight: SubmitFlight | null,
  sessionId: string,
  fingerprint: string,
): SubmitFlight | null {
  if (!flight || flight.sessionId !== sessionId) return flight;
  if (flight.fingerprint === fingerprint) return flight;
  return null;
}

/** 失败的那一次可以重试。更新的一次还占着时，不能被旧请求清掉。 */
export function settleSubmit(
  flight: SubmitFlight | null,
  sessionId: string,
  fingerprint: string,
): SubmitFlight | null {
  if (!flight || flight.sessionId !== sessionId || flight.fingerprint !== fingerprint) return flight;
  return null;
}

/** 请求回来时输入框已经改过，就留下新内容。 */
export function shouldClearSubmittedText(live: string | null, submitted: string): boolean {
  return live == null || live === submitted;
}

/** 先清空再发的那条没送出去。输入框还空着才把原文放回去，用户已经在写新的就不动。 */
export function shouldRestoreFailedText(live: string | null): boolean {
  return live == null || live === "";
}
