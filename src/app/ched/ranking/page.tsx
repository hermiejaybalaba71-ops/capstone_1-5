"use client";
import toast from "react-hot-toast";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase, authHeaders } from "@/lib/supabase/browser";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { downloadCsv } from "@/lib/utils";
import { autoRejectSiblings, notifyStudentStatus } from "@/lib/scholarship";

interface Ranking {
  ranking_id: number;
  application_id: number;
  ranking_position: number;
  priority_score: number;
  prediction_result?: string;
  generated_date?: string;
  // Saved with the row when the admin executes the ML ranking: OCR proof of
  // the declared annual income plus the composite rank score.
  declared_income?: number | null;
  ocr_income?: number | null;
  ocr_match_pct?: number | null;
  income_used?: number | null;
  income_need_pct?: number | null;
  ocr_match_score?: number | null;
  rank_score?: number | null;
  itr_status?: string | null;
  // Item 8 "Taxpayer's Name" read from ITR page 1 plus the OR-rule verdict
  // (family OR given name agreeing = verified; mismatch = ranked last).
  itr_name?: string | null;
  itr_name_status?: string | null;
}

/** Supabase numeric columns arrive as string | number | null. */
function numOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const peso = (value: number | null | undefined) =>
  value == null ? "\u2014" : `\u20B1${Number(value).toLocaleString()}`;

const ITR_STATUS_LABEL: Record<string, string> = {
  verified: "ITR verified",
  mismatch: "ITR mismatch",
  unreadable: "ITR unreadable",
  no_itr: "No ITR",
};

const pct = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(Number(value)) ? "\u2014" : `${Number(value).toFixed(digits)}%`;

