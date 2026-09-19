import { createClient } from '@supabase/supabase-js';

export const ROOM_ID: string = import.meta.env.VITE_ROOM_ID ?? 'demo';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabase = url && key ? createClient(url, key) : null;

type Scan = Record<string, unknown>;

/**
 * Calls onScan with the current room scan, and again whenever the phone uploads a new one.
 * Scans can be large and big Realtime payloads may arrive trimmed, so the change event is
 * only a signal: the row itself is always fetched. Every (re)subscribe fetches too, so a
 * dropped connection catches up on its own.
 */
export function watchRoomScan(onScan: (scan: Scan) => void, onStatus: (status: string) => void) {
  if (!supabase) {
    onStatus('NOT_CONFIGURED');
    return;
  }
  const client = supabase;

  async function fetchScan() {
    const { data, error } = await client.from('rooms').select('scan').eq('id', ROOM_ID).maybeSingle();
    if (error) return console.error('Loading the room scan failed:', error.message);
    if (data?.scan) onScan(data.scan as Scan);
  }

  client
    .channel(`rooms:${ROOM_ID}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${ROOM_ID}` }, () => {
      void fetchScan();
    })
    .subscribe((status) => {
      onStatus(status);
      if (status === 'SUBSCRIBED') void fetchScan();
    });
}

/** Stores a scan in `rooms` so every open headset picks it up. */
export async function uploadRoomScan(scan: Scan) {
  if (!supabase) throw new Error('Supabase isn’t configured. Copy .env.example to .env and fill it in.');
  const { error } = await supabase
    .from('rooms')
    .upsert({ id: ROOM_ID, scan, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}
