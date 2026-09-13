export function publicEvidence(r: any) {
  const result = r.toolResult;
  if (result?.finalHttpStatus !== 200 || result.asset?.status !== 'success') throw new Error('No delivered asset in this receipt');
  const a = result.asset;
  return {
    request: r.request, tool: r.decision.tool, prompt: r.decision.arguments.prompt,
    model: r.model, initialHttpStatus: result.initialHttpStatus, finalHttpStatus: result.finalHttpStatus,
    network: a.network, amount: a.paymentAmount, payer: result.settlement.payer,
    recipient: r.recipient ?? null,
    transactionId: result.settlement.transaction, verified: r.serviceEvidence.verification.isValid,
    settled: result.settlement.success, taskId: a.tripoTaskId, credits: a.creditsConsumed,
    bytes: a.glbBytes, assetUrl: `/demo/assets/${a.tripoTaskId}.glb`,
    finalAnswer: r.finalAnswer ?? null, finalizationRecovered: !!r.previousError,
    generationMs: r.serviceEvidence.generationMs,
    createdAt: r.serviceEvidence.tripoFinal.data.created_at,
    completedAt: r.serviceEvidence.tripoFinal.data.completed_at,
    hashscan: `https://hashscan.io/testnet/transaction/${encodeURIComponent(a.transactionId)}`,
  };
}
