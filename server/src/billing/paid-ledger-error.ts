export class PaidLedgerError extends Error {
  constructor(
    readonly code:
      | "product_unavailable"
      | "order_conflict"
      | "order_unknown"
      | "verification_mismatch"
      | "not_verified"
      | "refund_held"
      | "subscription_slot_taken"
      | "account_suspended"
      | "pilot_closed"
      | "no_paid_path"
      | "channel_unavailable"
      | "ledger_restoring"
      | "not_restoring"
      | "correction_conflict",
    message: string,
  ) {
    super(message);
    this.name = "PaidLedgerError";
  }
}
