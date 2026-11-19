export const LEAD_STATUS_LABEL: Record<string, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  FOLLOW_UP: 'Follow-up',
  INTERESTED: 'Interested',
  PROPOSAL_SENT: 'Proposal sent',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
};
export const LEAD_STATUS_ORDER = ['NEW', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'PROPOSAL_SENT', 'NEGOTIATION', 'WON', 'LOST'];
export const LEAD_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  NEW: 'accent',
  CONTACTED: 'neutral',
  FOLLOW_UP: 'warning',
  INTERESTED: 'accent',
  PROPOSAL_SENT: 'accent',
  NEGOTIATION: 'warning',
  WON: 'success',
  LOST: 'danger',
};

export const CONTACT_TYPE_LABEL: Record<string, string> = {
  CLIENT: 'Client',
  PROSPECT: 'Prospect',
  VENDOR: 'Vendor',
  PARTNER: 'Partner',
  CANDIDATE: 'Candidate',
  OTHER: 'Other',
};

export function money(value: string | null, currency: string | null) {
  if (value === null) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency ?? 'USD', maximumFractionDigits: 0 }).format(Number(value));
  } catch {
    return `${currency ?? ''} ${value}`.trim();
  }
}

/** A datetime-local input value (local time, minutes) for a Date. */
export const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export const dueText = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
