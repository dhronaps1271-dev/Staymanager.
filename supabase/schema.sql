-- StayManager database schema
-- Run this entire file in the Supabase SQL Editor for a NEW project.
-- Never put a Supabase service_role key in the browser/frontend.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text not null default 'admin' check (role in ('admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.residents (
  id uuid primary key default gen_random_uuid(),
  resident_no integer not null unique check (resident_no between 1 and 100),
  full_name text,
  contact_number text,
  room_number text,
  bed_number text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.resident_fee_schedule (
  id uuid primary key default gen_random_uuid(),
  resident_id uuid not null references public.residents(id) on delete restrict,
  category text not null check (category in ('working', 'staying', 'custom')),
  monthly_fee numeric(10,2) not null check (monthly_fee >= 0),
  effective_month date not null check (extract(day from effective_month) = 1),
  created_at timestamptz not null default now(),
  unique (resident_id, effective_month)
);

create table if not exists public.monthly_charges (
  resident_id uuid not null references public.residents(id) on delete restrict,
  billing_month date not null check (extract(day from billing_month) = 1),
  category text not null check (category in ('working', 'staying', 'custom')),
  monthly_fee numeric(10,2) not null check (monthly_fee >= 0),
  due_date date not null,
  created_at timestamptz not null default now(),
  primary key (resident_id, billing_month)
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  resident_id uuid not null,
  billing_month date not null,
  amount numeric(10,2) not null check (amount > 0),
  payment_date date not null default current_date,
  note text,
  created_at timestamptz not null default now(),
  constraint payments_charge_fk foreign key (resident_id, billing_month)
    references public.monthly_charges(resident_id, billing_month) on delete restrict
);

create index if not exists residents_name_idx on public.residents using gin (to_tsvector('simple', coalesce(full_name, '')));
create index if not exists payments_billing_month_idx on public.payments (billing_month);
create index if not exists payments_payment_date_idx on public.payments (payment_date);
create index if not exists fee_schedule_lookup_idx on public.resident_fee_schedule (resident_id, effective_month desc);

-- The application has a fixed set of permanent numbered slots. Empty slots have a NULL name.
insert into public.residents (resident_no)
select n from generate_series(1, 100) as n
on conflict (resident_no) do nothing;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists residents_set_updated_at on public.residents;
create trigger residents_set_updated_at
before update on public.residents
for each row execute function public.set_updated_at();

-- SECURITY DEFINER avoids recursive RLS checks when policies verify an administrator.
create or replace function public.is_staymanager_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'admin'
  );
$$;
revoke all on function public.is_staymanager_admin() from public;
grant execute on function public.is_staymanager_admin() to authenticated;

-- Create a resident in an existing empty slot and add their first fee schedule atomically.
create or replace function public.create_staymanager_resident(
  p_resident_no integer,
  p_full_name text,
  p_contact_number text default null,
  p_room_number text default null,
  p_bed_number text default null,
  p_notes text default null,
  p_category text default 'staying',
  p_monthly_fee numeric default 180
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_month date := date_trunc('month', current_date)::date;
begin
  if not public.is_staymanager_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_resident_no < 1 or p_resident_no > 100 then
    raise exception 'Resident number must be between 1 and 100';
  end if;
  if nullif(trim(p_full_name), '') is null then
    raise exception 'Resident name is required';
  end if;
  if p_category is null or p_category not in ('working', 'staying', 'custom') then
    raise exception 'Invalid resident category';
  end if;
  if p_monthly_fee is null or p_monthly_fee < 0 then
    raise exception 'Monthly fee must be zero or greater';
  end if;
  if p_category = 'working' and p_monthly_fee <> 70 then
    raise exception 'Working residents have a monthly fee of €70';
  end if;
  if p_category = 'staying' and p_monthly_fee <> 180 then
    raise exception 'Staying residents have a monthly fee of €180';
  end if;

  update public.residents
  set full_name = trim(p_full_name),
      contact_number = nullif(trim(p_contact_number), ''),
      room_number = nullif(trim(p_room_number), ''),
      bed_number = nullif(trim(p_bed_number), ''),
      notes = nullif(trim(p_notes), '')
  where resident_no = p_resident_no and full_name is null
  returning id into v_id;

  if v_id is null then
    raise exception 'This resident slot is already occupied or does not exist';
  end if;

  insert into public.resident_fee_schedule (resident_id, category, monthly_fee, effective_month)
  values (v_id, p_category, p_monthly_fee, v_month);
  return v_id;
end;
$$;

-- Category/fee edits are deliberately scheduled for the first day of next month.
-- Already-created future charge snapshots are updated only when no payment exists for them.
create or replace function public.schedule_staymanager_fee_change(
  p_resident_id uuid,
  p_category text,
  p_monthly_fee numeric,
  p_effective_month date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_month date := (date_trunc('month', current_date) + interval '1 month')::date;
begin
  if not public.is_staymanager_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_category is null or p_category not in ('working', 'staying', 'custom') then
    raise exception 'Invalid resident category';
  end if;
  if p_monthly_fee is null or p_monthly_fee < 0 then
    raise exception 'Monthly fee must be zero or greater';
  end if;
  if p_category = 'working' and p_monthly_fee <> 70 then
    raise exception 'Working residents have a monthly fee of €70';
  end if;
  if p_category = 'staying' and p_monthly_fee <> 180 then
    raise exception 'Staying residents have a monthly fee of €180';
  end if;
  if p_effective_month is null or p_effective_month <> date_trunc('month', p_effective_month)::date or p_effective_month < v_next_month then
    raise exception 'A category or fee change must start from the first day of next month or later';
  end if;
  if not exists (select 1 from public.residents where id = p_resident_id and full_name is not null) then
    raise exception 'Resident not found';
  end if;

  insert into public.resident_fee_schedule (resident_id, category, monthly_fee, effective_month)
  values (p_resident_id, p_category, p_monthly_fee, p_effective_month)
  on conflict (resident_id, effective_month)
  do update set category = excluded.category, monthly_fee = excluded.monthly_fee;

  update public.monthly_charges mc
  set (category, monthly_fee) = (
    select s.category, s.monthly_fee
    from public.resident_fee_schedule s
    where s.resident_id = mc.resident_id and s.effective_month <= mc.billing_month
    order by s.effective_month desc
    limit 1
  )
  where mc.resident_id = p_resident_id
    and mc.billing_month >= p_effective_month
    and not exists (
      select 1 from public.payments p
      where p.resident_id = mc.resident_id and p.billing_month = mc.billing_month
    );
end;
$$;

-- Create immutable month-specific charge snapshots from the applicable fee schedule.
create or replace function public.generate_staymanager_month(p_month date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_count integer := 0;
begin
  if not public.is_staymanager_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_month is null then
    raise exception 'A billing month is required';
  end if;

  insert into public.monthly_charges (resident_id, billing_month, category, monthly_fee, due_date)
  select r.id, v_month, fs.category, fs.monthly_fee,
         (v_month + interval '1 month - 1 day')::date
  from public.residents r
  join lateral (
    select s.category, s.monthly_fee
    from public.resident_fee_schedule s
    where s.resident_id = r.id and s.effective_month <= v_month
    order by s.effective_month desc
    limit 1
  ) fs on true
  where nullif(trim(r.full_name), '') is not null
  on conflict (resident_id, billing_month) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.create_staymanager_resident(integer, text, text, text, text, text, text, numeric) from public;
revoke all on function public.schedule_staymanager_fee_change(uuid, text, numeric, date) from public;
revoke all on function public.generate_staymanager_month(date) from public;
grant execute on function public.create_staymanager_resident(integer, text, text, text, text, text, text, numeric) to authenticated;
grant execute on function public.schedule_staymanager_fee_change(uuid, text, numeric, date) to authenticated;
grant execute on function public.generate_staymanager_month(date) to authenticated;

-- Enable row-level security on every table containing business or personal data.
alter table public.profiles enable row level security;
alter table public.residents enable row level security;
alter table public.resident_fee_schedule enable row level security;
alter table public.monthly_charges enable row level security;
alter table public.payments enable row level security;

drop policy if exists "profile owner or admin can read" on public.profiles;
create policy "profile owner or admin can read" on public.profiles
for select to authenticated using (user_id = auth.uid() or public.is_staymanager_admin());

drop policy if exists "admins can manage profiles" on public.profiles;
create policy "admins can manage profiles" on public.profiles
for all to authenticated using (public.is_staymanager_admin()) with check (public.is_staymanager_admin());

drop policy if exists "admins can read residents" on public.residents;
create policy "admins can read residents" on public.residents
for select to authenticated using (public.is_staymanager_admin());
drop policy if exists "admins can update residents" on public.residents;
create policy "admins can update residents" on public.residents
for update to authenticated using (public.is_staymanager_admin()) with check (public.is_staymanager_admin());

-- Inserts are performed by the create_staymanager_resident security-definer RPC.
drop policy if exists "admins can read fee schedule" on public.resident_fee_schedule;
create policy "admins can read fee schedule" on public.resident_fee_schedule
for select to authenticated using (public.is_staymanager_admin());

drop policy if exists "admins can read monthly charges" on public.monthly_charges;
create policy "admins can read monthly charges" on public.monthly_charges
for select to authenticated using (public.is_staymanager_admin());

drop policy if exists "admins can read payments" on public.payments;
create policy "admins can read payments" on public.payments
for select to authenticated using (public.is_staymanager_admin());
drop policy if exists "admins can record payments" on public.payments;
create policy "admins can record payments" on public.payments
for insert to authenticated with check (public.is_staymanager_admin());

-- Grant only the table privileges required by the frontend. RLS remains the enforcement layer.
grant select on public.profiles, public.residents, public.resident_fee_schedule, public.monthly_charges, public.payments to authenticated;
grant update (full_name, contact_number, room_number, bed_number, notes) on public.residents to authenticated;
grant insert on public.payments to authenticated;
