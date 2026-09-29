/** Cost evidence is accounting data, not a claim about savings or output quality. */
export interface CostSession {
  id: string;
  lastActivity?: number;
  cost?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  outcome?: string;
  status?: string;
  turns?: number;
  instructionsSent?: number;
  orchestratorChars?: number;
}

export interface OrchestratorCostRecord {
  id: string;
  amount: number;
  currency: string;
  source: "manual" | "estimate" | "provider";
  reference: string;
  session_ids: string[];
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value;
}

function validAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Validate at the registration/persistence boundary as well as when reading evidence. */
export function validateCostRecord(value: unknown): OrchestratorCostRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cost record must be an object");
  const record = value as Record<string, unknown>;
  const id = nonempty(record.id, "id");
  if (!validAmount(record.amount)) throw new Error("amount must be finite and nonnegative");
  const currency = nonempty(record.currency, "currency").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter currency code");
  if (record.source !== "manual" && record.source !== "estimate" && record.source !== "provider") {
    throw new Error("source must be manual, estimate, or provider");
  }
  const reference = nonempty(record.reference, "reference");
  if (!Array.isArray(record.session_ids) || record.session_ids.length === 0) throw new Error("session_ids must be a nonempty array");
  const session_ids = record.session_ids.map((entry) => nonempty(entry, "session_ids entry"));
  if (new Set(session_ids).size !== session_ids.length) throw new Error("session_ids must be unique");
  return { id, amount: record.amount, currency, source: record.source, reference, session_ids };
}

function latestById(sessions: readonly CostSession[]): Map<string, CostSession> {
  const result = new Map<string, CostSession>();
  for (const session of sessions) {
    const previous = result.get(session.id);
    if (!previous || (session.lastActivity ?? 0) >= (previous.lastActivity ?? 0)) result.set(session.id, session);
  }
  return result;
}

export interface CostEvidenceInput {
  active: readonly CostSession[];
  history: readonly CostSession[];
  orchestrator_records?: readonly OrchestratorCostRecord[];
  session_ids?: readonly string[];
  worker_currency?: string;
}

