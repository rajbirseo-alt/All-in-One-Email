import { AppShell } from '@/components/app-shell';
import { LiveEventsProvider } from '@/lib/live';
import { SessionProvider } from '@/lib/session';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <LiveEventsProvider>
        <AppShell>{children}</AppShell>
      </LiveEventsProvider>
    </SessionProvider>
  );
}
