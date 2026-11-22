-- ============================================================================
-- registrar-manual-insert.sql
--
-- Manual INSERT scripts for the SIMULATED Registrar Information System.
-- Run these in the SQL Editor of the REGISTRAR Supabase project only
-- (project ref zcnqxuydwagecdvitdva - "simulated registrar information
-- system"). Never run them against the MAIN project: the registrar_* tables
-- do not exist there.
--
-- The simulated registrar has five tables:
--
--   1. registrar_students          student information (identity)
--   2. registrar_enrollment        enrolment for an academic year / semester
--   3. registrar_student_subjects  one row per subject + its grade + units
--   4. registrar_student_gpa       ONE rolled-up row per student: the overall
--                                  GPA of every subject. The 93% early-warning
--                                  alert reads THIS table.
--   5. registrar_grades            legacy duplicate of #3 - not used by the
--                                  app. Do not insert into it.
--
-- The GPA formula (Philippine 1.00 - 5.00 scale):
--
--   gpa        = sum(grade * units) / sum(units)
--   percentage = ((5 - gpa) / 4) * 100
--   at_risk    = percentage < 93     <-- feeds the early-warning alert
--
-- Every script below is transactional and computes the overall GPA from the
-- subjects you supply, so you never have to calculate it by hand.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- OPTION 1 - COMPLETE NEW STUDENT
--            student information + enrollment + 8 subjects + overall GPA
--            (this is what the Admin "Approve" button writes automatically)
--
-- Just edit the values inside the two  ...  blocks and run the whole thing.
-- ---------------------------------------------------------------------------

begin;

with ins_student as (
  insert into public.registrar_students
    (student_number, last_name, given_name, middle_name, ext_name,
     sex, birthdate, program_name, year_level, registration_status)
  values
    ( '2026-00001'                                        -- student_number
    , 'Dela Cruz'                                         -- last_name   (NOT NULL)
    , 'Juan'                                              -- given_name  (NOT NULL)
    , 'Santos'                                            -- middle_name
    , null                                                -- ext_name    (Jr / Sr / III)
    , 'Male'                                              -- sex
    , date '2003-05-15'                                   -- birthdate
    , 'Bachelor of Science in Information Technology'      -- program_name
    , '3rd Year'                                          -- year_level
    , 'Enrolled'                                          -- registration_status
    )
  returning student_id, student_number
),

ins_enrollment as (
  insert into public.registrar_enrollment
    (student_id, academic_year, semester, enrollment_status)
  select student_id, '2026-2027', '1st Semester', 'Enrolled'
    from ins_student
  returning enrollment_id
),

-- ---------------------------------------------------------------
-- EDIT THE SUBJECTS HERE (code, name, grade, units)
-- 1.00 = highest, 5.00 = failing.  93% ceiling ~= GPA 1.28 or better.
-- ---------------------------------------------------------------
subject_list(student_code, subject_name, subject_grade, subject_units) as (
  values
    ('IT301', 'Data Structures and Algorithms',      1.25::numeric, 3::numeric),
    ('IT302', 'Operating Systems',                   1.00::numeric, 3::numeric),
    ('IT303', 'Software Engineering',                1.25::numeric, 3::numeric),
    ('GE321', 'Purposive Communication',             1.00::numeric, 3::numeric),
    ('GE322', 'Mathematics in the Modern World',     1.00::numeric, 3::numeric),
    ('GE323', 'Ethics',                              1.25::numeric, 3::numeric),
    ('PE321', 'Physical Fitness',                    1.00::numeric, 2::numeric),
    ('PE322', 'Rhythmic Activities',                 1.25::numeric, 2::numeric)
),

ins_subjects as (
  insert into public.registrar_student_subjects
    (student_id, subject_code, subject_name, grade, units)
  select s.student_id, l.subject_code, l.subject_name, l.subject_grade, l.subject_units
    from ins_student s
    cross join subject_list l
  returning subject_id
),

-- overall GPA rolled up from the subjects above
ins_gpa as (
  insert into public.registrar_student_gpa
    (student_id, academic_year, semester, total_subjects, total_units,
     weighted_points, gpa, percentage, at_risk, maintained,
     computed_at, updated_at)
  select s.student_id
       , '2026-2027'
       , '1st Semester'
       , count(*)::int
       , coalesce(sum(l.subject_units), 0)
       , coalesce(sum(l.subject_grade * l.subject_units), 0)
       , round(coalesce(sum(l.subject_grade * l.subject_units), 0)
               / nullif(sum(l.subject_units), 0), 3)
       , round(((5 - (coalesce(sum(l.subject_grade * l.subject_units), 0)
                      / nullif(sum(l.subject_units), 0))) / 4) * 100, 2)
       , ((5 - (coalesce(sum(l.subject_grade * l.subject_units), 0)
                / nullif(sum(l.subject_units), 0))) / 4) * 100 < 93
       , ((5 - (coalesce(sum(l.subject_grade * l.subject_units), 0)
                / nullif(sum(l.subject_units), 0))) / 4) * 100 >= 93
       , now(), now()
    from ins_student s
    cross join subject_list l
   group by s.student_id
  returning gpa_id
)

select 'student'   as inserted, s.student_id::text, s.student_number from ins_student s
union all
select 'enrollment', e.enrollment_id::text, '' from ins_enrollment e
union all
select 'subjects',   count(*)::text, '' from ins_subjects
union all
select 'gpa',        g.gpa_id::text, g.gpa::text || ' (' || g.percentage::text || '%)' from ins_gpa g;

commit;


-- ---------------------------------------------------------------------------
-- OPTION 2 - STUDENT INFORMATION ONLY
--            (no enrollment, no subjects, no GPA yet)
-- ---------------------------------------------------------------------------

-- insert into public.registrar_students
--   (student_number, last_name, given_name, middle_name, ext_name,
--    sex, birthdate, program_name, year_level, registration_status)
-- values
--   ('2026-00002', 'Cruz', 'Maria', 'Santos', null,
--    'Female', date '2004-07-20',
--    'Bachelor of Science in Information Technology', '1st Year', 'Enrolled');


-- ---------------------------------------------------------------------------
-- OPTION 3 - ADD ENROLLMENT ONLY (for a student that already exists)
-- ---------------------------------------------------------------------------

-- insert into public.registrar_enrollment
--   (student_id, academic_year, semester, enrollment_status)
-- select student_id, '2026-2027', '1st Semester', 'Enrolled'
--   from public.registrar_students
--  where student_number = '2026-00002';


-- ---------------------------------------------------------------------------
-- OPTION 4 - ADD / REPLACE SUBJECTS + RECOMPUTE THE OVERALL GPA
--            Use this when you already have the student row and you only
--            want to give them grades. The GPA row is (re)built from the
--            subjects, so you never type the GPA yourself.
-- ---------------------------------------------------------------------------

-- begin;
--
-- with target as (
--   select student_id from public.registrar_students
--    where student_number = '2026-00002'
-- ),
-- subject_list(student_code, subject_name, subject_grade, subject_units) as (
--   values
--     ('IT111', 'Introduction to Computing', 1.00::numeric, 3::numeric),
--     ('IT112', 'Computer Programming 1',    1.25::numeric, 3::numeric),
--     ('GE111', 'Purposive Communication',   1.00::numeric, 3::numeric),
--     ('GE112', 'Understanding the Self',    1.25::numeric, 3::numeric),
--     ('GE113', 'Ethics',                    1.00::numeric, 3::numeric),
--     ('PE111', 'Physical Fitness',          1.25::numeric, 2::numeric),
--     ('PE112', 'Rhythmic Activities',       1.00::numeric, 2::numeric),
--     ('GE114', 'Mathematics in the Modern World', 1.00::numeric, 3::numeric)
-- ),
-- wipe as (
--   delete from public.registrar_student_subjects
--    where student_id in (select student_id from target)
-- ),
-- ins as (
--   insert into public.registrar_student_subjects
--     (student_id, subject_code, subject_name, grade, units)
--   select t.student_id, l.subject_code, l.subject_name, l.subject_grade, l.subject_units
--     from target t cross join subject_list l
--   returning student_id, grade, units
-- ),
-- gpa as (
--   insert into public.registrar_student_gpa
--     (student_id, academic_year, semester, total_subjects, total_units,
--      weighted_points, gpa, percentage, at_risk, maintained, computed_at, updated_at)
--   select student_id, '2026-2027', '1st Semester',
--          count(*)::int, sum(units), sum(grade * units),
--          round(sum(grade * units) / nullif(sum(units), 0), 3),
--          round(((5 - sum(grade * units) / nullif(sum(units), 0)) / 4) * 100, 2),
--          ((5 - sum(grade * units) / nullif(sum(units), 0)) / 4) * 100 < 93,
--          ((5 - sum(grade * units) / nullif(sum(units), 0)) / 4) * 100 >= 93,
--          now(), now()
--     from ins
--    group by student_id
--   returning gpa_id
-- )
-- select (select count(*) from ins)   as subjects_inserted,
--        (select count(*) from gpa)   as gpa_rows_written;
--
-- commit;


-- ---------------------------------------------------------------------------
-- OPTION 5 - RECOMPUTE EVERY STUDENT'S OVERALL GPA
--            Run this after any manual subject edits. Idempotent.
-- ---------------------------------------------------------------------------

-- insert into public.registrar_student_gpa
--   (student_id, total_subjects, total_units, weighted_points,
--    gpa, percentage, at_risk, maintained, computed_at)
-- select s.student_id
--      , count(*)::int
--      , coalesce(sum(s.units), 0)
--      , coalesce(sum(s.grade * s.units), 0)
--      , round(coalesce(sum(s.grade * s.units), 0) / nullif(sum(s.units), 0), 3)
--      , round(((5 - (coalesce(sum(s.grade * s.units), 0) / nullif(sum(s.units), 0))) / 4) * 100, 2)
--      , ((5 - (coalesce(sum(s.grade * s.units), 0) / nullif(sum(s.units), 0))) / 4) * 100 < 93
--      , ((5 - (coalesce(sum(s.grade * s.units), 0) / nullif(sum(s.units), 0))) / 4) * 100 >= 93
--      , now()
--   from public.registrar_student_subjects s
--  group by s.student_id
-- on conflict (student_id) do update
--    set total_subjects  = excluded.total_subjects
--      , total_units     = excluded.total_units
--      , weighted_points = excluded.weighted_points
--      , gpa             = excluded.gpa
--      , percentage      = excluded.percentage
--      , at_risk         = excluded.at_risk
--      , maintained      = excluded.maintained
--      , computed_at     = now()
--      , updated_at      = now();


-- ---------------------------------------------------------------------------
-- OPTION 6 - FULL ROSTER VIEW (everything the app shows, in one place)
-- ---------------------------------------------------------------------------

-- select r.student_id
--      , r.student_number
--      , r.given_name || ' ' || coalesce(r.middle_name || ' ', '') || r.last_name as full_name
--      , r.program_name
--      , r.year_level
--      , r.registration_status
--      , e.academic_year
--      , e.semester
--      , e.enrollment_status
--      , g.total_subjects
--      , g.total_units
--      , g.gpa
--      , g.percentage
--      , case when g.at_risk then 'AT RISK (<93%)' else 'OK' end as early_warning
--   from public.registrar_students r
--   left join public.registrar_enrollment      e on e.student_id = r.student_id
--   left join public.registrar_student_gpa     g on g.student_id = r.student_id
--  order by g.percentage asc nulls last, r.student_id;


-- ---------------------------------------------------------------------------
-- OPTION 7 - JUST THE GRADES OF ONE STUDENT (per subject)
-- ---------------------------------------------------------------------------

-- select s.subject_code
--      , s.subject_name
--      , s.grade
--      , s.units
--      , round(s.grade * s.units, 2) as weighted_points
--   from public.registrar_student_subjects s
--   join public.registrar_students r on r.student_id = s.student_id
--  where r.student_number = '2026-00002'
--  order by s.subject_id;
-- -- overall:  sum(weighted_points) / sum(units)


-- ============================================================================
-- VERIFICATION - run after any insert
-- ============================================================================

-- -- every student with their overall GPA (this is what the alert reads)
-- select r.student_number
--      , r.given_name || ' ' || r.last_name                        as name
--      , g.total_subjects
--      , g.total_units
--      , g.gpa
--      , g.percentage
--      , g.at_risk
--   from public.registrar_students r
--   left join public.registrar_student_gpa g on g.student_id = r.student_id
--  order by g.percentage asc nulls last;

-- -- orphans: subjects or GPA rows with no matching student (should be 0)
-- select (select count(*) from public.registrar_student_subjects s
--          left join public.registrar_students r on r.student_id = s.student_id
--          where r.student_id is null) as orphan_subjects,
--        (select count(*) from public.registrar_student_gpa g
--          left join public.registrar_students r on r.student_id = g.student_id
--          where r.student_id is null) as orphan_gpa;

-- -- students in the registrar but NOT registered in the MAIN database
-- -- (these are the rows the cleanup script deletes)
-- select r.student_number, r.given_name, r.last_name
--   from public.registrar_students r
--  where not exists (
--          select 1 from public.student_accounts sa
--           where sa.student_number = r.student_number
--        );
-- -- NOTE: the last query only works if you run it where both databases are
-- -- visible. The registrar and main projects are separate, so normally you
-- -- compare the two exports by hand instead.
