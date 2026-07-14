export class ResultReceiptWaiters<Receipt extends { runId: string }> {
  wait(runId: string): Promise<Receipt>;
  settle(receipt: Receipt): number;
  pendingRuns(): number;
}
export function catalogResultAllowsProgress(
  receipt: { runId: string; status: string } | null | undefined,
  runId: string,
): boolean;
