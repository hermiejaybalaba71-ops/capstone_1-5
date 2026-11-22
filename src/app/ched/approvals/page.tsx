"use client";
import toast from "react-hot-toast";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDate, downloadCsv } from "@/lib/utils";
import { STATUS_STYLES, REQUIRED_DOCS } from "@/lib/constants";
import { autoRejectSiblings, notifyStudentStatus } from "@/lib/scholarship";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { ImportedSheet } from "@/components/import/imported-sheet";

// Status category tabs (same pattern as the Administrator's applications page).
// Default = "Approved" so the list only shows approved scholars on load.
const STATUS_TABS = [
  { key: "Approved", label: "Approved", active: "bg-green-600 text-white", idle: "text-green-700 hover:bg-green-50" },
  { key: "Pending", label: "Pending", active: "bg-amber-500 text-white", idle: "text-amber-700 hover:bg-amber-50" },
  { key: "Not Approved", label: "Not Approved", active: "bg-red-600 text-white", idle: "text-red-600 hover:bg-red-50" },
  { key: "", label: "All", active: "bg-[#7B1113] text-white", idle: "text-[#6B5458] hover:bg-[#7B1113]/5 hover:text-[#7B1113]" },
] as const;

interface ChedUser {
  user_id: number;
  username: string;
  role: string;
}

interface Application {
  application_id: number;
  student_id: number;
  application_status: string;
  application_date: string;
  scholarship_programs?: { scholarship_name: string };
  student_accounts?: { given_name: string; last_name: string; student_number: string; program_name: string };
}

interface Approval {
  application_id: number;
  approved_by: number;
  approval_status: string;
  approval_date?: string;
  validation_status?: string;
}

interface DocRow {
  document_type: string;
  scholarship_applications?: { student_id: number } | { student_id: number }[];
}

