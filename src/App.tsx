import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, AlertCircle, ArrowDownToLine, Banknote, BedDouble, CalendarDays,
  CheckCircle2, ChevronDown, CircleDollarSign, ClipboardList, FileSpreadsheet,
  FileText, Home, LogOut, Menu, Pencil, Plus, Search, ShieldCheck, Users,
  Wallet, X,
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { hasSupabaseConfig, supabase } from './lib/supabase';
import {
  activeSchedule, buildResidentRows, categoryLabel, currentMonth, dateForInput,
  euro, feeForCategory, firstOfNextMonth, monthDate, monthLabel,
} from './lib/utils';
import type { Category, FilterType, FeeSchedule, MonthlyCharge, Payment, Resident, ResidentRow } from './types';

const client = supabase;

function App() {
  const [session, setSession] = useState<any>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!client) { setChecking(false); return; }
    const { data: listener } = client.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    client.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); }).catch(() => setChecking(false));
    return () => listener.subscription.unsubscribe();
  }, []);

  if (!hasSupabaseConfig) return <SetupScreen />;
  if (checking) return <div className="screen-center"><div className="loader" /><span>Loading StayManager…</span></div>;
  if (!session) return <LoginScreen />;
  return <Workspace session={session} />;
}

function SetupScreen() {
  return <div className="screen-center"><div className="setup-card">
    <div className="brand-mark large"><Home size={25} /></div>
    <h1>Connect StayManager</h1>
    <p>The application files are ready. Add your Supabase project details to connect the secure cloud database.</p>
    <ol>
      <li>Create a Supabase project in an EU region.</li>
      <li>Run <code>supabase/schema.sql</code> in the Supabase SQL Editor.</li>
      <li>Copy <code>.env.example</code> to <code>.env</code> and enter your project URL and publishable/anon key.</li>
      <li>Create your administrator login and follow the setup steps in <code>README.md</code>.</li>
    </ol>
    <div className="notice"><ShieldCheck size={17} /> Never place a Supabase service-role key in this frontend.</div>
  </div></div>;
}

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(''); setBusy(true);
    const { error: authError } = await client!.auth.signInWithPassword({ email: email.trim(), password });
    if (authError) setError(authError.message);
    setBusy(false);
  }
  return <div className="login-shell">
    <div className="login-art">
      <div className="brand-lockup"><div className="brand-mark"><Home size={22} /></div><span>StayManager</span></div>
      <div className="login-art-copy"><span className="eyebrow">ACCOMMODATION MANAGEMENT</span><h1>Everything in its place.</h1><p>One clear view of residents, monthly fees and payments.</p></div>
      <div className="art-footer">Resident records · Monthly billing · Financial reports</div>
    </div>
    <div className="login-panel"><form className="login-form" onSubmit={submit}>
      <div className="brand-mark mobile-brand"><Home size={22} /></div>
      <span className="eyebrow">ADMINISTRATOR ACCESS</span><h2>Welcome back</h2><p>Sign in to manage your accommodation.</p>
      <label>Email address<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@example.com" /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" /></label>
      {error && <div className="error-inline"><AlertCircle size={16} />{error}</div>}
      <button className="btn primary full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'}</button>
      <div className="login-secure"><ShieldCheck size={15} /> Protected administrator access</div>
    </form></div>
  </div>;
}

type Tab = 'dashboard' | 'residents' | 'monthly' | 'reports';

