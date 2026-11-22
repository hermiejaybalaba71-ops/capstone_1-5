-- ============================================================================
-- registrar-approve-policy.sql
--
-- Schema + Row Level Security for the SIMULATED Registrar Information System.
--
-- Run this in the Supabase SQL Editor of the project the app points at:
--   1. the dedicated registrar project (NEXT_PUBLIC_REGISTRAR_SUPABASE_URL)
--      when it is reachable, otherwise
--   2. the MAIN project (NEXT_PUBLIC_SUPABASE_URL) -- the app falls back here
--      automatically via resolveRegistrarClient() / queryRegistrar().
--
-- Who writes these tables:
--   src/app/api/admin/approve-student/route.ts
--     -> registrar_students (lookup / insert / update)
--     -> registrar_enrollment (insert)
--     -> registrar_student_subjects (insert / read back for GPA)
--   src/app/api/faculty/scan-alerts/route.ts
--     -> registrar_students + registrar_student_subjects (read for early-warning)
--   src/app/admin/approvals/page.tsx, register / student pages (read)
--
-- The app talks to PostgREST with the ANON key, so the policies below grant
-- anon SELECT/INSERT/UPDATE/DELETE. This is a SIMULATED registrar used only
-- for the capstone demo - it holds no real student data.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. registrar_students  (the student identity record)
--    Written by approve-student: one row per approved account.
-- ---------------------------------------------------------------------------
create table if not exists public.registrar_students (
  student_id        bigint generated always as identity primary key,
  student_number    text        not null,
  last_name         text,
  given_name        text,
  middle_name       text,
  ext_name          text,
  sex               text,
  birthdate         date,
  program_name      text,
  year_level        text,
  registration_status text      not null default 'Enrolled',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- approve-student looks the student up by student_number before inserting.
create unique index if not exists registrar_students_student_number_uidx
  on public.registrar_students (student_number);

create index if not exists registrar_students_status_idx
  on public.registrar_students (registration_status);

comment on table public.registrar_students is
  'SIMULATED Registrar Information System - student identity used to verify enrolment.';


-- ---------------------------------------------------------------------------
-- 2. registrar_enrollment  (the enrolment row for the current term)
--    Written by approve-student right after the student row exists.
-- ---------------------------------------------------------------------------
create table if not exists public.registrar_enrollment (
  enrollment_id     bigint generated always as identity primary key,
  student_id        bigint      not null
                            references public.registrar_students (student_id)
                            on delete cascade,
  academic_year     text        not null,
  semester          text        not null,
  enrollment_status text        not null default 'Enrolled',
  created_at        timestamptz not null default now()
);

create index if not exists registrar_enrollment_student_idx
  on public.registrar_enrollment (student_id);

create index if not exists registrar_enrollment_status_idx
  on public.registrar_enrollment (enrollment_status);

comment on table public.registrar_enrollment is
  'SIMULATED Registrar Information System - enrolment per academic year/semester.';


-- ---------------------------------------------------------------------------
-- 3. registrar_student_subjects  (subjects + GRADES + units -> GPA)
--    Written by approve-student: 8 subjects per year level, deterministic
--    grades seeded from the student number, ~30% at-risk so the early-warning
--    scan (faculty/scan-alerts) has real data.
-- ---------------------------------------------------------------------------
create table if not exists public.registrar_student_subjects (
  id             bigint generated always as identity primary key,
  student_id     bigint      not null
                         references public.registrar_students (student_id)
                         on delete cascade,
  subject_code   text        not null,
  subject_name   text,
  grade          numeric(4,2),
  units          numeric(4,1) not null default 3,
  created_at     timestamptz not null default now()
);

create index if not exists registrar_student_subjects_student_idx
  on public.registrar_student_subjects (student_id);

comment on table public.registrar_student_subjects is
  'SIMULATED Registrar Information System - subjects, grades and units used to compute GPA and the 93% maintaining-grade early warning.';


-- ---------------------------------------------------------------------------
-- 4. Row Level Security
--    The frontend and the API routes use the ANON key, so anon needs full
--    access to these three simulated tables. Real student data lives in the
--    MAIN project's own tables, which keep their own (stricter) policies.
-- ---------------------------------------------------------------------------
alter table public.registrar_students         enable row level security;
alter table public.registrar_enrollment       enable row level security;
alter table public.registrar_student_subjects enable row level security;

-- registrar_students
drop policy if exists "anon select registrar_students" on public.registrar_students;
create policy "anon select registrar_students"
  on public.registrar_students for select to anon using (true);

drop policy if exists "anon insert registrar_students" on public.registrar_students;
create policy "anon insert registrar_students"
  on public.registrar_students for insert to anon with check (true);

drop policy if exists "anon update registrar_students" on public.registrar_students;
create policy "anon update registrar_students"
  on public.registrar_students for update to anon using (true) with check (true);

drop policy if exists "anon delete registrar_students" on public.registrar_students;
create policy "anon delete registrar_students"
  on public.registrar_students for delete to anon using (true);

-- registrar_enrollment
drop policy if exists "anon select registrar_enrollment" on public.registrar_enrollment;
create policy "anon select registrar_enrollment"
  on public.registrar_enrollment for select to anon using (true);

drop policy if exists "anon insert registrar_enrollment" on public.registrar_enrollment;
create policy "anon insert registrar_enrollment"
  on public.registrar_enrollment for insert to anon with check (true);

drop policy if exists "anon update registrar_enrollment" on public.registrar_enrollment;
create policy "anon update registrar_enrollment"
  on public.registrar_enrollment for update to anon using (true) with check (true);

drop policy if exists "anon delete registrar_enrollment" on public.registrar_enrollment;
create policy "anon delete registrar_enrollment"
  on public.registrar_enrollment for delete to anon using (true);

-- registrar_student_subjects
drop policy if exists "anon select registrar_student_subjects" on public.registrar_student_subjects;
create policy "anon select registrar_student_subjects"
  on public.registrar_student_subjects for select to anon using (true);

drop policy if exists "anon insert registrar_student_subjects" on public.registrar_student_subjects;
create policy "anon insert registrar_student_subjects"
  on public.registrar_student_subjects for insert to anon with check (true);

drop policy if exists "anon update registrar_student_subjects" on public.registrar_student_subjects;
create policy "anon update registrar_student_subjects"
  on public.registrar_student_subjects for update to anon using (true) with check (true);

drop policy if exists "anon delete registrar_student_subjects" on public.registrar_student_subjects;
create policy "anon delete registrar_student_subjects"
  on public.registrar_student_subjects for delete to anon using (true);

-- ---------------------------------------------------------------------------
-- 5. Same grants for the service-role key (used server-side).
--    Service role bypasses RLS, so nothing to add here - this comment exists
--    so the next reader does not go looking for it.
-- ---------------------------------------------------------------------------

-- Done.
-- Verify in the SQL Editor:
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name like 'registrar_%';
-- Expected: registrar_enrollment, registrar_student_subjects, registrar_students