/** Pure aggregation over all outcomes and archived sessions; active snapshots win. */
export function summarizeCostEvidence(input: CostEvidenceInput) {
  const byId = latestById(input.history);
  for (const [id, session] of latestById(input.active)) byId.set(id, session);
  const selectedIds = input.session_ids === undefined ? [...byId.keys()] : [...new Set(input.session_ids)];
  const selectedSet = new Set(selectedIds);
  const unknown_session_ids = selectedIds.filter((id) => !byId.has(id));
  const sessions = selectedIds.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  const workerCurrency = nonempty(input.worker_currency ?? "USD", "worker_currency").trim().toUpperCase();
  const missingWorkerIds = sessions.filter((session) => !validAmount(session.cost)).map((session) => session.id);
  const workerSubtotal = sessions.reduce((sum, session) => sum + (validAmount(session.cost) ? session.cost : 0), 0);
  if (!Number.isFinite(workerSubtotal)) throw new Error("Worker cost total exceeds the finite numeric range");
  const workerComplete = missingWorkerIds.length === 0 && unknown_session_ids.length === 0;

  const records: OrchestratorCostRecord[] = [];
  const excludedRecordIds: string[] = [];
  const byRecordId = new Map<string, OrchestratorCostRecord>();
  for (const raw of input.orchestrator_records ?? []) {
    const record = validateCostRecord(raw);
    const previous = byRecordId.get(record.id);
    if (previous) {
      const signature = (r: OrchestratorCostRecord) => JSON.stringify({ ...r, session_ids: [...r.session_ids].sort() });
      if (signature(previous) !== signature(record)) throw new Error(`Conflicting cost record id: ${record.id}`);
      continue;
    }
    byRecordId.set(record.id, record);
    if (!record.session_ids.some((id) => selectedSet.has(id))) continue;
    // An amount spanning a larger scope cannot be apportioned without additional evidence.
    if (!record.session_ids.every((id) => selectedSet.has(id))) excludedRecordIds.push(record.id);
    else records.push(record);
  }
  const covered = new Set(records.flatMap((record) => record.session_ids));
  const missingOrchestratorIds = selectedIds.filter((id) => !covered.has(id));
  const currencyTotals: Record<string, number> = Object.create(null);
  for (const record of records) currencyTotals[record.currency] = (currencyTotals[record.currency] ?? 0) + record.amount;
  if (Object.values(currencyTotals).some((amount) => !Number.isFinite(amount))) throw new Error("Orchestrator cost total exceeds the finite numeric range");
  const currencies = Object.keys(currencyTotals);
  const orchestratorCurrency = currencies.length === 1 ? currencies[0] : currencies.length === 0 && selectedIds.length === 0 ? workerCurrency : null;
  const orchestratorComplete = missingOrchestratorIds.length === 0 && unknown_session_ids.length === 0 && excludedRecordIds.length === 0 && currencies.length <= 1;
  const orchestratorTotal = orchestratorComplete ? orchestratorCurrency ? currencyTotals[orchestratorCurrency] ?? 0 : null : null;
  const reasons: string[] = [];
  if (!workerComplete) reasons.push("Worker cost is unknown for one or more selected sessions.");
  if (missingOrchestratorIds.length) reasons.push("Orchestrator cost records do not cover every selected session.");
  if (unknown_session_ids.length) reasons.push("Requested session ids are absent from active and archived history.");
  if (excludedRecordIds.length) reasons.push("Some orchestrator records span sessions outside the selected scope and cannot be apportioned.");
  if (currencies.length > 1 || (orchestratorCurrency !== null && orchestratorCurrency !== workerCurrency)) reasons.push("Currencies differ; no exchange rate or conversion is assumed.");
  const combinedComplete = workerComplete && orchestratorComplete && orchestratorCurrency === workerCurrency;
  const combinedTotal = combinedComplete ? workerSubtotal + (orchestratorTotal ?? 0) : null;
  if (combinedTotal !== null && !Number.isFinite(combinedTotal)) throw new Error("Combined cost total exceeds the finite numeric range");
  const tokenFields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
  const tokenActivity = Object.fromEntries(tokenFields.map((field) => {
    const missing_session_ids = sessions.filter((session) => !validAmount(session.tokens?.[field])).map((session) => session.id);
    const known_subtotal = sessions.reduce((sum, session) => sum + (validAmount(session.tokens?.[field]) ? session.tokens![field]! : 0), 0);
    return [field, { known_subtotal, complete: missing_session_ids.length === 0 && unknown_session_ids.length === 0, missing_session_ids }];
  }));
  return {
    selected_session_ids: selectedIds,
    unknown_session_ids,
    sessions: sessions.map((session) => ({ ...session, cost: validAmount(session.cost) ? session.cost : null })),
    worker: { currency: workerCurrency, total: workerComplete ? workerSubtotal : null, known_subtotal: workerSubtotal, complete: workerComplete, missing_session_ids: missingWorkerIds },
    orchestrator: { currency: orchestratorCurrency, total: orchestratorTotal, known_subtotals: { ...currencyTotals }, complete: orchestratorComplete, missing_session_ids: missingOrchestratorIds, excluded_record_ids: excludedRecordIds, sources: [...new Set(records.map((record) => record.source))], records },
    combined: { currency: combinedComplete ? workerCurrency : null, total: combinedTotal, complete: combinedComplete, reasons },
    activity: { tokens: tokenActivity },
    note: "Costs include all selected worker outcomes and archived sessions. Manual, estimated and provider records retain their provenance. Coverage proves only which sessions records describe, not that every orchestrator turn was recorded. Token activity and partial cost evidence do not establish savings.",
  };
}
