-- Run this once in Supabase → SQL Editor.

create table if not exists settings (
  id   int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb
);
insert into settings (id) values (1) on conflict do nothing;

create table if not exists items (
  id              uuid primary key default gen_random_uuid(),
  week_key        date not null,                 -- first day of the week the file belongs to
  kind            text not null check (kind in ('image','video')),
  title           text not null default '',
  description     text not null default '',
  uploader        text not null default '',
  original_name   text,
  original_path   text,                          -- images: untouched upload (bucket "originals")
  media_path      text not null,                 -- what the screen plays (bucket "media")
  src_w           int,
  src_h           int,
  full_frame      boolean,                       -- true = already exactly 1920x1080
  duration        real,
  hidden          boolean not null default false,
  custom_duration int,
  sort_order      bigint not null default 0,
  version         bigint not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists items_week_idx on items (week_key);

-- Only the server (service-role key) touches these tables. No public policies = no public access.
alter table settings enable row level security;
alter table items    enable row level security;

-- "media" is public (the screen plays from it); "originals" is private.
insert into storage.buckets (id, name, public) values ('media', 'media', true)
  on conflict (id) do update set public = true;
insert into storage.buckets (id, name, public) values ('originals', 'originals', false)
  on conflict (id) do nothing;
