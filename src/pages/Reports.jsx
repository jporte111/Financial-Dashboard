import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { usePeriodContext } from '@/lib/usePeriod';
import SectionHeading from '@/components/SectionHeading';
import TrendsSection from '@/components/TrendsSection';
import { FileText, Lock } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function Reports() {
  const { isAdmin } = usePeriodContext();
  const [reports, setReports] = useState([]);

  // Trends: the same payload clients receive (current published versions
  // only), so admins see exactly what Sonia sees -- never drafts.
  const [trend, setTrend] = useState(undefined);
  useEffect(() => {
    base44.entities.SavedReport.list('sort_order').then(setReports);
    base44.functions.invoke('publicDashboard', {}).then((r) => setTrend((r?.data ?? r)?.trend ?? null)).catch(() => setTrend(null));
  }, []);

  const visible = reports.filter((r) => isAdmin || r.visibility === 'client');

  return (
    <div className="space-y-14">
      <section>
        <SectionHeading title="Reports" subtitle="Selected reports prepared by your financial team" />
        <div className="grid gap-4 sm:grid-cols-2">
          {visible.map((r) => (
            <Link
              key={r.id}
              to={r.report_type === 'category_detail' ? '/' : r.report_type === 'cash' ? '/cash' : r.report_type === 'budget_summary' ? '/budget' : '/savings'}
              className="flex items-start gap-4 rounded-2xl border border-stone-200 bg-white p-6 transition hover:shadow-[0_2px_24px_rgba(0,0,0,0.05)]"
            >
              <FileText className="mt-0.5 h-5 w-5 shrink-0 text-stone-400" />
              <div>
                <p className="font-medium">{r.title}</p>
                {r.description && <p className="mt-1 text-sm text-stone-500">{r.description}</p>}
                {r.visibility === 'internal' && (
                  <span className="mt-2 inline-flex items-center gap-1 text-xs text-stone-400"><Lock className="h-3 w-3" /> Internal only</span>
                )}
              </div>
            </Link>
          ))}
          {!visible.length && <p className="text-sm text-stone-500">No reports available yet.</p>}
        </div>
      </section>

      <section>
        <SectionHeading title="Trends" subtitle="Year to date, month by month, from the published reports (as clients see them)" />
        {trend === undefined ? <p className="text-sm text-stone-400">Loading…</p> : <TrendsSection trend={trend} />}
      </section>
    </div>
  );
}