function Workspace({ session }: { session: any }) {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [selectedMonth, setSelectedMonth] = useState(currentMonth());
  const [residents, setResidents] = useState<Resident[]>([]);
  const [schedules, setSchedules] = useState<FeeSchedule[]>([]);
  const [charges, setCharges] = useState<MonthlyCharge[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [editingNo, setEditingNo] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [profile, setProfile] = useState<ResidentRow | null>(null);
  const [mobileNav, setMobileNav] = useState(false);

  const rows = useMemo(() => buildResidentRows(residents, schedules, charges, payments, selectedMonth), [residents, schedules, charges, payments, selectedMonth]);
  const registered = rows.filter(r => r.full_name?.trim()).length;
  const empty = 100 - registered;
  const collectedThisMonth = payments.filter(p => p.payment_date.slice(0, 7) === selectedMonth.slice(0, 7)).reduce((s, p) => s + Number(p.amount), 0);
  const lifetimeCollected = payments.reduce((s, p) => s + Number(p.amount), 0);
  const outstanding = rows.reduce((s, r) => s + r.balance, 0);
  const monthlyCharges = rows.reduce((s, r) => s + (r.full_name ? r.monthlyFee : 0), 0);
  const working = rows.filter(r => r.full_name && r.category === 'working').length;
  const staying = rows.filter(r => r.full_name && r.category === 'staying').length;
  const custom = rows.filter(r => r.full_name && r.category === 'custom').length;
  const paidCount = rows.filter(r => r.status === 'paid').length;
  const partialCount = rows.filter(r => r.status === 'partial').length;
  const pendingCount = rows.filter(r => r.status === 'pending').length;
  const overdueCount = rows.filter(r => r.status === 'overdue').length;

  async function loadData(silent = false) {
    if (!silent) setLoading(true); else setRefreshing(true);
    setError('');
    try {
      const { error: generateError } = await client!.rpc('generate_staymanager_month', { p_month: monthDate(selectedMonth) });
      if (generateError) throw generateError;
      const [residentResult, scheduleResult, chargeResult, paymentResult] = await Promise.all([
        client!.from('residents').select('*').order('resident_no'),
        client!.from('resident_fee_schedule').select('*').order('effective_month'),
        client!.from('monthly_charges').select('*').eq('billing_month', monthDate(selectedMonth)),
        client!.from('payments').select('*').order('payment_date', { ascending: false }),
      ]);
      const problem = residentResult.error || scheduleResult.error || chargeResult.error || paymentResult.error;
      if (problem) throw problem;
      setResidents((residentResult.data ?? []) as Resident[]);
      setSchedules((scheduleResult.data ?? []) as FeeSchedule[]);
      setCharges((chargeResult.data ?? []) as MonthlyCharge[]);
      setPayments((paymentResult.data ?? []) as Payment[]);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load StayManager data.');
    } finally { setLoading(false); setRefreshing(false); }
  }

  useEffect(() => { void loadData(); }, [selectedMonth]);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(''), 3200); return () => window.clearTimeout(t); }, [toast]);

  function changeTab(next: Tab) { setTab(next); setMobileNav(false); }
  async function signOut() { await client!.auth.signOut(); }

  async function saveName(row: ResidentRow) {
    const name = nameDraft.trim();
    if (!name) { setToast('Please enter a resident name.'); return; }
    try {
      if (row.full_name?.trim()) {
        const { error: updateError } = await client!.from('residents').update({ full_name: name }).eq('id', row.id);
        if (updateError) throw updateError;
      } else {
        const { error: createError } = await client!.rpc('create_staymanager_resident', {
          p_resident_no: row.resident_no, p_full_name: name, p_category: 'staying', p_monthly_fee: 180,
        });
        if (createError) throw createError;
      }
      setEditingNo(null); setNameDraft(''); await loadData(true); setToast(`Resident ${row.resident_no} saved.`);
    } catch (err: any) { setToast(err?.message ?? 'Could not save resident name.'); }
  }

  function startEditName(row: ResidentRow) { setEditingNo(row.resident_no); setNameDraft(row.full_name ?? ''); }
  function openProfile(row: ResidentRow) { setProfile(row); }

  const filteredRows = rows.filter(row => {
    const text = query.trim().toLowerCase();
    const matchesText = !text || [row.full_name ?? '', String(row.resident_no), row.room_number ?? '', row.contact_number ?? ''].some(v => v.toLowerCase().includes(text));
    if (!matchesText) return false;
    if (filter === 'all') return true;
    if (filter === 'working' || filter === 'staying' || filter === 'custom') return row.category === filter;
    return row.status === filter;
  });

  function exportExcel() {
    const data = rows.map(r => ({
      'Resident no.': r.resident_no, 'Resident name': r.full_name ?? 'Empty', 'Room': r.room_number ?? '',
      'Bed': r.bed_number ?? '', 'Contact': r.contact_number ?? '', 'Category': r.category ? categoryLabel(r.category) : '',
      'Monthly fee (€)': r.full_name ? r.monthlyFee : '', 'Paid (€)': r.full_name ? r.paid : '',
      'Balance (€)': r.full_name ? r.balance : '', 'Status': r.status.toUpperCase(),
      'Payment dates': r.paymentDates.join(', '),
    }));
    const sheet = XLSX.utils.json_to_sheet(data);
    sheet['!cols'] = [{ wch: 14 }, { wch: 26 }, { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 28 }];
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Monthly report');
    XLSX.writeFile(book, `StayManager-${selectedMonth.slice(0, 7)}.xlsx`);
  }

  function exportPdf() {
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(18); doc.text('StayManager monthly report', 14, 17);
    doc.setFontSize(10); doc.text(`${monthLabel(selectedMonth)}  |  Collected: ${euro(collectedThisMonth)}  |  Outstanding: ${euro(outstanding)}  |  Charges: ${euro(monthlyCharges)}`, 14, 25);
    autoTable(doc, {
      startY: 32,
      head: [['No.', 'Resident', 'Room', 'Category', 'Fee', 'Paid', 'Balance', 'Status', 'Payment dates']],
      body: rows.map(r => [String(r.resident_no), r.full_name ?? 'Empty', r.room_number ?? '—', r.category ? categoryLabel(r.category) : '—', r.full_name ? euro(r.monthlyFee) : '—', r.full_name ? euro(r.paid) : '—', r.full_name ? euro(r.balance) : '—', r.status.toUpperCase(), r.paymentDates.join(', ') || '—']),
      styles: { fontSize: 7, cellPadding: 2.2 }, headStyles: { fillColor: [20, 42, 73] },
    });
    doc.save(`StayManager-${selectedMonth.slice(0, 7)}.pdf`);
  }

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <div className="brand-lockup"><div className="brand-mark"><Home size={21} /></div><span>StayManager</span></div>
      <div className="sidebar-label">WORKSPACE</div>
      <nav className="side-nav">
        <NavButton icon={<Activity size={18} />} label="Dashboard" active={tab === 'dashboard'} onClick={() => changeTab('dashboard')} />
        <NavButton icon={<Users size={18} />} label="Residents" count="100" active={tab === 'residents'} onClick={() => changeTab('residents')} />
        <NavButton icon={<CalendarDays size={18} />} label="Monthly payments" active={tab === 'monthly'} onClick={() => changeTab('monthly')} />
        <NavButton icon={<FileText size={18} />} label="Financial reports" active={tab === 'reports'} onClick={() => changeTab('reports')} />
      </nav>
      <div className="sidebar-bottom">
        <div className="secure-mini"><ShieldCheck size={16} /><div><strong>Secure workspace</strong><span>Administrator only</span></div></div>
        <div className="user-chip"><div className="avatar">{(session.user.email ?? 'A').slice(0, 1).toUpperCase()}</div><div className="user-meta"><strong>Administrator</strong><span>{session.user.email}</span></div><button className="icon-btn logout" title="Sign out" onClick={signOut}><LogOut size={17} /></button></div>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <button className="icon-btn mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle menu"><Menu size={21} /></button>
        <div className="breadcrumbs"><span>StayManager</span><b>/</b><strong>{tab === 'dashboard' ? 'Dashboard' : tab === 'residents' ? 'Residents' : tab === 'monthly' ? 'Monthly payments' : 'Financial reports'}</strong></div>
        <div className="topbar-right"><div className="live-dot" /> <span>Cloud data connected</span><div className="top-avatar">{(session.user.email ?? 'A').slice(0, 1).toUpperCase()}</div></div>
      </header>

      <div className="page-content">
        {error && <div className="banner-error"><AlertCircle size={17} />{error}<button onClick={() => loadData()} className="text-action">Retry</button></div>}
        {loading ? <div className="page-loading"><div className="loader" /><span>Loading resident records…</span></div> : <>
          {tab === 'dashboard' && <DashboardPage month={selectedMonth} setMonth={setSelectedMonth} rows={rows} registered={registered} empty={empty} working={working} staying={staying} custom={custom} paidCount={paidCount} partialCount={partialCount} pendingCount={pendingCount} overdueCount={overdueCount} collected={collectedThisMonth} outstanding={outstanding} charges={monthlyCharges} lifetime={lifetimeCollected} onResidents={() => changeTab('residents')} onMonthly={() => changeTab('monthly')} refreshing={refreshing} onRefresh={() => loadData(true)} />}
          {tab === 'residents' && <ResidentsPage rows={filteredRows} allRows={rows} query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} editingNo={editingNo} nameDraft={nameDraft} setNameDraft={setNameDraft} startEditName={startEditName} saveName={saveName} cancelEdit={() => { setEditingNo(null); setNameDraft(''); }} openProfile={openProfile} />}
          {tab === 'monthly' && <MonthlyPage month={selectedMonth} setMonth={setSelectedMonth} rows={rows} onOpen={openProfile} onExportExcel={exportExcel} />}
          {tab === 'reports' && <ReportsPage month={selectedMonth} setMonth={setSelectedMonth} rows={rows} collected={collectedThisMonth} outstanding={outstanding} charges={monthlyCharges} lifetime={lifetimeCollected} paidCount={paidCount} pendingCount={pendingCount + overdueCount} onExportExcel={exportExcel} onExportPdf={exportPdf} />}
        </>}
      </div>
    </main>
    {mobileNav && <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}
    {profile && <ProfileModal key={profile.id} row={profile} schedules={schedules} charges={charges} payments={payments.filter(p => p.resident_id === profile.id)} selectedMonth={selectedMonth} onClose={() => setProfile(null)} onSaved={async message => { setProfile(null); await loadData(true); setToast(message); }} />}
    {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
  </div>;
}

