-- =====================================================================
--  ระบบติดตาม ANT บนเสา Tower (AWN) — โครงสร้างฐานข้อมูล Supabase
--  วิธีใช้: Supabase Dashboard → SQL Editor → วางไฟล์นี้ทั้งไฟล์ → Run
--  รันซ้ำได้ (idempotent)
-- =====================================================================

-- ---------- ระดับสิทธิ์ ----------
-- pending  = สมัครแล้ว รอผู้ดูแลอนุมัติ (ยังเห็นข้อมูลไม่ได้)
-- viewer   = ดูข้อมูล / ดาวน์โหลดรายงาน
-- editor   = + บันทึกรื้อถอน/ติดตั้ง, นำเข้าไฟล์รายเดือน
-- admin    = + ปิด/เปิดเดือน, จัดการผู้ใช้, อัปโหลดข้อมูลตั้งต้น, ดูประวัติการแก้ไข
do $$ begin
  create type public.app_role as enum ('pending','viewer','editor','admin');
exception when duplicate_object then null; end $$;

-- ---------- ผู้ใช้ ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text not null default '',
  role       public.app_role not null default 'pending',
  created_at timestamptz not null default now()
);

create or replace function public.my_role() returns public.app_role
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'pending'::public.app_role)
$$;

create or replace function public.has_role(min_role public.app_role) returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() >= min_role
$$;

-- สร้างโปรไฟล์อัตโนมัติเมื่อมีผู้สมัคร — ผู้ใช้คนแรกของระบบเป็น admin
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    case when exists (select 1 from public.profiles where role = 'admin')
         then 'pending'::public.app_role else 'admin'::public.app_role end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ห้ามลด/ลบผู้ดูแลคนสุดท้าย
create or replace function public.keep_one_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'DELETE' and old.role = 'admin')
     or (tg_op = 'UPDATE' and old.role = 'admin' and new.role <> 'admin') then
    if (select count(*) from public.profiles where role = 'admin' and id <> old.id) = 0 then
      raise exception 'ต้องมีผู้ดูแล (admin) อย่างน้อย 1 คน';
    end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists profiles_keep_admin on public.profiles;
create trigger profiles_keep_admin before update or delete on public.profiles
  for each row execute function public.keep_one_admin();

-- ---------- เดือน (ปิด/เปิด) ----------
create table if not exists public.months (
  month      text primary key check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  closed     boolean not null default false,
  closed_at  timestamptz,
  closed_by  uuid references auth.users(id) on delete set null
);

-- ---------- รายการรื้อถอน/ติดตั้ง ต่อสถานีต่อเดือน ----------
-- k = LOCATION_ID|SITECODE|ARTICLE_NO|ลำดับ  (กุญแจระบุแถวเสา)
-- rm / ins = [ANT AWN, Microwave, ANT DTAC]
create table if not exists public.changes (
  month      text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  k          text not null,
  row_idx    integer,
  sc         text,
  lid        text,
  rm         integer[] not null default '{0,0,0}',
  ins        integer[] not null default '{0,0,0}',
  note       text not null default '',
  tower      boolean not null default false,   -- เสารื้อถอนแล้ว
  now_val    integer,                          -- จำนวน TOWER เช่า ณ ปัจจุบัน (ถ้าเปลี่ยน)
  st         text,                             -- สถานะ (ถ้าเปลี่ยน)
  src        text not null default 'manual',   -- manual | bulk | import
  file       text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (month, k),
  constraint rm_shape  check (array_length(rm, 1) = 3 and 0 <= all(rm)),
  constraint ins_shape check (array_length(ins, 1) = 3 and 0 <= all(ins))
);
create index if not exists changes_month_idx on public.changes(month);

-- ห้ามแก้รายการของเดือนที่ปิดแล้ว + บันทึกผู้แก้ไข
create or replace function public.guard_changes() returns trigger
language plpgsql security definer set search_path = public as $$
declare m text := coalesce(new.month, old.month);
begin
  if exists (select 1 from public.months where month = m and closed) then
    raise exception 'เดือน % ปิดแล้ว — ให้ผู้ดูแลเปิดเดือนก่อนแก้ไข', m;
  end if;
  if tg_op = 'UPDATE' and new.month <> old.month then
    if exists (select 1 from public.months where month = old.month and closed) then
      raise exception 'เดือน % ปิดแล้ว', old.month;
    end if;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    new.updated_by := auth.uid();
    new.updated_at := now();
    if tg_op = 'INSERT' then new.created_by := coalesce(auth.uid(), new.created_by); end if;
    if tg_op = 'UPDATE' then new.created_by := old.created_by; end if;
    return new;
  end if;
  return old;