/** Gold / silver / bronze pill for the top 3, maroon ring for everyone else - same badge the admin table uses. */
function RankBadge({ index }: { index: number }) {
  const styles = [
    "bg-gradient-to-br from-[#FDE68A] to-[#D97706] text-[#5B3406] ring-1 ring-[#D97706]/40",
    "bg-gradient-to-br from-[#E5E7EB] to-[#9CA3AF] text-[#374151] ring-1 ring-gray-400/40",
    "bg-gradient-to-br from-[#FED7AA] to-[#C2703B] text-[#5B2E12] ring-1 ring-[#C2703B]/40",
  ];
  if (index < 3) {
    return (
      <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-extrabold shadow-sm ${styles[index]}`}>
        {index + 1}
      </span>
    );
  }
  return (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#7B1113]/10 text-[11px] font-extrabold text-[#7B1113] ring-1 ring-[#7B1113]/20">
      {index + 1}
    </span>
  );
}

/** Percent + bar used for the Priority column (and Financial need when stored). */
function ScoreMeter({ value, tone }: { value: number; tone: "priority" | "need" }) {
  const clamped = Math.max(0, Math.min(100, value));
  const fill =
    tone === "priority"
      ? "bg-gradient-to-r from-[#7B1113] to-[#B01E28]"
      : clamped >= 70
        ? "bg-gradient-to-r from-[#DC2626] to-[#F87171]"
        : clamped >= 40
          ? "bg-gradient-to-r from-[#D97706] to-[#FBBF24]"
          : "bg-gradient-to-r from-[#059669] to-[#34D399]";
  return (
    <div className="min-w-[86px]">
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[11px] font-bold ${tone === "priority" ? "text-[#7B1113]" : "text-[#241012]"}`}>
          {value.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#241012]/[0.08]">
        <div className={`h-1.5 rounded-full transition-all ${fill}`} style={{ width: `${Math.max(3, clamped)}%` }} />
      </div>
    </div>
  );
}

interface Application {
  application_id: number;
  student_id: number;
  // The uploaded ITR file(s): Page 1 (and optional BIR 1701-MS Page 2) -
  // the same paths the admin's ranking table opens with "View ITR".
  application_data?: { itr_file?: string | null; itr_file_p2?: string | null } | null;
  scholarship_programs?: { scholarship_name: string }[] | { scholarship_name: string };
  student_accounts?: {
    given_name: string;
    last_name: string;
    student_number: string;
    program_name: string;
    year_level: string;
    sex: string;
    student_id: number;
  }[] | {
    given_name: string;
    last_name: string;
    student_number: string;
    program_name: string;
    year_level: string;
    sex: string;
    student_id: number;
  };
}

interface ChedForm {
  ched_form_id: number;
  application_id: number;
  student_id?: string;
  given_name?: string;
  last_name?: string;
  ext_name?: string;
  middle_name?: string;
  sex?: string;
  birthdate?: string;
  complete_program_name?: string;
  year_level?: string;
  father_name?: string;
  mother_name?: string;
  street_barangay?: string;
  zipcode?: string;
  disability?: string;
  indigenous_people_group?: string;
  contact_number?: string;
  email_address?: string;
  income_tax_return?: string;
  annual_income_family?: number;
}

interface AcadRecord {
  student_id: number;
  shs_gwa?: number;
  college_gpa?: number;
  applicant_type?: string;
}

function unwrap<T>(val: T[] | T | undefined): T | undefined {
  if (!val) return undefined;
  return Array.isArray(val) ? val[0] : val;
}

export default function ChedRankingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const [rankings, setRankings] = useState<Ranking[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [approvals, setApprovals] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<"all" | "High Need" | "Low Need">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "Pending" | "Approved" | "Not Approved">("all");
  const [scholarshipFilter, setScholarshipFilter] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [chedUserId, setChedUserId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [chedForms, setChedForms] = useState<ChedForm[]>([]);
  const [academicRecords, setAcademicRecords] = useState<AcadRecord[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  // One open detail row at a time - the admin table expands the same way.
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      setFatalError("");
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.push("/login"); return; }

      const { data: meData, error: meErr } = await sb.from("users").select("*").eq("auth_user_id", session.user.id).maybeSingle();
      if (meErr || !meData) { setFatalError("Account not found."); setLoading(false); return; }
      if (meData.role !== "CHED") { setFatalError("CHED personnel access is required."); setLoading(false); return; }
      setChedUserId(meData.user_id);

      const [rankQ, appQ, approvalQ, chedQ, acadQ] = await Promise.all([
        sb.from("ranking_result").select("*").order("ranking_position", { ascending: true }),
        sb.from("scholarship_applications").select("application_id, student_id, application_data, scholarship_programs(scholarship_name), student_accounts(given_name, last_name, student_number, program_name, year_level, sex, student_id)"),
        sb.from("scholarship_approval").select("application_id, approval_status"),
        sb.from("ched_form_input").select("*").order("ched_form_id", { ascending: false }),
        sb.from("support_academic_records").select("student_id, shs_gwa, college_gpa, applicant_type"),
      ]);

      if (!rankQ.error) setRankings(rankQ.data || []);
      if (!appQ.error) setApplications(appQ.data || []);
      if (!chedQ.error) setChedForms(chedQ.data || []);
      if (!acadQ.error) setAcademicRecords(acadQ.data || []);
      if (!approvalQ.error) {
        const map: Record<number, string> = {};
        (approvalQ.data || []).forEach((a: { application_id: number; approval_status: string }) => { map[a.application_id] = a.approval_status; });
        setApprovals(map);
      }
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router, reloadKey]);

  function appFor(appId: number) { return applications.find((a) => a.application_id === appId); }
  function getSA(app?: Application) { return unwrap(app?.student_accounts); }
  function getSP(app?: Application) { return unwrap(app?.scholarship_programs); }
  function getStudentName(app?: Application) { const sa = getSA(app); return sa ? `${sa.last_name}, ${sa.given_name}` : null; }
  function getStudentNumber(app?: Application) { return getSA(app)?.student_number ?? null; }
  function getScholarshipName(app?: Application) { return getSP(app)?.scholarship_name ?? null; }
  function getYearLevel(app?: Application) { return getSA(app)?.year_level ?? null; }
  function getSex(app?: Application) { return getSA(app)?.sex ?? null; }
  function getProgram(app?: Application) { return getSA(app)?.program_name ?? null; }
  function getChedForm(appId: number) { return chedForms.find((c) => c.application_id === appId); }
  function getAcadRec(studentId: number) { return academicRecords.find((r) => r.student_id === studentId); }
  /** ITR storage paths of an application (Page 1 + optional Page 2). */
  function getItrPaths(app?: Application) {
    return {
      p1: app?.application_data?.itr_file ?? null,
      p2: app?.application_data?.itr_file_p2 ?? null,
    };
  }

  async function viewItr(itrPath: string) {
    const sb = getSupabase();
    // 1) Normal signing - works for buckets that have a storage read policy
    //    for the logged-in user.
    const { data, error: err } = await sb.storage.from("itr-documents").createSignedUrl(itrPath, 3600);
    if (data?.signedUrl) {
      window.open(data.signedUrl, "_blank");
      return;
    }
    // 2) The itr-documents bucket has no SELECT policy, so the user's key gets
    //    404 "Object not found" even though the file is really there (the OCR
    //    pipeline reads it fine because it uses the service key). Fall back to
    //    the server route, which signs with the service key - the same
    //    workaround the admin ranking page uses.
    try {
      const res = await fetch("/api/storage/signed-url", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({ bucket: "itr-documents", paths: [itrPath] }),
      });
      const payload = (await res.json()) as { urls?: Record<string, string>; error?: string };
      const url = payload.urls?.[itrPath];
      if (res.ok && url) {
        window.open(url, "_blank");
        return;
      }
      toast.error(payload.error || err?.message || "Could not open the ITR file.");
    } catch {
      toast.error(err?.message || "Could not open the ITR file.");
    }
  }

  const scholarshipNames = Array.from(
    new Set(
      rankings
        .map((r) => getScholarshipName(appFor(r.application_id)) || "Scholarship not identified")
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const scholarshipCounts = scholarshipNames.reduce<Record<string, number>>((counts, name) => {
    counts[name] = rankings.filter(
      (r) => (getScholarshipName(appFor(r.application_id)) || "Scholarship not identified") === name,
    ).length;
    return counts;
  }, {});

  const filtered = rankings.filter((r) => {
    const scholarshipName = getScholarshipName(appFor(r.application_id)) || "Scholarship not identified";
    if (scholarshipFilter && scholarshipName !== scholarshipFilter) return false;
    if (filter !== "all" && r.prediction_result !== filter) return false;
    const status = approvals[r.application_id];
    if (statusFilter === "Approved" && status !== "Approved") return false;
    if (statusFilter === "Not Approved" && status !== "Not Approved") return false;
    if (statusFilter === "Pending" && status) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const app = appFor(r.application_id);
    const sa = getSA(app);
    if (getStudentName(app)?.toLowerCase().includes(q)) return true;
    if (sa?.student_number?.toLowerCase().includes(q)) return true;
    if (sa?.program_name?.toLowerCase().includes(q)) return true;
    if (sa?.year_level?.toLowerCase().includes(q)) return true;
    if (sa?.sex?.toLowerCase().includes(q)) return true;
    if (getScholarshipName(app)?.toLowerCase().includes(q)) return true;
    return false;
  });

  function toggleSelect(appId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((r) => r.application_id)));
  }

  async function approveSelected() {
    if (!selected.size) return;
    setSaving(true);
    setMessage("");
    const sb = getSupabase();
    const now = new Date().toISOString();
    const approvedTargets = [];
    let notified = 0;
    for (const appId of selected) {
      await sb.from("scholarship_approval").delete().eq("application_id", appId);
      const { error } = await sb.from("scholarship_approval").insert({
        application_id: appId, approved_by: chedUserId, approval_status: "Approved", approval_date: now, validation_status: "Not Validated",
      });
      if (error) { setMessage(`Error approving #${appId}: ${error.message}`); setSaving(false); return; }
      await sb.from("scholarship_applications").update({ application_status: "Approved" }).eq("application_id", appId);
      const app = appFor(appId);
      if (app) {
        approvedTargets.push({ application_id: appId, student_id: app.student_id });
        await notifyStudentStatus(app.student_id, app, "Approved");
        notified += 1;
      }
    }
    const res = await autoRejectSiblings(approvedTargets, applications);
    setSelected(new Set());
    setMessage(`Approved ${selected.size} applicant(s) and notified ${notified} student(s). Dashboard/status updates are live.${res.rejectedCount > 0 ? ` Auto-rejected ${res.rejectedCount} other application(s).` : ""}`);
    toast.success(`Approved ${selected.size} applicant(s) and notified ${notified} student(s). Dashboard/status updates are live.${res.rejectedCount > 0 ? ` Auto-rejected ${res.rejectedCount} other application(s).` : ""}`);
    setSaving(false);
    setReloadKey((k) => k + 1);
  }

  async function rejectSelected() {
    if (!selected.size) return;
    setSaving(true);
    setMessage("");
    const sb = getSupabase();
    const now = new Date().toISOString();
    let notified = 0;
    for (const appId of selected) {
      await sb.from("scholarship_approval").delete().eq("application_id", appId);
      const { error } = await sb.from("scholarship_approval").insert({
        application_id: appId, approved_by: chedUserId, approval_status: "Not Approved", approval_date: now, validation_status: "Not Validated",
      });
      if (error) { setMessage(`Error rejecting #${appId}: ${error.message}`); setSaving(false); return; }
      await sb.from("scholarship_applications").update({ application_status: "Not Approved" }).eq("application_id", appId);
      const app = appFor(appId);
      if (app) {
        await notifyStudentStatus(app.student_id, app, "Not Approved");
        notified += 1;
      }
    }
    setSelected(new Set());
    setMessage(`Rejected ${selected.size} applicant(s) and notified ${notified} student(s).`);
    toast.success(`Rejected ${selected.size} applicant(s) and notified ${notified} student(s).`);
    setSaving(false);
    setReloadKey((k) => k + 1);
  }

  function exportCsv() {
    downloadCsv("ched-ranking-review.csv", filtered.map((r) => {
      const app = appFor(r.application_id);
      const sa = getSA(app);
      const form = getChedForm(r.application_id);
      const acad = getAcadRec(sa?.student_id ?? 0);
      return {
        rank: r.ranking_position,
        student_id: sa?.student_id ?? "",
        student_number: getStudentNumber(app) ?? "",
        last_name: sa?.last_name ?? "",
        given_name: sa?.given_name ?? "",
        middle_name: form?.middle_name ?? "",
        ext_name: form?.ext_name ?? "",
        sex: form?.sex ?? getSex(app) ?? "",
        birthdate: form?.birthdate ?? "",
        program: form?.complete_program_name ?? getProgram(app) ?? "",
        year_level: form?.year_level ?? getYearLevel(app) ?? "",
        father_name: form?.father_name ?? "",
        mother_name: form?.mother_name ?? "",
        street_barangay: form?.street_barangay ?? "",
        zipcode: form?.zipcode ?? "",
        disability: form?.disability ?? "",
        indigenous_people_group: form?.indigenous_people_group ?? "",
        contact_number: form?.contact_number ?? "",
        email_address: form?.email_address ?? "",
        annual_income_family: form?.annual_income_family ?? "",
        applicant_type: acad?.applicant_type ?? "",
        shs_gwa: acad?.shs_gwa ?? "",
        college_gpa: acad?.college_gpa ?? "",
        scholarship: getScholarshipName(app) ?? "",
        priority_score: r.priority_score,
        rank_score: r.rank_score ?? "",
        declared_income: r.declared_income ?? "",
        ocr_income: r.ocr_income ?? "",
        ocr_match_pct: r.ocr_match_pct ?? "",
        income_used: r.income_used ?? "",
        income_need_pct: r.income_need_pct ?? "",
        itr_status: r.itr_status ?? "",
        itr_name: r.itr_name ?? "",
        itr_name_status: r.itr_name_status ?? "",
        prediction: r.prediction_result ?? "",
        approval_status: approvals[r.application_id] ?? "Pending",
      };
    }));
    setMessage(`Exported ${filtered.length} ranking records.`);
    toast.success(`Exported ${filtered.length} ranking records.`);
  }

  if (loading) return <Spinner label="Loading ranking result..." color="blue" />;
  if (fatalError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f0f2f8] px-6">
        <div className="max-w-sm text-center">
          <p className="text-4xl">&#128683;</p>
          <h1 className="mt-3 text-lg font-bold text-[#241012]">{fatalError}</h1>
        </div>
      </main>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[#241012]">Ranking Result</h1>
        <span className="text-xs text-[#8B7376]">{rankings.length} total ranked</span>
      </div>

      {message && (
        <div className="rounded-xl border border-blue-200 bg-[#7B1113]/[0.06] px-4 py-3 text-xs font-medium text-[#7B1113]">{message}</div>
      )}

      {rankings.length === 0 ? (
        <EmptyState icon="&#129302;" title="No ranking result yet" hint="The ranking result has not been generated yet. It will appear here once the Administrator runs the ML ranking process." />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[#241012]/[0.07] bg-white shadow-sm">
          {/* Card header - same shape as the admin "AI Ranking Results" card. */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#241012]/[0.07] bg-gradient-to-r from-[#FAF7F5] to-white px-5 py-4">
            <div>
              <p className="text-sm font-bold text-[#241012]">AI Ranking Results</p>
              <p className="mt-0.5 text-[11px] text-[#6B5458]">
                {scholarshipFilter ? `${scholarshipFilter} \u00b7 ` : ""}
                {filtered.length} of {rankings.length} applicant{rankings.length === 1 ? "" : "s"} ranked &middot;{" "}
                <span className="font-semibold text-[#7B1113]">Rank 1 = highest model-predicted priority</span>
                {" \u00b7 "}
                <span className="text-[#6B5458]">
                  saved ranking values restored from the database &middot; the OCR-read ITR amount is the ranking income when it can be read
                </span>
              </p>
            </div>
            <button
              onClick={exportCsv}
              disabled={!filtered.length}
              className="rounded-lg bg-[#7B1113] px-3.5 py-2 text-[11px] font-bold text-white transition hover:bg-[#540111] disabled:opacity-40"
              title="Export the ranking shown in this table as CSV"
            >
              Export CSV
            </button>
          </div>

          {/* Ranked-program chips: click one to show ONLY that scholarship program's results. */}
          {scholarshipNames.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-[#241012]/[0.07] bg-white px-5 py-3">
              <span className="mr-1 text-[10px] font-bold uppercase tracking-wide text-[#6B5458]">
                Ranked programs
              </span>
              <button
                type="button"
                onClick={() => setScholarshipFilter("")}
                aria-pressed={scholarshipFilter === ""}
                className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition ${
                  scholarshipFilter === ""
                    ? "bg-[#7B1113] text-white shadow-sm"
                    : "border border-[#7B1113]/30 text-[#7B1113] hover:bg-[#7B1113]/5"
                }`}
                title="Show every ranked applicant"
              >
                All scholarships
                <span
                  className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] ${
                    scholarshipFilter === "" ? "bg-white/20 text-white" : "bg-[#7B1113]/10 text-[#7B1113]"
                  }`}
                >
                  {rankings.length}
                </span>
              </button>
              {scholarshipNames.map((name) => {
                const active = scholarshipFilter === name;
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setScholarshipFilter(active ? "" : name)}
                    aria-pressed={active}
                    className={`max-w-full truncate rounded-full px-3 py-1.5 text-[11px] font-bold transition ${
                      active
                        ? "bg-[#7B1113] text-white shadow-sm"
                        : "border border-[#7B1113]/30 text-[#7B1113] hover:bg-[#7B1113]/5"
                    }`}
                    title={`Show the ranking results of ${name} (${scholarshipCounts[name]} applicant(s))`}
                  >
                    {name}
                    <span
                      className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] ${
                        active ? "bg-white/20 text-white" : "bg-[#7B1113]/10 text-[#7B1113]"
                      }`}
                    >
                      {scholarshipCounts[name]}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Search + filters - CHED keeps its prediction and approval-status
              filters on top of the shared admin table shape. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[#241012]/[0.07] bg-[#FAF7F5]/60 px-5 py-3">
            <div className="relative min-w-56 flex-1 sm:max-w-xs">
              <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8B7376]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search by name, student #, program, year, sex, scholarship..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-[#241012]/10 bg-white py-2.5 pl-9 pr-3 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
              />
            </div>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as "all" | "High Need" | "Low Need")}
              className="rounded-lg border border-[#241012]/10 bg-white px-3 py-2 text-xs font-medium text-[#241012] outline-none transition focus:border-[#7B1113]"
            >
              <option value="all">Prediction: All ({rankings.length})</option>
              <option value="High Need">High Need ({rankings.filter((r) => r.prediction_result === "High Need").length})</option>
              <option value="Low Need">Low Need ({rankings.filter((r) => r.prediction_result === "Low Need").length})</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "all" | "Pending" | "Approved" | "Not Approved")}
              className="rounded-lg border border-[#241012]/10 bg-white px-3 py-2 text-xs font-medium text-[#241012] outline-none transition focus:border-[#7B1113]"
            >
              <option value="all">Status: All</option>
              <option value="Approved">Status: Approved ({rankings.filter((r) => approvals[r.application_id] === "Approved").length})</option>
              <option value="Not Approved">Status: Not Approved ({rankings.filter((r) => approvals[r.application_id] === "Not Approved").length})</option>
              <option value="Pending">Status: Pending ({rankings.filter((r) => !approvals[r.application_id]).length})</option>
            </select>
          </div>

          {/* Batch bar - CHED is the final approver, so the real Approve /
              Not Approve buttons stay here. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[#241012]/[0.07] px-5 py-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-[#241012]">
              <input
                type="checkbox"
                checked={filtered.length > 0 && selected.size === filtered.length}
                onChange={toggleSelectAll}
                className="h-4 w-4 accent-[#7B1113]"
                title="Select every applicant shown"
              />
              Select all ({filtered.length})
            </label>
            {selected.size > 0 && (
              <span className="rounded-full bg-[#7B1113]/10 px-2.5 py-1 text-[11px] font-bold text-[#7B1113]">
                {selected.size} selected
              </span>
            )}
            <button
              onClick={approveSelected}
              disabled={!selected.size || saving}
              className="rounded-lg bg-green-600 px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-green-700 disabled:opacity-40"
              title="Approve every selected applicant, notify them and auto-reject their other applications"
            >
              {saving ? "Saving..." : `Approve Selected (${selected.size})`}
            </button>
            <button
              onClick={rejectSelected}
              disabled={!selected.size || saving}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-red-700 disabled:opacity-40"
              title="Not approve every selected applicant and notify them"
            >
              {saving ? "Saving..." : `Reject Selected (${selected.size})`}
            </button>
          </div>

          {/* The table is wider than the card: a clearly visible scrollbar plus
              a right-edge fade make it obvious there are more columns to the right. */}
          <div className="relative">
            <div className="max-h-[70vh] overflow-auto [-ms-overflow-style:none] [scrollbar-color:#7B111359_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:rounded-full [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#7B1113]/45 [&::-webkit-scrollbar-track]:bg-[#241012]/[0.04]">
              <table className="w-full min-w-[1320px] text-left text-xs">
                <thead className="sticky top-0 z-10 bg-[#FAF7F5] text-[10px] uppercase tracking-wide text-[#6B5458] shadow-[0_1px_0_0_rgba(36,16,18,0.07)]">
                  <tr>
                    <th className="px-4 py-3">
                      <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleSelectAll}
                        className="h-4 w-4 accent-[#7B1113]" title="Select every applicant shown" />
                    </th>
                    <th className="px-4 py-3 font-bold">Rank</th>
                    <th className="px-4 py-3 font-bold">Student</th>
                    <th className="px-4 py-3 font-bold">Program</th>
                    <th className="px-4 py-3 font-bold">Year</th>
                    <th className="px-4 py-3 font-bold">Sex</th>
                    <th className="px-4 py-3 font-bold">Scholarship</th>
                    <th className="px-4 py-3 font-bold">Declared annual family income</th>
                    <th className="px-4 py-3 font-bold">ITR OCR income</th>
                    <th className="px-4 py-3 font-bold">OCR match</th>
                    <th className="px-4 py-3 font-bold" title="Not stored with saved ranking results">Financial need</th>
                    <th className="px-4 py-3 font-bold">Priority</th>
                    <th className="px-4 py-3 font-bold" title="Random Forest priority + income need + ITR/OCR match">Rank score</th>
                    <th className="px-4 py-3 font-bold">Prediction</th>
                    <th className="px-4 py-3 font-bold">Status</th>
                    <th className="px-4 py-3 font-bold" title="Open the ITR file uploaded by the applicant (Page 1 / Page 2)">ITR</th>
                  </tr>
                </thead>
            <tbody>
              {filtered.map((r, i) => {
                const app = appFor(r.application_id);
                const status = approvals[r.application_id];
                const itrPaths = getItrPaths(app);
                const declared = numOrNull(r.declared_income);
                const ocrIncome = numOrNull(r.ocr_income);
                const incomeUsed = numOrNull(r.income_used);
                const matchPct = numOrNull(r.ocr_match_pct);
                const matchScore = numOrNull(r.ocr_match_score);
                const needPct = numOrNull(r.income_need_pct);
                const rankScore = numOrNull(r.rank_score);
                const priority = numOrNull(r.priority_score) ?? 0;
                const ocrDiffers = ocrIncome != null && declared != null && ocrIncome !== declared;
                const isExpanded = expanded === r.ranking_id;
                const prediction = r.prediction_result || "";
                const predictionChip =
                  prediction === "High Need"
                    ? "bg-[#FEE2E2] text-[#B91C1C] ring-1 ring-[#DC2626]/30"
                    : prediction === "Moderate Need"
                      ? "bg-[#FEF3C7] text-[#92400E] ring-1 ring-[#D97706]/30"
                      : "bg-[#D1FAE5] text-[#065F46] ring-1 ring-[#059669]/30";
                // OCR income trust - the same chip styles the admin row uses.
                const matchChip =
                  r.itr_status === "no_itr"
                    ? { cls: "bg-gray-100 text-gray-600 ring-gray-300/50", dot: "bg-gray-400", text: "No ITR", title: "No ITR uploaded - the declared income cannot be verified, so this applicant is ranked last" }
                    : matchPct == null
                      ? { cls: "bg-gray-100 text-gray-600 ring-gray-300/50", dot: "bg-gray-400", text: "OCR unavailable", title: "An ITR was uploaded, but OCR could not read an income amount, so no match score was added." }
                      : r.itr_status === "mismatch" || matchPct < 90
                        ? { cls: "bg-[#FEF3C7] text-[#92400E] ring-[#D97706]/30", dot: "bg-amber-500", text: `${pct(matchPct)} \u2717`, title: "OCR income differs from the declared income - a far-off ITR reading lowers the rank score and demotes this applicant" }
                        : { cls: "bg-[#D1FAE5] text-[#065F46] ring-[#059669]/30", dot: "bg-emerald-500", text: `${pct(matchPct)} \u2713`, title: "OCR income matches the declared income - the match percentage is added to the rank score" };
                // Item 8 name verification: verified / mismatch / not read.
                const nameChip =
                  r.itr_name_status === "verified"
                    ? { cls: "bg-[#D1FAE5] text-[#065F46] ring-[#059669]/30", dot: "bg-emerald-500", text: "Name \u2713", title: `ITR Item 8 reads "${r.itr_name ?? ""}" - matches the applicant's family or given name (verified)` }
                    : r.itr_name_status === "mismatch"
                      ? { cls: "bg-[#FEE2E2] text-[#B91C1C] ring-[#DC2626]/30", dot: "bg-red-500", text: "Name \u2717 mismatch", title: `ITR Item 8 reads "${r.itr_name ?? "unreadable"}" - not the applicant's name, so this ITR cannot verify income and the applicant is ranked last like one with no ITR` }
                      : r.itr_status === "no_itr" || r.itr_status == null
                        ? null
                        : { cls: "bg-gray-100 text-gray-600 ring-gray-300/50", dot: "bg-gray-400", text: "Name not read", title: "An ITR was uploaded, but page 1's Item 8 name could not be read" };
                return (
                  <Fragment key={r.ranking_id}>
                    <tr
                      onClick={() => setExpanded(isExpanded ? null : r.ranking_id)}
                      className={`cursor-pointer border-t border-[#241012]/[0.05] transition-colors hover:bg-[#7B1113]/[0.04] ${
                        i % 2 ? "bg-[#FAF9F8]" : "bg-white"
                      } ${i === 0 ? "shadow-[inset_3px_0_0_0_#7B1113]" : ""}`}
                      title="Click to see the OCR breakdown and rank-score inputs"
                    >
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(r.application_id)}
                          onChange={() => toggleSelect(r.application_id)}
                          className="h-4 w-4 accent-[#7B1113]"
                          title="Select this applicant"
                        />
                      </td>
                      <td className="px-4 py-3"><RankBadge index={i} /></td>
                      <td className="px-4 py-3">
                        <div className="whitespace-nowrap font-semibold text-[#241012]">{getStudentName(app) || `App #${r.application_id}`}</div>
                        <div className="whitespace-nowrap text-[10px] text-[#8B7376]">{getStudentNumber(app) || "\u2014"}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="max-w-[160px] truncate text-[#6B5458]" title={getProgram(app) || undefined}>{getProgram(app) || "\u2014"}</div>
                      </td>
                      <td className="px-4 py-3 text-[#6B5458]">{getYearLevel(app) || "\u2014"}</td>
                      <td className="px-4 py-3 text-[#6B5458]">{getSex(app) || "\u2014"}</td>
                      <td className="px-4 py-3">
                        <div className="max-w-[150px] truncate text-[#6B5458]" title={getScholarshipName(app) || undefined}>{getScholarshipName(app) || "\u2014"}</div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="font-semibold text-[#7B1113]">{peso(declared)}</div>
                        <div className="text-[10px] text-[#8B7376]">
                          {declared == null
                            ? "not declared"
                            : incomeUsed != null && incomeUsed !== declared
                              ? "audit figure \u00b7 ITR amount ranks"
                              : "ranking income"}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className={`font-semibold ${ocrIncome == null ? "text-[#8B7376]" : "text-[#241012]"}`}>{peso(ocrIncome)}</div>
                        <div className="max-w-[170px] truncate text-[10px] text-[#8B7376]">
                          {ocrIncome != null
                            ? ocrDiffers
                              ? "differs from declared"
                              : "amount read from ITR"
                            : r.itr_status === "no_itr"
                              ? "no ITR uploaded"
                              : "income not detected"}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <span
                            title={matchChip.title}
                            className={`inline-flex whitespace-nowrap items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${matchChip.cls}`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${matchChip.dot}`} />
                            {matchChip.text}
                          </span>
                          {nameChip && (
                            <span
                              title={nameChip.title}
                              className={`inline-flex whitespace-nowrap items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${nameChip.cls}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${nameChip.dot}`} />
                              {nameChip.text}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-[#8B7376]" title="Financial need is not stored with saved ranking results">{"\u2014"}</span>
                      </td>
                      <td className="px-4 py-3"><ScoreMeter value={priority} tone="priority" /></td>
                      <td className="px-4 py-3" title="RF priority + income need + ITR/OCR match">
                        {rankScore == null ? (
                          <span className="text-[#8B7376]">{"\u2014"}</span>
                        ) : (
                          <div className="whitespace-nowrap">
                            <span className="font-extrabold text-[#7B1113]">{rankScore.toFixed(1)}</span>
                            <span className="ml-1 text-[9px] text-[#8B7376]">
                              = {priority.toFixed(0)}+{needPct?.toFixed(0) ?? "0"}+{matchScore?.toFixed(0) ?? "0"}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-bold ring-1 ${predictionChip}`}>
                          {prediction || "\u2014"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {status === "Approved" && <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">Approved</span>}
                        {status === "Not Approved" && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">Rejected</span>}
                        {!status && <span className="rounded-full bg-[#F3EEEB] px-2 py-0.5 text-[10px] font-bold text-[#6B5458]">Pending</span>}
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-col items-start gap-1">
                          {itrPaths.p1 && (
                            <button
                              onClick={() => viewItr(itrPaths.p1 as string)}
                              className="inline-flex whitespace-nowrap items-center gap-1 rounded-lg border border-[#7B1113]/25 px-2.5 py-1.5 text-[10px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/10"
                            >
                              View ITR 1
                            </button>
                          )}
                          {itrPaths.p2 && (
                            <button
                              onClick={() => viewItr(itrPaths.p2 as string)}
                              className="inline-flex whitespace-nowrap items-center gap-1 rounded-lg border border-[#7B1113]/25 px-2.5 py-1.5 text-[10px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/10"
                            >
                              View ITR 2
                            </button>
                          )}
                          {!itrPaths.p1 && !itrPaths.p2 && (
                            <span
                              title={r.itr_status === "no_itr" ? "No ITR uploaded by this applicant" : "No ITR file path recorded for this application"}
                              className="text-[#8B7376]"
                            >
                              None
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-t border-[#241012]/[0.05] bg-[#FAF7F5]">
                        <td colSpan={16} className="px-4 py-4">
                          <div className="grid gap-3 text-[11px] md:grid-cols-3">
                            <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-3.5">
                              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-[#6B5458]">OCR result</p>
                              <p className="flex justify-between gap-2 py-0.5">Declared income <b>{peso(declared)}</b></p>
                              <p className="flex justify-between gap-2 py-0.5">OCR income <b>{peso(ocrIncome)}</b></p>
                              <p className="flex justify-between gap-2 py-0.5">
                                <span>Income used for ranking</span>
                                <b className="text-[#7B1113]">{peso(incomeUsed ?? declared)}</b>
                              </p>
                              {ocrDiffers && ocrIncome != null && declared != null && (
                                <p className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-amber-700">
                                  OCR differs by {ocrIncome - declared > 0 ? "+" : ""}{peso(ocrIncome - declared)} &mdash; review this ITR mismatch.
                                </p>
                              )}
                              <p className="flex justify-between gap-2 py-0.5">
                                <span>ITR name (Item 8)</span>
                                <b className={r.itr_name_status === "verified" ? "text-emerald-700" : r.itr_name_status === "mismatch" ? "text-red-700" : "text-gray-500"}>
                                  {r.itr_name_status === "verified"
                                    ? `"${r.itr_name ?? ""}" matches the applicant`
                                    : r.itr_name_status === "mismatch"
                                      ? `"${r.itr_name ?? "unreadable"}" is not the applicant - ranked last like no ITR`
                                      : r.itr_status === "no_itr" || r.itr_status == null
                                        ? "No ITR"
                                        : "Name could not be read from page 1"}
                                </b>
                              </p>
                              <p className="flex justify-between gap-2 py-0.5">
                                <span>ITR check</span>
                                <b className={matchChip.text.includes("\u2713") ? "text-emerald-700" : matchChip.text.includes("\u2717") ? "text-amber-700" : "text-gray-500"}>
                                  {matchChip.title}
                                </b>
                              </p>
                            </div>
                            <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-3.5">
                              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-[#6B5458]">Rank score breakdown</p>
                              <p className="flex justify-between gap-2 py-0.5">
                                <span>Ranking basis</span>
                                <b className="text-[#7B1113]">RF priority + income need + OCR match</b>
                              </p>
                              <p className="flex justify-between gap-2 py-0.5">Financial need score <b>{"\u2014"}</b></p>
                              <p className="flex justify-between gap-2 py-0.5">ITR/OCR match score <b>{matchScore != null ? matchScore.toFixed(2) : matchPct != null ? matchPct.toFixed(2) : "\u2014"}</b></p>
                              <p className="flex justify-between gap-2 py-0.5">Income need (100 = lowest) <b>{needPct != null ? needPct.toFixed(2) : "\u2014"}</b></p>
                              <p className="flex justify-between gap-2 py-0.5">Priority score (RF) <b className="text-[#7B1113]">{priority.toFixed(2)}</b></p>
                              <p className="mt-1 flex justify-between gap-2 rounded-lg bg-[#7B1113]/[0.06] px-2 py-1">
                                <span className="font-bold text-[#241012]">Total rank score</span>
                                <b className="text-[#7B1113]">{rankScore != null ? rankScore.toFixed(2) : "\u2014"}</b>
                              </p>
                              {r.itr_status === "no_itr" && (
                                <p className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-800">
                                  No ITR uploaded &mdash; income could not be verified, so this applicant is ranked last.
                                </p>
                              )}
                            </div>
                            <div className="rounded-xl border border-[#241012]/[0.06] bg-white p-3.5">
                              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-[#6B5458]">Applicant</p>
                              <p className="flex justify-between gap-2 py-0.5">Student # <b>{getStudentNumber(app) || "\u2014"}</b></p>
                              <p className="flex justify-between gap-2 py-0.5">Program <b>{getProgram(app) || "\u2014"}</b></p>
                              <p className="flex justify-between gap-2 py-0.5">Year level <b>{getYearLevel(app) || "\u2014"}</b></p>
                              <p className="flex justify-between gap-2 py-0.5">Sex <b>{getSex(app) || "\u2014"}</b></p>
                              <p className="flex justify-between gap-2 py-0.5">Scholarship <b>{getScholarshipName(app) || "\u2014"}</b></p>
                              <p className="mt-1 break-all rounded-lg bg-[#FAF7F5] px-2 py-1 text-[10px] text-[#6B5458]">
                                {itrPaths.p1 ? `ITR 1: ${itrPaths.p1}` : ""}
                                {itrPaths.p1 && itrPaths.p2 ? "\n" : ""}
                                {itrPaths.p2 ? `ITR 2: ${itrPaths.p2}` : ""}
                                {!itrPaths.p1 && !itrPaths.p2 ? "No ITR uploaded yet" : ""}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={16} className="px-4 py-8 text-center text-xs text-[#8B7376]">No results match your search</td></tr>
              )}
            </tbody>
              </table>
            </div>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-white via-white/75 to-transparent"
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#241012]/[0.07] bg-[#FAF7F5] px-5 py-2.5 text-[10px] text-[#6B5458]">
            <span>
              Average priority{" "}
              <b className="text-[#7B1113]">
                {filtered.length
                  ? `${(filtered.reduce((s, r) => s + (numOrNull(r.priority_score) ?? 0), 0) / filtered.length).toFixed(1)}%`
                  : "\u2014"}
              </b>
            </span>
            <span>
              High need <b className="text-[#7B1113]">{filtered.filter((r) => r.prediction_result === "High Need").length}</b>
            </span>
            <span>
              ITR name mismatch <b className="text-[#7B1113]">{filtered.filter((r) => r.itr_name_status === "mismatch").length}</b>
            </span>
            <span>
              Approved <b className="text-green-700">{filtered.filter((r) => approvals[r.application_id] === "Approved").length}</b>
            </span>
            <span>
              Pending <b className="text-[#7B1113]">{filtered.filter((r) => !approvals[r.application_id]).length}</b>
            </span>
            <span className="ml-auto">Click any row to see the OCR breakdown and rank-score inputs.</span>
          </div>
        </div>
      )}
    </div>
  );
}
