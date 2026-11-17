'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';

/** Until the inbox exists (Phase 3), home is the first admin screen the user can open. */
export default function Home() {
  const { can } = useSession();
  const router = useRouter();
  useEffect(() => {
    router.replace(can('user.read') ? '/admin/users' : '/account');
  }, [can, router]);
  return null;
}