function NavButton({ icon, label, count, active, onClick }: { icon: ReactNode; label: string; count?: string; active: boolean; onClick: () => void }) {
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{count && <small>{count}</small>}</button>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function MonthPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <label className="month-picker"><CalendarDays size={16} /><input aria-label="Select month" type="month" value={value.slice(0, 7)} onChange={e => e.target.value && onChange(`${e.target.value}-01`)} /></label>;
}

function DashboardPage(props: {
  month: string; setMonth: (v: string) => void; rows: ResidentRow[]; registered: number; empty: number;
  working: number; staying: number; custom: number; paidCount: number; partialCount: number;
  pendingCount: number; overdueCount: number; collected: number; outstanding: number; charges: number; lifetime: number;
  onResidents: () => void; onMonthly: () => void; refreshing: boolean; onRefresh: () => void;
}) {
  const occupancy = Math.round((props.registered / 100) * 100);
  return <>
    <PageHeading eyebrow="OVERVIEW" title="Dashboard" description="A live overview of your accommodation and monthly finances." action={<div className="heading-actions"><MonthPicker value={props.month} onChange={props.setMonth} /><button className="btn secondary" onClick={props.onRefresh}>{props.refreshing ? 'Refreshing…' : 'Refresh data'}</button></div>} />
    <div className="welcome-strip"><div><span className="welcome-kicker">ACCOMMODATION OVERVIEW</span><h2>Your residents, at a glance.</h2><p>Viewing financial activity for {monthLabel(props.month)}.</p></div><div className="occupancy-box"><div className="occupancy-top"><span>Resident capacity</span><strong>{props.registered}<small> / 100</small></strong></div><div className="progress-track"><span style={{ width: `${occupancy}%` }} /></div><div className="occupancy-foot"><span>{occupancy}% occupied</span><span>{props.empty} available slots</span></div></div></div>
    <div className="section-title-row"><h3>Resident overview</h3><button className="text-action" onClick={props.onResidents}>View all residents <span>→</span></button></div>
    <div className="stats-grid four">
      <StatCard title="Registered residents" value={String(props.registered)} detail={`${props.empty} empty slots`} icon={<Users />} tone="blue" />
      <StatCard title="Working residents" value={String(props.working)} detail="Away for work, belongings kept here" icon={<Activity />} tone="violet" />
      <StatCard title="Staying residents" value={String(props.staying)} detail="Currently staying at accommodation" icon={<Home />} tone="cyan" />
      <StatCard title="Custom-fee residents" value={String(props.custom)} detail="Individually set monthly fees" icon={<ClipboardList />} tone="amber" />
    </div>
    <div className="section-title-row financial-title"><h3>Payment overview</h3><span className="section-subtitle">For {monthLabel(props.month)}</span></div>
    <div className="stats-grid four">
      <StatCard title="Fully paid" value={String(props.paidCount)} detail="Monthly fee settled" icon={<CheckCircle2 />} tone="green" />
      <StatCard title="Partially paid" value={String(props.partialCount)} detail="Payment received, balance left" icon={<Wallet />} tone="amber" />
      <StatCard title="Pending payments" value={String(props.pendingCount)} detail="No payment recorded yet" icon={<AlertCircle />} tone="orange" />
      <StatCard title="Overdue" value={String(props.overdueCount)} detail="Balance remains after due date" icon={<CalendarDays />} tone="red" />
    </div>
    <div className="finance-grid">
      <div className="finance-card primary-finance"><div className="finance-card-top"><span>Total collected this month</span><div className="finance-icon"><Banknote size={19} /></div></div><strong>{euro(props.collected)}</strong><p>Payments recorded with dates in {monthLabel(props.month)}.</p><div className="finance-bottom"><span>All-time recorded payments</span><b>{euro(props.lifetime)}</b></div></div>
      <div className="finance-card"><div className="finance-card-top"><span>Outstanding balance</span><div className="finance-icon warm"><CircleDollarSign size={19} /></div></div><strong>{euro(props.outstanding)}</strong><p>Unpaid amount against {monthLabel(props.month)} charges.</p><button className="text-action" onClick={props.onMonthly}>Open monthly payments →</button></div>
      <div className="finance-card"><div className="finance-card-top"><span>Monthly charges</span><div className="finance-icon blue-light"><FileSpreadsheet size={19} /></div></div><strong>{euro(props.charges)}</strong><p>Total accommodation fees scheduled for the selected month.</p><div className="finance-bottom"><span>Capacity</span><b>100 resident slots</b></div></div>
    </div>
    <div className="dashboard-bottom"><div className="panel-card"><div className="panel-heading"><div><h3>Recent resident status</h3><p>Residents with the highest outstanding balances</p></div><button className="text-action" onClick={props.onMonthly}>Monthly view →</button></div><div className="mini-table">{props.rows.filter(r => r.full_name && r.balance > 0).sort((a,b) => b.balance-a.balance).slice(0,5).map(r => <div className="mini-row" key={r.id}><div className="mini-avatar">{(r.full_name ?? '?').slice(0,1).toUpperCase()}</div><div className="mini-person"><strong>{r.full_name}</strong><span>Resident #{r.resident_no} · Room {r.room_number || '—'}</span></div><div className="mini-balance"><strong>{euro(r.balance)}</strong><StatusPill status={r.status} /></div></div>)}{props.rows.every(r => !r.full_name || r.balance <= 0) && <div className="empty-state small"><CheckCircle2 size={22} /><span>No outstanding balances for this month.</span></div>}</div></div><div className="panel-card quick-card"><div className="panel-heading"><div><h3>Quick actions</h3><p>Common management tasks</p></div></div><button className="quick-action" onClick={props.onResidents}><span className="quick-icon"><Users size={18} /></span><span><b>Manage residents</b><small>Edit names and resident details</small></span><span className="quick-arrow">→</span></button><button className="quick-action" onClick={props.onMonthly}><span className="quick-icon"><Wallet size={18} /></span><span><b>Record a payment</b><small>Open the monthly payment register</small></span><span className="quick-arrow">→</span></button></div></div>
  </>;
}

function StatCard({ title, value, detail, icon, tone }: { title: string; value: string; detail: string; icon: ReactNode; tone: string }) {
  return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><div className="stat-copy"><span>{title}</span><strong>{value}</strong><small>{detail}</small></div></div>;
}

function StatusPill({ status }: { status: ResidentRow['status'] }) {
  const labels: Record<ResidentRow['status'], string> = { paid: 'Paid', partial: 'Partially paid', pending: 'Pending', overdue: 'Overdue', empty: 'Empty' };
  return <span className={`status-pill ${status}`}>{status !== 'empty' && <i />}{labels[status]}</span>;
}

function ResidentsPage(props: {
  rows: ResidentRow[]; allRows: ResidentRow[]; query: string; setQuery: (v: string) => void; filter: FilterType; setFilter: (v: FilterType) => void;
  editingNo: number | null; nameDraft: string; setNameDraft: (v: string) => void; startEditName: (r: ResidentRow) => void;
  saveName: (r: ResidentRow) => void; cancelEdit: () => void; openProfile: (r: ResidentRow) => void;
}) {
  return <>
    <PageHeading eyebrow="RESIDENT DIRECTORY" title="Residents" description="Manage all 100 permanent resident records. Edit names directly from the list or open a full profile." action={<div className="directory-count"><Users size={17} /> <strong>{props.allRows.filter(r => r.full_name).length}</strong> <span>/ 100 registered</span></div>} />
    <div className="panel-card directory-panel">
      <div className="table-toolbar"><div className="search-wrap"><Search size={17} /><input value={props.query} onChange={e => props.setQuery(e.target.value)} placeholder="Search name, resident no., room or contact…" /></div><div className="filter-wrap"><span>Filter:</span><select value={props.filter} onChange={e => props.setFilter(e.target.value as FilterType)}><option value="all">All residents</option><option value="working">Working</option><option value="staying">Staying</option><option value="custom">Custom fee</option><option value="paid">Fully paid</option><option value="partial">Partially paid</option><option value="pending">Pending</option><option value="overdue">Overdue</option></select><ChevronDown size={14} /></div></div>
      <div className="table-meta"><span>Showing <b>{props.rows.length}</b> of 100 numbered slots</span><span>Click a resident row to open their profile</span></div>
      <div className="table-scroll"><table className="data-table resident-table"><thead><tr><th className="number-col">No.</th><th>Resident name</th><th>Room / bed</th><th>Category</th><th>Monthly fee</th><th>Payment status</th><th>Balance</th><th></th></tr></thead><tbody>
        {props.rows.map(row => <tr key={row.id} className={`${row.full_name ? '' : 'empty-row'} ${props.editingNo === row.resident_no ? 'editing-row' : ''}`} onClick={() => row.full_name && props.openProfile(row)}>
          <td className="number-cell">{String(row.resident_no).padStart(2, '0')}</td>
          <td className="name-cell">{props.editingNo === row.resident_no ? <div className="inline-edit" onClick={e => e.stopPropagation()}><input autoFocus value={props.nameDraft} onChange={e => props.setNameDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') props.saveName(row); if (e.key === 'Escape') props.cancelEdit(); }} placeholder="Enter resident name" /><button className="mini-save" onClick={() => props.saveName(row)} title="Save name"><CheckCircle2 size={16} /></button><button className="mini-cancel" onClick={props.cancelEdit} title="Cancel"><X size={16} /></button></div> : <div className="resident-name-wrap"><span className={`resident-name ${row.full_name ? '' : 'empty-name'}`}>{row.full_name || 'Empty slot'}</span><button className="edit-name-btn" title={row.full_name ? 'Edit name' : 'Add resident name'} onClick={e => { e.stopPropagation(); props.startEditName(row); }}><Pencil size={13} /><span>{row.full_name ? 'Edit name' : 'Add name'}</span></button></div>}</td>
          <td className="muted-cell">{row.full_name ? <>{row.room_number || '—'} <small>{row.bed_number ? `· Bed ${row.bed_number}` : ''}</small></> : '—'}</td>
          <td>{row.full_name ? <span className={`category-tag ${row.category}`}>{categoryLabel(row.category)}</span> : '—'}</td>
          <td className="money-cell">{row.full_name ? euro(row.monthlyFee) : '—'}</td>
          <td>{row.full_name ? <StatusPill status={row.status} /> : <span className="empty-dash">—</span>}</td>
          <td className={`money-cell ${row.balance > 0 ? 'balance-due' : ''}`}>{row.full_name ? euro(row.balance) : '—'}</td>
          <td><button className="row-open" title={row.full_name ? 'Open profile' : 'Add resident'} onClick={e => { e.stopPropagation(); if (row.full_name) props.openProfile(row); else props.startEditName(row); }}><span>{row.full_name ? 'View' : 'Add'}</span> <span>→</span></button></td>
        </tr>)}
        {props.rows.length === 0 && <tr><td colSpan={8}><div className="empty-state"><Search size={24} /><b>No matching resident slots</b><span>Try a different search term or filter.</span></div></td></tr>}
      </tbody></table></div>
      <div className="directory-foot"><span><i className="legend-dot filled" /> Registered resident <i className="legend-dot hollow" /> Available slot</span><span>Resident numbers never change when names are edited.</span></div>
    </div>
  </>;
}

function MonthlyPage({ month, setMonth, rows, onOpen, onExportExcel }: { month: string; setMonth: (v: string) => void; rows: ResidentRow[]; onOpen: (r: ResidentRow) => void; onExportExcel: () => void }) {
  const totalCharges = rows.reduce((s,r) => s + (r.full_name ? r.monthlyFee : 0), 0);
  const paid = rows.reduce((s,r) => s + r.paid, 0);
  const balance = rows.reduce((s,r) => s + r.balance, 0);
  return <>
    <PageHeading eyebrow="MONTHLY FINANCIAL CONTROL" title="Monthly payments" description="Review each resident’s fee, recorded payments and remaining balance for a selected month." action={<div className="heading-actions"><MonthPicker value={month} onChange={setMonth} /><button className="btn secondary" onClick={onExportExcel}><ArrowDownToLine size={16} /> Export Excel</button></div>} />
    <div className="monthly-summary"><SummaryMetric label="Total monthly charges" value={euro(totalCharges)} icon={<FileSpreadsheet size={18} />} /><SummaryMetric label="Payments allocated" value={euro(paid)} icon={<Banknote size={18} />} /><SummaryMetric label="Outstanding balance" value={euro(balance)} icon={<CircleDollarSign size={18} />} warn /></div>
    <div className="panel-card directory-panel"><div className="panel-heading month-table-heading"><div><h3>{monthLabel(month)} payment register</h3><p>All 100 resident slots · balances are calculated automatically</p></div><span className="record-count">{rows.filter(r => r.full_name).length} registered</span></div>
      <div className="table-scroll"><table className="data-table monthly-table"><thead><tr><th>No.</th><th>Resident</th><th>Room</th><th>Monthly fee</th><th>Amount paid</th><th>Balance</th><th>Payment date(s)</th><th>Status</th><th></th></tr></thead><tbody>
        {rows.map(row => <tr key={row.id} className={row.full_name ? 'clickable-row' : 'empty-row'} onClick={() => row.full_name && onOpen(row)}><td className="number-cell">{String(row.resident_no).padStart(2,'0')}</td><td><span className={`resident-name ${row.full_name ? '' : 'empty-name'}`}>{row.full_name || 'Empty slot'}</span></td><td className="muted-cell">{row.room_number || '—'}</td><td className="money-cell">{row.full_name ? euro(row.monthlyFee) : '—'}</td><td className="money-cell paid-cell">{row.full_name ? euro(row.paid) : '—'}</td><td className={`money-cell ${row.balance > 0 ? 'balance-due' : ''}`}>{row.full_name ? euro(row.balance) : '—'}</td><td className="date-cell">{row.paymentDates.length ? [...row.paymentDates].sort().join(', ') : '—'}</td><td>{row.full_name ? <StatusPill status={row.status} /> : '—'}</td><td>{row.full_name && <button className="row-open" onClick={e => { e.stopPropagation(); onOpen(row); }}>Details →</button>}</td></tr>)}
      </tbody></table></div>
      <div className="table-note"><AlertCircle size={15} /> A payment is allocated to the month selected when it is recorded. Outstanding balances are fee minus payments allocated to that billing month.</div>
    </div>
  </>;
}

function SummaryMetric({ label, value, icon, warn = false }: { label: string; value: string; icon: ReactNode; warn?: boolean }) {
  return <div className="summary-metric"><div className={`summary-icon ${warn ? 'warn' : ''}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function ReportsPage(props: { month: string; setMonth: (v: string) => void; rows: ResidentRow[]; collected: number; outstanding: number; charges: number; lifetime: number; paidCount: number; pendingCount: number; onExportExcel: () => void; onExportPdf: () => void }) {
  const partialCount = props.rows.filter(r => r.status === 'partial').length;
  const overdueCount = props.rows.filter(r => r.status === 'overdue').length;
  return <>
    <PageHeading eyebrow="FINANCIAL REPORTING" title="Financial reports" description="Monthly accommodation charges, money received and outstanding resident balances." action={<MonthPicker value={props.month} onChange={props.setMonth} />} />
    <div className="report-banner"><div className="report-banner-icon"><FileText size={22} /></div><div><span>REPORT PERIOD</span><h2>{monthLabel(props.month)}</h2><p>Figures below are based on the selected billing month, except collections which use payment dates.</p></div><div className="report-export"><button className="btn secondary" onClick={props.onExportPdf}><FileText size={16} /> Export PDF</button><button className="btn primary" onClick={props.onExportExcel}><FileSpreadsheet size={16} /> Export Excel</button></div></div>
    <div className="report-kpis"><div><span>Collected in selected calendar month</span><strong className="positive">{euro(props.collected)}</strong><small>All recorded payments dated in this month</small></div><div><span>Monthly charges</span><strong>{euro(props.charges)}</strong><small>Fees charged for this billing month</small></div><div><span>Outstanding</span><strong className="negative">{euro(props.outstanding)}</strong><small>Unpaid balance against this month's charges</small></div><div><span>All-time payments received</span><strong>{euro(props.lifetime)}</strong><small>Across all billing periods</small></div></div>
    <div className="report-lower"><div className="panel-card report-breakdown"><div className="panel-heading"><div><h3>Payment status summary</h3><p>Resident counts for {monthLabel(props.month)}</p></div></div><div className="status-breakdown"><div><span className="break-dot paid"/><span>Fully paid</span><b>{props.paidCount}</b></div><div><span className="break-dot partial"/><span>Partially paid</span><b>{partialCount}</b></div><div><span className="break-dot pending"/><span>Pending / overdue</span><b>{props.pendingCount}</b></div><div><span className="break-dot overdue"/><span>Overdue subset</span><b>{overdueCount}</b></div></div></div><div className="panel-card report-breakdown"><div className="panel-heading"><div><h3>Monthly report contents</h3><p>Included in the downloadable files</p></div></div><div className="included-list"><div><CheckCircle2 size={16} /> All 100 permanent resident numbers</div><div><CheckCircle2 size={16} /> Category and monthly fee</div><div><CheckCircle2 size={16} /> Payments, balances and status</div><div><CheckCircle2 size={16} /> Payment dates recorded for this month</div></div></div></div>
    <div className="report-footnote"><ShieldCheck size={16} /> Historical monthly charge snapshots are retained. Fee changes only affect their scheduled effective month and do not rewrite previous reports.</div>
  </>;
}

function ProfileModal({ row, schedules, charges, payments, selectedMonth, onClose, onSaved }: {
  row: ResidentRow; schedules: FeeSchedule[]; charges: MonthlyCharge[]; payments: Payment[]; selectedMonth: string;
  onClose: () => void; onSaved: (message: string) => Promise<void>;
}) {
  const monthSchedule = activeSchedule(schedules, row.id, selectedMonth);
  const currentSchedule = activeSchedule(schedules, row.id, currentMonth());
  const upcomingSchedule = schedules.filter(s => s.resident_id === row.id && s.effective_month > monthDate(currentMonth())).sort((a,b) => a.effective_month.localeCompare(b.effective_month))[0];
  const nextMonthSchedule = upcomingSchedule?.effective_month === firstOfNextMonth() ? upcomingSchedule : currentSchedule;
  const charge = charges.find(c => c.resident_id === row.id);
  const [name, setName] = useState(row.full_name ?? '');
  const [contact, setContact] = useState(row.contact_number ?? '');
  const [room, setRoom] = useState(row.room_number ?? '');
  const [bed, setBed] = useState(row.bed_number ?? '');
  const [notes, setNotes] = useState(row.notes ?? '');
  const [category, setCategory] = useState<Category>(nextMonthSchedule?.category ?? row.category ?? 'staying');
  const [customFee, setCustomFee] = useState(String(nextMonthSchedule?.monthly_fee ?? row.monthlyFee ?? 180));
  const [saving, setSaving] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(dateForInput());
  const [paymentNote, setPaymentNote] = useState('');
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [activeTab, setActiveTab] = useState<'details' | 'payments'>('details');
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const feeValue = feeForCategory(category, Number(customFee));
  const totalAllTime = payments.reduce((s, p) => s + Number(p.amount), 0);
  const thisMonthPayments = payments.filter(p => p.billing_month === monthDate(selectedMonth));
  const thisMonthPaid = thisMonthPayments.reduce((s,p) => s + Number(p.amount), 0);
  const thisMonthBalance = Math.max(0, Number(charge?.monthly_fee ?? 0) - thisMonthPaid);
  const upcoming = upcomingSchedule;

  async function saveDetails(e: FormEvent) {
    e.preventDefault(); setLocalError('');
    if (!name.trim()) { setLocalError('Resident name is required.'); return; }
    if (category === 'custom' && (!customFee.trim() || Number(customFee) < 0 || !Number.isFinite(Number(customFee)))) { setLocalError('Enter a valid custom monthly fee.'); return; }
    setSaving(true);
    try {
      const { error: updateError } = await client!.from('residents').update({
        full_name: name.trim(), contact_number: contact.trim() || null, room_number: room.trim() || null,
        bed_number: bed.trim() || null, notes: notes.trim() || null,
      }).eq('id', row.id);
      if (updateError) throw updateError;
      const nextFee = feeForCategory(category, Number(customFee));
      if (!nextMonthSchedule || nextMonthSchedule.category !== category || Number(nextMonthSchedule.monthly_fee) !== nextFee) {
        const { error: feeError } = await client!.rpc('schedule_staymanager_fee_change', {
          p_resident_id: row.id, p_category: category, p_monthly_fee: nextFee, p_effective_month: firstOfNextMonth(),
        });
        if (feeError) throw feeError;
      }
      await onSaved('Resident details saved. Any category or fee change starts next month.');
    } catch (err: any) { setLocalError(err?.message ?? 'Could not save resident details.'); }
    finally { setSaving(false); }
  }

  async function recordPayment(e: FormEvent) {
    e.preventDefault(); setLocalError('');
    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) { setLocalError('Enter a payment amount greater than €0.'); return; }
    if (!paymentDate) { setLocalError('Choose a payment date.'); return; }
    if (!charge) { setLocalError('There is no generated charge for this resident in the selected month.'); return; }
    setPaymentBusy(true);
    try {
      const { error: paymentError } = await client!.from('payments').insert({
        resident_id: row.id, billing_month: monthDate(selectedMonth), amount,
        payment_date: paymentDate, note: paymentNote.trim() || null,
      });
      if (paymentError) throw paymentError;
      setPaymentAmount(''); setPaymentNote(''); setShowPaymentForm(false);
      await onSaved(`Payment of ${euro(amount)} recorded for ${row.full_name}.`);
    } catch (err: any) { setLocalError(err?.message ?? 'Could not record payment.'); }
    finally { setPaymentBusy(false); }
  }

  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className="profile-modal" role="dialog" aria-modal="true" aria-label={`${row.full_name} resident profile`}>
    <div className="modal-head"><div className="profile-title"><div className="profile-avatar">{(row.full_name ?? '?').slice(0,1).toUpperCase()}</div><div><span>RESIDENT #{String(row.resident_no).padStart(2,'0')}</span><h2>{row.full_name}</h2><p>{row.room_number ? `Room ${row.room_number}` : 'Room not assigned'} {row.bed_number ? `· Bed ${row.bed_number}` : ''}</p></div></div><button className="icon-btn" onClick={onClose} aria-label="Close profile"><X size={20} /></button></div>
    <div className="profile-stats"><div><span>{monthLabel(selectedMonth)} fee</span><strong>{euro(Number(charge?.monthly_fee ?? monthSchedule?.monthly_fee ?? 0))}</strong></div><div><span>Paid this month</span><strong className="positive">{euro(thisMonthPaid)}</strong></div><div><span>Remaining balance</span><strong className={thisMonthBalance > 0 ? 'negative' : 'positive'}>{euro(thisMonthBalance)}</strong></div><div><span>All-time payments</span><strong>{euro(totalAllTime)}</strong></div></div>
    <div className="modal-tabs"><button className={activeTab === 'details' ? 'selected' : ''} onClick={() => { setActiveTab('details'); setLocalError(''); }}>Resident details</button><button className={activeTab === 'payments' ? 'selected' : ''} onClick={() => { setActiveTab('payments'); setLocalError(''); }}>Payment history <span>{payments.length}</span></button></div>
    {localError && <div className="error-inline modal-error"><AlertCircle size={15} />{localError}</div>}
    {activeTab === 'details' ? <form className="modal-body" onSubmit={saveDetails}>
      <div className="form-grid"><label className="span-two">Full name<input required value={name} onChange={e => setName(e.target.value)} placeholder="Resident full name" /></label><label>Contact number<input value={contact} onChange={e => setContact(e.target.value)} placeholder="+39…" /></label><label>Room number<input value={room} onChange={e => setRoom(e.target.value)} placeholder="e.g. 12" /></label><label>Bed number<input value={bed} onChange={e => setBed(e.target.value)} placeholder="e.g. B" /></label><label>Resident number<input value={String(row.resident_no)} disabled /></label>
        <div className="span-two form-divider"><span>ACCOMMODATION CATEGORY</span><small>Changes take effect from {new Date(`${firstOfNextMonth()}T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}.</small></div>
        <label>Category<select value={category} onChange={e => setCategory(e.target.value as Category)}><option value="working">Working · €70 / month</option><option value="staying">Staying · €180 / month</option><option value="custom">Custom fee</option></select></label>
        <label>Monthly fee (€)<input type="number" min="0" step="0.01" value={category === 'working' ? '70.00' : category === 'staying' ? '180.00' : customFee} disabled={category !== 'custom'} onChange={e => setCustomFee(e.target.value)} /></label>
        {upcoming && <div className="span-two upcoming-note"><CalendarDays size={16} /><span>Upcoming scheduled rate: <b>{categoryLabel(upcoming.category)} · {euro(Number(upcoming.monthly_fee))}</b> from {monthLabel(upcoming.effective_month)}.</span></div>}
        <label className="span-two">Additional notes<textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional information…" /></label>
      </div>
      <div className="modal-footer"><span className="helper-text">Resident number and historic payments are preserved.</span><button type="button" className="btn secondary" onClick={onClose}>Close</button><button className="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save details'}</button></div>
    </form> : <div className="modal-body payment-history-body">
      <div className="history-action-row"><div><h3>Payments received</h3><p>Records are kept as an audit history and cannot be silently overwritten.</p></div><button className="btn primary" onClick={() => { setShowPaymentForm(!showPaymentForm); setLocalError(''); }}><Plus size={16} /> Record payment</button></div>
      {showPaymentForm && <form className="payment-entry-form" onSubmit={recordPayment}><div className="payment-entry-heading"><b>New payment · {monthLabel(selectedMonth)}</b><span>Allocated to the selected billing month</span></div><div className="payment-entry-fields"><label>Amount (€)<input required type="number" min="0.01" step="0.01" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} placeholder="0.00" /></label><label>Payment date<input required type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} /></label><label className="note-field">Note (optional)<input value={paymentNote} onChange={e => setPaymentNote(e.target.value)} placeholder="Cash, bank transfer, reference…" /></label><button className="btn primary" disabled={paymentBusy}>{paymentBusy ? 'Recording…' : 'Save payment'}</button></div></form>}
      {payments.length ? <div className="history-table-wrap"><table className="data-table history-table"><thead><tr><th>Payment date</th><th>Billing month</th><th>Note</th><th>Amount</th></tr></thead><tbody>{[...payments].sort((a,b) => b.payment_date.localeCompare(a.payment_date)).map(p => <tr key={p.id}><td>{new Date(`${p.payment_date}T00:00:00`).toLocaleDateString('en-GB')}</td><td>{monthLabel(p.billing_month)}</td><td>{p.note || '—'}</td><td className="money-cell paid-cell">{euro(Number(p.amount))}</td></tr>)}</tbody></table></div> : <div className="empty-state"><Wallet size={24} /><b>No payments recorded</b><span>Recorded payments will appear here.</span></div>}
      <div className="history-total"><span>Total received across all months</span><b>{euro(totalAllTime)}</b></div>
      <div className="modal-footer"><span className="helper-text">Payments are permanent ledger entries.</span><button type="button" className="btn secondary" onClick={onClose}>Close</button></div>
    </div>}
  </section></div>;
}

export default App;
