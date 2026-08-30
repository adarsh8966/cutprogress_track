/**
 * "Today", as a redirect to the day view (spec §40).
 *
 * The day view is the cockpit: it already shows what a day resolves to and
 * every record behind it, for ANY date. What it could not be was a fixed
 * destination, because today is a different URL every day and only the server
 * knows which - the date depends on the profile's timezone, never on the
 * browser's clock or on UTC.
 *
 * So this route resolves it and forwards. It keeps /day/[date] as the single
 * implementation, and gives the navigation something stable to point at.
 */
import { redirect } from 'next/navigation';
import { todayForUser } from '@/app/actions/log';

export const dynamic = 'force-dynamic';

export default async function TodayPage() {
  redirect(`/day/${await todayForUser()}`);
}