export default function ChedApprovalsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const [chedUser, setChedUser] = useState<ChedUser | null>(null);
  const [applications, setApplications] = useState<Application[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [studentReqs, setStudentReqs] = useState<Record<number, Set<string>>>({});
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [busyMsg, setBusyMsg] = useState("");
  const [scholarshipFilter, setScholarshipFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("Approved");

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
      setChedUser(meData);

      const [appQ, apprQ, docQ, acadQ] = await Promise.all([
        sb.from("scholarship_applications").select("*, scholarship_programs(scholarship_name), student_accounts(given_name, last_name, student_number, program_name)").order("application_date", { ascending: false }),
        sb.from("scholarship_approval").select("*"),
        sb.from("support_documents").select("document_type, scholarship_applications(student_id)"),
        sb.from("support_academic_records").select("student_id"),
      ]);

      if (!appQ.error) setApplications(appQ.data || []);
      if (!apprQ.error) setApprovals(apprQ.data || []);

      const reqMap: Record<number, Set<string>> = {};
      if (!docQ.error) (docQ.data || []).forEach((d: DocRow) => {
        const sid = Array.isArray(d.scholarship_applications) ? d.scholarship_applications[0]?.student_id : d.scholarship_applications?.student_id;
        if (sid == null) return;
        if (!reqMap[sid]) reqMap[sid] = new Set();
        reqMap[sid].add(d.document_type);
      });
      if (!acadQ.error) (acadQ.data || []).forEach((a: { student_id: number }) => {
        if (!reqMap[a.student_id]) reqMap[a.student_id] = new Set();
        reqMap[a.student_id].add("Academic Record");
      });
      setStudentReqs(reqMap);
      if (!ignore) setLoading(false);
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  function completenessFor(studentId: number) {
    const owned = studentReqs[studentId] || new Set();
    const missing = REQUIRED_DOCS.filter((r) => !owned.has(r));
    return { missing, complete: missing.length === 0 };
  }

  function approvalFor(appId: number) {
    return approvals.find((a) => a.application_id === appId);
  }

  const scholarshipNames = Array.from(
    new Set(
      applications
        .map((app) => app.scholarship_programs?.scholarship_name?.trim() || "Scholarship not identified")
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const scholarshipCounts = scholarshipNames.reduce<Record<string, number>>((counts, name) => {
    counts[name] = applications.filter(
      (app) => (app.scholarship_programs?.scholarship_name?.trim() || "Scholarship not identified") === name,
    ).length;
    return counts;
  }, {});

  // Status counts for the category tabs.
  const pendingCount = applications.filter((a) => a.application_status === "Pending").length;
  const approvedCount = applications.filter((a) => a.application_status === "Approved").length;
  const notApprovedCount = applications.filter((a) => a.application_status === "Not Approved").length;

  // Status category filter — default tab shows only Approved scholars.
  const statusFiltered = statusFilter
    ? applications.filter((app) => app.application_status === statusFilter)
    : applications;

  const statusScholarshipFilter = scholarshipFilter
    ? statusFiltered.filter(
      (app) => (app.scholarship_programs?.scholarship_name?.trim() || "Scholarship not identified") === scholarshipFilter,
    )
    : statusFiltered;

  // Newest approval first (approved-from-ranking and selection both land here).
  const approvalDateFor = (appId: number) => approvalFor(appId)?.approval_date || "";
  const visibleApplications = [...statusScholarshipFilter].sort((a, b) => {
    const da = approvalDateFor(a.application_id) || a.application_date || "";
    const db = approvalDateFor(b.application_id) || b.application_date || "";
    return db.localeCompare(da);
  });

  async function handleApprove(app: Application) {
    if (!chedUser) return;
    setApprovingId(app.application_id);
    setBusyMsg("");
    const sb = getSupabase();
    await sb.from("scholarship_approval").delete().eq("application_id", app.application_id);
    const { error } = await sb.from("scholarship_approval").insert({
      application_id: app.application_id,
      approved_by: chedUser.user_id,
      approval_date: new Date().toISOString(),
      approval_status: "Approved",
      validation_status: "Not Validated",
    });
    if (error) { setApprovingId(null); setBusyMsg(error.message); return; }
    const { error: upErr } = await sb.from("scholarship_applications")
      .update({ application_status: "Approved" })
      .eq("application_id", app.application_id);
    if (upErr) { setApprovingId(null); setBusyMsg(upErr.message); return; }

    const approvedRecord: Approval = {
      application_id: app.application_id,
      approved_by: chedUser.user_id,
      approval_status: "Approved",
      approval_date: new Date().toISOString(),
      validation_status: "Not Validated",
    };
    setApprovals((prev) => [...prev.filter((x) => x.application_id !== app.application_id), approvedRecord]);
    setApplications((prev) => prev.map((a) =>
      a.application_id === app.application_id ? { ...a, application_status: "Approved" } : a
    ));

    await notifyStudentStatus(app.student_id, app, "Approved");

    const res = await autoRejectSiblings([{ application_id: app.application_id, student_id: app.student_id }], applications);
    if (res.rejectedCount > 0) {
      setApplications((prev) => prev.map((a) =>
        a.student_id === app.student_id && a.application_id !== app.application_id
          ? { ...a, application_status: "Not Approved", remarks: `Auto-rejected: already approved for "${app.scholarship_programs?.scholarship_name || "another scholarship"}".` }
          : a
      ));
      setBusyMsg(`Approved and notified the student. Auto-rejected ${res.rejectedCount} other application(s).`);
      toast.success(`Approved and notified the student. Auto-rejected ${res.rejectedCount} other application(s).`);
    } else {
      setBusyMsg("Approved and notified the student. Dashboard and notifications updated.");
      toast.success("Approved and notified the student. Dashboard and notifications updated.");
    }
  }

  async function handleUndo(appId: number) {
    setBusyMsg("");
    const sb = getSupabase();
    const { error } = await sb.from("scholarship_approval").delete().eq("application_id", appId);
    if (error) { setBusyMsg(error.message); return; }
    const { error: upErr } = await sb.from("scholarship_applications")
      .update({ application_status: "Pending" })
      .eq("application_id", appId);
    if (upErr) { setBusyMsg(upErr.message); return; }
    const app = applications.find((a) => a.application_id === appId);
    if (app) await notifyStudentStatus(app.student_id, app, "Pending");
    setApprovals((prev) => prev.filter((a) => a.application_id !== appId));
    setApplications((prev) => prev.map((a) =>
      a.application_id === appId ? { ...a, application_status: "Pending" } : a
    ));
    if (app) setBusyMsg("Approval undone. Student was notified the application is pending again.");
  }

  function exportFinalList() {
    const approvedApps = applications.filter((a) => a.application_status === "Approved");
    if (!approvedApps.length) return;
    const rows = approvedApps.map((a, i) => {
      const appr = approvalFor(a.application_id);
      return {
        beneficiary_no: i + 1,
        student_number: a.student_accounts?.student_number || "",
        name: `${a.student_accounts?.last_name}, ${a.student_accounts?.given_name}`,
        program: a.student_accounts?.program_name || "",
        scholarship: a.scholarship_programs?.scholarship_name || "",
        application_date: formatDate(a.application_date),
        approval_date: formatDate(appr?.approval_date || ""),
        status: "Approved",
        registrar_validation: appr?.validation_status || "Pending Admin Validation",
      };
    });
    downloadCsv("final-approved-scholars.csv", rows);
    setBusyMsg(`Exported ${rows.length} approved scholar(s).`);
    toast.success(`Exported ${rows.length} approved scholar(s).`);
  }

  function handleSendToAdmin() {
    const count = applications.filter((a) => a.application_status === "Approved").length;
    if (!count) return;
    exportFinalList();
    setBusyMsg(`Final list of ${count} approved beneficiaries exported and ready for Administrator review. The Administrator will validate against the Registrar database and notify students.`);
    toast.success(`Final list of ${count} approved beneficiaries exported and ready for Administrator review. The Administrator will validate against the Registrar database and notify students.`);
  }

  if (loading) return <Spinner label="Loading approvals..." color="blue" />;

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
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Scholarships Approval List</h1>
          <p className="mt-1 text-xs text-[#6B5458]">
            {statusFilter === "Approved"
              ? `${approvedCount} approved scholar${approvedCount === 1 ? "" : "s"} — newest approval first. Pending and Not Approved applications are under their own tabs.`
              : statusFilter === "Pending"
                ? `${pendingCount} application(s) still awaiting a CHED decision.`
                : statusFilter === "Not Approved"
                  ? `${notApprovedCount} application(s) marked as Not Approved.`
                  : `${approvedCount} approved · ${pendingCount} pending · ${notApprovedCount} not approved.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={exportFinalList}
            disabled={!approvedCount}
            className="rounded-lg border border-[#7B1113]/30 px-4 py-2 text-xs font-bold text-[#7B1113] hover:bg-[#7B1113]/5 disabled:opacity-50"
          >
            Export CSV
          </button>
          <button
            onClick={handleSendToAdmin}
            disabled={!approvedCount}
            className="rounded-lg bg-[#7B1113] px-4 py-2 text-xs font-bold text-white hover:bg-[#540111] disabled:opacity-50"
          >
            Send Final List to Admin
          </button>
        </div>
      </div>

      {approvedCount > 0 && (
        <div className="rounded-xl border border-blue-200 bg-[#7B1113]/[0.06] px-4 py-3 text-xs font-medium text-[#7B1113]">
          {approvedCount} beneficiary(ies) approved. The final list will be sent to the Administrator for Registrar validation and student notification.
        </div>
      )}

      {/* Status category tabs — Approved is the default view. */}
      <div className="flex flex-wrap gap-2">
        {STATUS_TABS.map((tab) => {
          const count = tab.key === "Approved" ? approvedCount : tab.key === "Pending" ? pendingCount : tab.key === "Not Approved" ? notApprovedCount : applications.length;
          return (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition ${statusFilter === tab.key ? tab.active : `${tab.idle} border border-[#241012]/[0.06]`}`}
            >
              {tab.label} ({count})
            </button>
          );
        })}
      </div>

      {busyMsg && (
        <div className="rounded-xl border border-[#7B1113]/20 bg-white px-4 py-3 text-xs font-medium text-[#7B1113] shadow-sm">
          {busyMsg}
        </div>
      )}

      <ImportedSheet
        prefer="year"
        scope="approvals"
        emoji="📋"
        title="Imported approval-list reference"
        hint="Approval-list files imported by the Administrator appear here automatically. Click a file section to review its rows; imported records are reference-only."
        readOnly
      />

      {applications.length > 0 && (
        <section className="rounded-xl border border-[#241012]/[0.06] bg-white p-3 shadow-sm">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-[#6B5458]">Scholarship programs</p>
              <p className="mt-0.5 text-[10px] text-[#8B7376]">Choose a category to review one scholarship at a time.</p>
            </div>
            <span className="text-[10px] text-[#8B7376]">{visibleApplications.length} of {applications.length} applications in this view</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setScholarshipFilter("")}
              className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition ${
                scholarshipFilter === ""
                  ? "bg-[#7B1113] text-white shadow-sm"
                  : "border border-[#241012]/10 bg-[#FAF7F5] text-[#6B5458] hover:border-[#7B1113]/40 hover:text-[#7B1113]"
              }`}
            >
              All programs ({applications.length})
            </button>
            {scholarshipNames.map((name) => (
              <button
                key={name}
                onClick={() => setScholarshipFilter(scholarshipFilter === name ? "" : name)}
                title={`Show ${scholarshipCounts[name]} application(s) under ${name}`}
                className={`max-w-full truncate rounded-full px-3 py-1.5 text-left text-[11px] font-bold transition ${
                  scholarshipFilter === name
                    ? "bg-[#7B1113] text-white shadow-sm"
                    : "border border-[#241012]/10 bg-[#FAF7F5] text-[#6B5458] hover:border-[#7B1113]/40 hover:text-[#7B1113]"
                }`}
              >
                {name} ({scholarshipCounts[name]})
              </button>
            ))}
          </div>
        </section>
      )}

      {applications.length === 0 ? (
        <EmptyState icon="&#128203;" title="No applications yet" hint="Applications submitted by students will appear here." />
      ) : (
        <div className="space-y-3">
          {visibleApplications.map((a) => {
            const approval = approvalFor(a.application_id);
            const comp = completenessFor(a.student_id);
            return (
              <div key={a.application_id} className="flex flex-col gap-3 rounded-xl border border-[#241012]/[0.06] bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[#241012]">
                    {a.student_accounts?.last_name}, {a.student_accounts?.given_name}{" "}
                    <span className="font-normal text-[#8B7376]">({a.student_accounts?.student_number})</span>
                  </p>
                  <p className="text-xs font-semibold text-[#7B1113]">{a.scholarship_programs?.scholarship_name}</p>
                  <p className="text-[11px] text-[#8B7376]">
                    {a.student_accounts?.program_name} &middot; Submitted {formatDate(a.application_date)}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge className={STATUS_STYLES[a.application_status] || ""}>{a.application_status}</Badge>
                    <Badge className={comp.complete ? "border-green-200 bg-green-50 text-green-700" : "border-orange-200 bg-orange-50 text-orange-700"}>
                      {comp.complete ? "Requirements complete" : `Missing ${comp.missing.length}`}
                    </Badge>
                  </div>
                  {!comp.complete && (
                    <p className="mt-1 rounded-lg bg-orange-50 px-3 py-1.5 text-[11px] text-orange-700">
                      Missing: {comp.missing.join(", ")}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 self-start sm:self-center">
                  {a.application_status === "Approved" ? (
                    <>
                      <Badge className="border-green-300 bg-green-100 text-green-800">Approved</Badge>
                      {approval?.validation_status && (
                        <Badge className={approval.validation_status === "Validated" ? "border-green-200 bg-green-50 text-green-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
                          {approval.validation_status}
                        </Badge>
                      )}
                      <button
                        onClick={() => handleUndo(a.application_id)}
                        className="rounded-md border border-red-200 px-3 py-1.5 text-[11px] font-bold text-red-600 hover:bg-red-50"
                      >
                        Undo
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => handleApprove(a)}
                      disabled={approvingId === a.application_id}
                      className="rounded-lg bg-[#7B1113] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#540111] disabled:opacity-60"
                    >
                      {approvingId === a.application_id ? "Processing..." : a.application_status === "Not Approved" ? "Re-approve as scholar" : "Approve as scholar"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {!visibleApplications.length && (
            <EmptyState
              icon={statusFilter === "Approved" ? "&#127942;" : "&#128203;"}
              title={
                statusFilter === "Approved"
                  ? "No approved scholars yet"
                  : statusFilter === "Pending"
                    ? "No pending applications"
                    : statusFilter === "Not Approved"
                      ? "No not-approved applications"
                      : "No applications in this view"
              }
              hint={
                statusFilter === "Approved"
                  ? "Approved scholars (from the Ranking page or here) will appear in this list, newest first."
                  : scholarshipFilter
                    ? "Choose another scholarship category to see its applicants."
                    : "Applications will appear here once their status changes."
              }
            />
          )}
        </div>
      )}

      <p className="pt-2 text-[11px] leading-relaxed text-[#8B7376]">
        UC06 &mdash; After approving beneficiaries, click &quot;Send Final List to Admin&quot; to export and deliver the approved list to the Administrator. The Administrator validates students against the Registrar database, updates application statuses, and notifies all applicants.
      </p>
    </div>
  );
}
