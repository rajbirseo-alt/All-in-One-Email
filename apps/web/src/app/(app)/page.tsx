'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';

/** Home: the inbox for anyone who reads mail, otherwise the first admin screen they can open. */
export default function Home() {
  const { can } = useSession();
  const router = useRouter();
  useEffect(() => {
    router.replace(can('conversation.read') ? '/inbox' : can('user.read') ? '/admin/users' : '/account');
  }, [can, router]);
  return null;
}
