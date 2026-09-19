-- Room scans: the phone writes RoomPlan's CapturedRoom JSON here; the headset renders it.
-- One row per room. Re-scanning overwrites the row and every open headset updates.

create table if not exists rooms (
  id         text primary key,   -- 'demo' for the hackathon
  scan       jsonb,              -- CapturedRoom exactly as Swift's JSONEncoder produced it
  updated_at timestamptz default now()
);

-- Realtime is off by default: without this the headset never hears about new scans.
alter publication supabase_realtime add table rooms;

-- Hackathon-only: open access with the anon key. Lock this down before anything real.
alter table rooms enable row level security;
create policy "open rooms" on rooms for all using (true) with check (true);