end $$;
drop trigger if exists changes_guard on public.changes;
create trigger changes_guard before insert or update or delete on public.changes
  for each row execute function public.guard_changes();

-- ---------- สถานีที่เพิ่มใหม่ (จากไฟล์รายเดือน) ----------
create table if not exists public.extra_sites (
  k          text primary key,
  from_month text not null check (from_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  data       jsonb not null,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------- ประวัติการแก้ไข (ผู้ดูแลดูได้) ----------
create table if not exists public.audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  tbl        text not null,
  action     text not null,
  old_row    jsonb,
  new_row    jsonb
);
create index if not exists audit_log_at_idx on public.audit_log(at desc);

create or replace function public.write_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (user_id, tbl, action, old_row, new_row)
  values (auth.uid(), tg_table_name, tg_op,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

drop trigger if exists audit_changes on public.changes;
create trigger audit_changes after insert or update or delete on public.changes
  for each row execute function public.write_audit();
drop trigger if exists audit_months on public.months;
create trigger audit_months after insert or update or delete on public.months
  for each row execute function public.write_audit();
drop trigger if exists audit_extra on public.extra_sites;
create trigger audit_extra after insert or update or delete on public.extra_sites
  for each row execute function public.write_audit();
drop trigger if exists audit_profiles on public.profiles;
create trigger audit_profiles after update on public.profiles
  for each row execute function public.write_audit();

-- ---------- Row Level Security ----------
alter table public.profiles    enable row level security;
alter table public.months      enable row level security;
alter table public.changes     enable row level security;
alter table public.extra_sites enable row level security;
alter table public.audit_log   enable row level security;

revoke all on public.profiles, public.months, public.changes, public.extra_sites, public.audit_log from anon;
grant select, update            on public.profiles    to authenticated;
grant select, insert, update, delete on public.months, public.changes, public.extra_sites to authenticated;
grant select                    on public.audit_log   to authenticated;
grant execute on function public.my_role(), public.has_role(public.app_role) to authenticated;

drop policy if exists profiles_read  on public.profiles;
drop policy if exists profiles_admin on public.profiles;
create policy profiles_read  on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_role('viewer'));
create policy profiles_admin on public.profiles for update to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));
-- ผู้ใช้แก้ชื่อตัวเองได้ผ่านฟังก์ชันนี้ (แก้ role ตัวเองไม่ได้)
create or replace function public.set_my_name(new_name text) returns void
language sql security definer set search_path = public as $$
  update public.profiles set full_name = left(coalesce(new_name,''), 120) where id = auth.uid();
$$;
grant execute on function public.set_my_name(text) to authenticated;

do $$ declare t text; begin
  foreach t in array array['months','changes','extra_sites'] loop
    execute format('drop policy if exists %1$s_read on public.%1$s', t);
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using (public.has_role(''viewer''))', t);
  end loop;
end $$;

drop policy if exists months_write on public.months;
create policy months_write on public.months for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

drop policy if exists changes_write on public.changes;
create policy changes_write on public.changes for all to authenticated
  using (public.has_role('editor')) with check (public.has_role('editor'));

drop policy if exists extra_write on public.extra_sites;
create policy extra_write on public.extra_sites for all to authenticated
  using (public.has_role('editor')) with check (public.has_role('editor'));

drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select to authenticated
  using (public.has_role('admin'));

-- ---------- ไฟล์ข้อมูลตั้งต้น (Storage, ไม่เปิดสาธารณะ) ----------
insert into storage.buckets (id, name, public)
values ('baseline', 'baseline', false)
on conflict (id) do nothing;

drop policy if exists baseline_read   on storage.objects;
drop policy if exists baseline_insert on storage.objects;
drop policy if exists baseline_update on storage.objects;
drop policy if exists baseline_delete on storage.objects;
create policy baseline_read   on storage.objects for select to authenticated
  using (bucket_id = 'baseline' and public.has_role('viewer'));
create policy baseline_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'baseline' and public.has_role('admin'));
create policy baseline_update on storage.objects for update to authenticated
  using (bucket_id = 'baseline' and public.has_role('admin'));
create policy baseline_delete on storage.objects for delete to authenticated
  using (bucket_id = 'baseline' and public.has_role('admin'));

-- ---------- Realtime (อัปเดตหน้าจอทุกเครื่องทันที) ----------
do $$ declare t text; begin
  foreach t in array array['changes','months','extra_sites','profiles'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; when undefined_object then null;
    end;
  end loop;
end $$;
