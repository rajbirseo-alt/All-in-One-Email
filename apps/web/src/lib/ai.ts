'use client';

import { useEffect, useState } from 'react';
import type { AiStatus } from '@crm/shared';
import { api } from './api';

let cached: Promise<AiStatus> | null = null;

/** Whether AI is set up on the server (loaded once per page). */
export function useAiStatus(): AiStatus | null {
  const [s, setS] = useState<AiStatus | null>(null);
  useEffect(() => {
    cached ??= api<AiStatus>('/ai/status').catch(() => ({ enabled: false, model: null, autoAnalyze: false }));
    let live = true;
    void cached.then((v) => live && setS(v));
    return () => {
      live = false;
    };
  }, []);
  return s;
}

export const AI_TONE_LABEL: Record<string, string> = {
  professional: 'Professional',
  friendly: 'Friendly',
  concise: 'Short and clear',
  formal: 'Formal',
  apologetic: 'Apologetic',
};

export const CATEGORY_LABEL: Record<string, string> = {
  SALES_ENQUIRY: 'Sales enquiry',
  EXISTING_CLIENT: 'Existing client',
  SUPPORT: 'Support',
  BILLING: 'Billing',
  PARTNERSHIP: 'Partnership',
  JOB_APPLICATION: 'Job application',
  VENDOR: 'Vendor',
  NEWSLETTER: 'Newsletter',
  SPAM: 'Spam',
  OTHER: 'Other',
};
