import React, { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  NavLink,
  Link,
  useNavigate,
  useParams,
  useLocation,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  LayoutDashboard,
  ListChecks,
  BarChart3,
  Inbox,
  FlaskConical,
  LogOut,
  Plus,
  Search,
  ShieldCheck,
  Activity,
  Building2,
  Landmark,
  AlertCircle,
  X,
  RefreshCw,
  Upload,
  Loader2,
  LockKeyhole,
  Layers,
  ExternalLink,
} from 'lucide-react';
import {
  APP_STATUSES,
  DOC_TYPES,
  documentFields,
  formSchema,
  type Form,
  type DocType,
  type User,
} from '../../../packages/shared/src/index.js';
import { uniqueDemoForm, demoForm, demoDocuments } from '../../../packages/shared/src/demo.js';
import { api, session, viewDocument, ApiError } from './api.js';
import './styles.css';

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});
const label = (s: string) =>
  s
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
const date = (s: string) =>
  new Date(s).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
const duration = (s: number) =>
  s < 60
    ? `${Math.round(s)}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m`
      : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
function Badge({ status }: { status: string }) {
  const good = [
      'PASSED',
      'ACTIVATED',
      'MATCH',
      'RESOLVED',
      'COMPLETED',
      'APPLIED',
      'FULFILLED',
    ].includes(status),
    bad = ['FAILED', 'REJECTED', 'ERROR', 'DEAD', 'CONFLICT', 'PROVISIONING_FAILED'].includes(
      status,
    ),
    warn = [
      'BLOCKED',
      'WRONG_DOCUMENT_TYPE',
      'NEEDS_INFO',
      'IN_REVIEW',
      'TIMED_OUT',
      'LOW_CONFIDENCE',
      'LATE',
      'STALE',
      'UNREADABLE',
      'OPEN',
    ].includes(status);
  return (
    <span
      className={`badge ${good ? 'green' : bad ? 'red' : warn ? 'amber' : ['PENDING', 'DRAFT', 'SUPERSEDED'].includes(status) ? 'gray' : 'blue'}`}
    >
      <span className="status-dot" />
      {label(status)}
    </span>
  );
}
function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="error" role="alert">
      <AlertCircle size={17} />
      <div>
        {e.message ?? 'Something went wrong.'}
        {e.details?.unmet && (
          <ul>
            {e.details.unmet.map((x: any, i: number) => (
              <li key={i}>
                {label(x.kind)} {x.check_type}
              </li>
            ))}
          </ul>
        )}
        {Array.isArray(e.details) && (
          <ul>
            {e.details.map((x: any, i: number) => (
              <li key={i}>
                {x.path}: {x.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
function Loading() {
  return (
    <div className="loading">
      <Loader2 className="spin" size={22} /> Loading workspace…
    </div>
  );
}
function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Inbox size={30} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}
function PageTitle({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}
function Stat({
  title,
  value,
  icon: Icon,
  note,
}: {
  title: string;
  value: ReactNode;
  icon: typeof Activity;
  note: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {title}
        <Icon size={18} />
      </div>
      <strong>{value}</strong>
      <span>{note}</span>
    </div>
  );
}
function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('merchant@onboard.demo'),
    [password, setPassword] = useState('DemoPass123!'),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      sessionStorage.setItem('onboard.session', JSON.stringify(result));
      client.clear();
      navigate(result.user.role === 'OPERATOR' ? '/ops/applications' : '/merchant/applications');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <div className="login-story">
        <Link className="brand" to="/login">
          <span className="brand-mark">
            <Layers size={23} />
          </span>
          onboard<span className="brand-dot">.</span>
        </Link>
        <div>
          <span className="pill">MERCHANT OPERATIONS, REIMAGINED</span>
          <h1>
            A clear path from
            <br />
            application to
            <br />
            <em>activation.</em>
          </h1>
          <p>
            Intelligent document extraction. Resilient verification.
            <br />
            Human judgement where it matters.
          </p>
          <div className="login-steps">
            {['Collect', 'Verify', 'Activate'].map((s, i) => (
              <React.Fragment key={s}>
                <span>
                  <b>{i + 1}</b>
                  {s}
                </span>
                {i < 2 && <ArrowRight size={18} />}
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="login-foot">
          <ShieldCheck size={17} /> Built for clarity. Every decision has a trail.
        </div>
      </div>
      <div className="login-panel">
        <form onSubmit={login}>
          <div className="eyebrow">WELCOME TO ONBOARD</div>
          <h2>Your workspace awaits.</h2>
          <p>Sign in to manage your onboarding journey.</p>
          <ErrorBox error={error} />
          <label>
            Email address
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <button className="primary full" disabled={busy}>
            {busy ? (
              <Loader2 className="spin" size={17} />
            ) : (
              <>
                Sign in <ArrowRight size={17} />
              </>
            )}
          </button>
          <div className="demo-divider">EXPLORE THE DEMO</div>
          <div className="demo-roles">
            <button
              type="button"
              onClick={() => {
                setEmail('merchant@onboard.demo');
                setPassword('DemoPass123!');
              }}
            >
              <Building2 size={20} />
              <span>
                Merchant<small>Submit & track</small>
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setEmail('operator@onboard.demo');
                setPassword('DemoPass123!');
              }}
            >
              <ShieldCheck size={20} />
              <span>
                Operator<small>Review & manage</small>
              </span>
            </button>
          </div>
          <p className="fine-print">Demo workspace · Synthetic data only</p>
        </form>
      </div>
    </div>
  );
}
function Shell() {
  const auth = session(),
    navigate = useNavigate(),
    location = useLocation();
  if (!auth) return <Navigate to="/login" replace />;
  const ops = auth.user.role === 'OPERATOR',
    base = ops ? '/ops' : '/merchant';
  if (!location.pathname.startsWith(base)) return <Navigate to={`${base}/applications`} replace />;
  const nav = ops
    ? ([
        ['Applications', 'applications', LayoutDashboard],
        ['Review queue', 'review', ListChecks],
        ['Metrics', 'metrics', BarChart3],
        ['Dead letters', 'dead-letters', Inbox],
      ] as const)
    : ([['My applications', 'applications', LayoutDashboard]] as const);
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to={`${base}/applications`} className="brand">
          <span className="brand-mark">
            <Layers size={22} />
          </span>
          onboard<span className="brand-dot">.</span>
        </Link>
        <div className="workspace-label">{ops ? 'OPERATIONS WORKSPACE' : 'MERCHANT WORKSPACE'}</div>
        <nav>
          {nav.map(([name, route, Icon]) => (
            <NavLink key={route} to={`${base}/${route}`}>
              <Icon size={19} />
              {name}
              {route === 'applications' && <span className="nav-shortcut">⌘ 1</span>}
            </NavLink>
          ))}
        </nav>
        {ops && (
          <>
            <div className="workspace-label tools-label">DEMO TOOLS</div>
            <nav>
              <NavLink to="/ops/simulator">
                <FlaskConical size={19} />
                Provider simulator
              </NavLink>
            </nav>
          </>
        )}
        <div className="sidebar-bottom">
          <div className="system-status">
            <span />
            Demo environment<small>Simulated providers · Real workflow</small>
          </div>
          <button
            className="user-card"
            onClick={() => {
              sessionStorage.removeItem('onboard.session');
              client.clear();
              navigate('/login');
            }}
          >
            <span className="avatar">
              {auth.user.display_name
                .split(' ')
                .map((s) => s[0])
                .slice(0, 2)
                .join('')}
            </span>
            <span>
              {auth.user.display_name}
              <small>{label(auth.user.role)}</small>
            </span>
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span>
            Workspace <ChevronRight size={14} />{' '}
            <b>{ops ? 'Merchant operations' : 'Merchant portal'}</b>
          </span>
          <div>
            <span className="environment">SANDBOX</span>
            <span className="top-avatar">{ops ? 'OP' : 'ME'}</span>
          </div>
        </header>
        <main>
          <Routes>
            <Route path="applications" element={<ApplicationList user={auth.user} />} />
            <Route
              path="applications/new"
              element={ops ? <Navigate to="../applications" /> : <Wizard />}
            />
            <Route path="applications/:id" element={<Detail user={auth.user} />} />
            {ops && (
              <>
                <Route path="review" element={<ReviewQueue />} />
                <Route path="metrics" element={<Metrics />} />
                <Route path="dead-letters" element={<DeadLetters />} />
                <Route path="simulator" element={<Simulator />} />
              </>
            )}
            <Route path="*" element={<Navigate to={`${base}/applications`} replace />} />
          </Routes>
        </main>
        <footer>
          ONBOARD <span>Every step accounted for.</span>
          <span>Local demo · Synthetic data</span>
        </footer>
      </div>
    </div>
  );
}
function ApplicationList({ user }: { user: User }) {
  const ops = user.role === 'OPERATOR',
    base = ops ? '/ops' : '/merchant';
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState(''),
    [exceptions, setExceptions] = useState(false),
    [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['applications', search, status, exceptions, page],
    queryFn: () =>
      api(
        `/applications?${new URLSearchParams({ q: search, ...(status ? { status } : {}), ...(exceptions ? { has_open_exceptions: 'true' } : {}), page: String(page) })}`,
      ),
    refetchInterval: 2000,
  });
  const metrics = useQuery({
    queryKey: ['metrics'],
    queryFn: () => api('/metrics/summary'),
    enabled: ops,
    refetchInterval: 5000,
  });
  const m = metrics.data;
  return (
    <>
      <PageTitle
        eyebrow={ops ? 'OVERVIEW' : 'YOUR BUSINESS JOURNEY'}
        title={ops ? 'Merchant applications' : 'My applications'}
        description={
          ops
            ? 'A single view of every merchant, from first submission to activation.'
            : 'Track your progress and take the next step toward accepting payments.'
        }
      >
        {!ops && (
          <Link className="button primary" to={`${base}/applications/new`}>
            <Plus size={17} />
            New application
          </Link>
        )}
        <span className="live">
          <span />
          Live updates
        </span>
      </PageTitle>
      {ops ? (
        <>
          <ErrorBox error={metrics.error} />
          <div className="stats">
            <Stat
              title="Applications"
              value={
                m
                  ? Object.values(m.counts_by_status).reduce((n: number, v) => n + Number(v), 0)
                  : '—'
              }
              icon={FileText}
              note="Created in the last 24 hours"
            />
            <Stat
              title="Activated merchants"
              value={m ? (m.counts_by_status.ACTIVATED ?? 0) : '—'}
              icon={CheckCircle2}
              note="Ready to accept payments"
            />
            <Stat
              title="Needs review"
              value={m?.review_queue.size ?? '—'}
              icon={ListChecks}
              note="Waiting for a human decision"
            />
            <Stat
              title="Straight-through rate"
              value={m ? `${Math.round(m.straight_through_rate * 100)}%` : '—'}
              icon={Activity}
              note="Approved without intervention"
            />
          </div>
        </>
      ) : (
        <div className="intro-banner">
          <div className="intro-icon">
            <ShieldCheck size={28} />
          </div>
          <div>
            <h3>Your business. Ready for what’s next.</h3>
            <p>Submit your details once. We’ll keep you informed at every step.</p>
          </div>
          <span>SECURE & AUDITABLE</span>
        </div>
      )}
      <section className="panel">
        <div className="panel-title">
          <h2>
            {ops ? 'All applications' : 'Your applications'}{' '}
            <span className="count">{query.data?.total ?? 0}</span>
          </h2>
          <button
            className="icon-button"
            aria-label="Refresh applications"
            onClick={() => query.refetch()}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        <div className="filters">
          <div className="search">
            <Search size={17} />
            <input
              aria-label="Search applications"
              placeholder="Search by business name or reference…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <select
            aria-label="Filter status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {APP_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
          {ops && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={exceptions}
                onChange={(e) => {
                  setExceptions(e.target.checked);
                  setPage(1);
                }}
              />
              Open exceptions
            </label>
          )}
        </div>
        <ErrorBox error={query.error} />
        {query.isPending ? (
          <Loading />
        ) : !query.data?.items.length ? (
          <Empty title="No applications found">
            <p>
              {search || status
                ? 'Try adjusting your filters.'
                : 'Create an application to get started.'}
            </p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>BUSINESS / REFERENCE</th>
                  <th>STATUS</th>
                  {ops && <th>EXCEPTIONS</th>}
                  <th>TIME IN STATE</th>
                  <th>LAST UPDATED</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((a: any) => (
                  <tr key={a.id}>
                    <td>
                      <Link className="business-cell" to={`${base}/applications/${a.id}`}>
                        <span className="business-icon">
                          <Building2 size={18} />
                        </span>
                        <span>
                          <b>{a.legal_name}</b>
                          <small className="mono">{a.reference}</small>
                        </span>
                      </Link>
                    </td>
                    <td>
                      <Badge status={a.status} />
                    </td>
                    {ops && (
                      <td>
                        {a.open_exceptions ? (
                          <span className="exception-count">{a.open_exceptions} open</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    )}
                    <td className="muted">
                      <Clock3 size={13} className="inline-icon" />
                      {duration((Date.now() - new Date(a.status_changed_at).getTime()) / 1000)}
                    </td>
                    <td className="muted">{date(a.status_changed_at)}</td>
                    <td>
                      <Link aria-label={`Open ${a.reference}`} to={`${base}/applications/${a.id}`}>
                        <ChevronRight size={18} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer">
          <span>{query.data?.total ?? 0} applications · Updated automatically</span>
          <div>
            <button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>{page}</span>
            <button
              disabled={page * 20 >= (query.data?.total ?? 0)}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </section>
      <div className="trust-note">
        <LockKeyhole size={14} />
        Sensitive identifiers are encrypted at rest and masked throughout the workspace.
      </div>
    </>
  );
}
type DocumentInput = { mode: 'structured' | 'file'; fields: Record<string, string>; file?: File };
function Field({
  name,
  value,
  onChange,
  required = false,
  type = 'text',
  hint,
}: {
  name: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  hint?: string;
}) {
  return (
    <label>
      {name}
      {required && <span className="required"> *</span>}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}
function DocumentEditor({
  type,
  value,
  onChange,
}: {
  type: DocType;
  value: DocumentInput;
  onChange: (v: DocumentInput) => void;
}) {
  return (
    <div className="document-editor">
      <div className="document-title">
        <FileText size={20} />
        <h3>{label(type)}</h3>
        <select
          aria-label={`${label(type)} input mode`}
          value={value.mode}
          onChange={(e) => onChange({ ...value, mode: e.target.value as any })}
        >
          <option value="structured">Structured demo evidence</option>
          <option value="file">Upload document</option>
        </select>
      </div>
      {value.mode === 'file' ? (
        <label className="upload-area">
          <Upload size={23} />
          <b>{value.file?.name ?? 'Choose a document'}</b>
          <span>PDF, PNG or JPEG · Up to 5 MB</span>
          <input
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            onChange={(e) => onChange({ ...value, file: e.target.files?.[0] })}
          />
        </label>
      ) : (
        <div className="form-grid">
          {documentFields[type].map((key) => (
            <Field
              key={key}
              name={label(key)}
              value={value.fields[key] ?? ''}
              onChange={(v) => onChange({ ...value, fields: { ...value.fields, [key]: v } })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
async function sendDocument(id: string, type: DocType, doc: DocumentInput) {
  if (doc.mode === 'file') {
    if (!doc.file) throw new Error(`Choose a file for ${label(type)}`);
    if (doc.file.size > 5 * 1024 * 1024) throw new Error('Documents must be at most 5 MB');
    const body = new FormData();
    body.append('doc_type', type);
    body.append('file', doc.file);
    return api(`/applications/${id}/documents`, { method: 'POST', body });
  }
  return api(`/applications/${id}/documents`, {
    method: 'POST',
    body: JSON.stringify({ doc_type: type, structured_payload: doc.fields }),
  });
}
function Wizard() {
  const navigate = useNavigate();
  const extraction = useQuery({
    queryKey: ['extraction-status'],
    queryFn: () => api('/extraction/status'),
    refetchInterval: 10000,
  });
  const [creationKey] = useState(() => crypto.randomUUID());
  const [step, setStep] = useState(0),
    [form, setForm] = useState<Form>({
      legal_name: '',
      contact_email: '',
      business_type: 'PRIVATE_LIMITED',
    }),
    [docs, setDocs] = useState<Record<DocType, DocumentInput>>({
      PAN_CARD: { mode: 'file', fields: {} },
      GST_CERTIFICATE: { mode: 'file', fields: {} },
      BANK_PROOF: { mode: 'file', fields: {} },
    }),
    [id, setId] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const change = (key: keyof Form, value: any) => setForm((f) => ({ ...f, [key]: value }));
  const bank = form.bank_account ?? { account_number: '', ifsc: '', account_holder_name: '' };
  async function save(submitNow = false) {
    setBusy(true);
    setError(null);
    try {
      const parsed = formSchema.parse(form);
      let appId = id;
      if (!appId) {
        const a = await api('/applications', {
          method: 'POST',
          headers: { 'idempotency-key': creationKey },
          body: JSON.stringify(parsed),
        });
        appId = a.id;
        setId(appId);
      } else await api(`/applications/${appId}`, { method: 'PATCH', body: JSON.stringify(parsed) });
      for (const type of DOC_TYPES) {
        const doc = docs[type];
        const supplied =
          doc.mode === 'file'
            ? !!doc.file
            : Object.values(doc.fields).some((value) => value.trim().length > 0);
        if (submitNow || supplied) await sendDocument(appId!, type, doc);
      }
      if (submitNow) await api(`/applications/${appId}/submit`, { method: 'POST' });
      await client.invalidateQueries();
      navigate(`/merchant/applications/${appId}`);
    } catch (e: any) {
      setError(
        e.issues
          ? new Error(e.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; '))
          : e,
      );
    } finally {
      setBusy(false);
    }
  }
  function fillDemo() {
    const f = uniqueDemoForm();
    setForm(f);
    setDocs(
      Object.fromEntries(
        Object.entries(demoDocuments(f)).map(([k, v]) => [k, { mode: 'structured', fields: v }]),
      ) as any,
    );
  }
  const steps = ['Business details', 'Tax identity', 'Bank account', 'Documents', 'Review'];
  return (
    <>
      <Link className="back-link" to="/merchant/applications">
        <ArrowLeft size={15} />
        Applications
      </Link>
      <PageTitle
        eyebrow="LET’S GET YOU STARTED"
        title="New merchant application"
        description="A few details today. A new way to get paid tomorrow."
      >
        <button onClick={fillDemo}>
          <FlaskConical size={16} />
          Fill synthetic sample
        </button>
        <button
          onClick={() => {
            setForm(demoForm());
            setDocs(
              Object.fromEntries(
                DOC_TYPES.map((type) => [type, { mode: 'file', fields: {} }]),
              ) as Record<DocType, DocumentInput>,
            );
          }}
        >
          Use PDF sample details
        </button>
      </PageTitle>
      <div className="notice">
        <span>
          {extraction.data?.engine === 'local'
            ? `Live local document reading: ${extraction.data.model}. PDF, PNG and JPEG supported; PDFs up to 3 pages. ${extraction.data.ready ? 'Model ready.' : 'Model unavailable. Start the local AI service before uploading.'}`
            : extraction.data?.engine === 'llm'
              ? 'Live Claude document reading.'
              : extraction.data
                ? 'Offline fixture mode: only supplied sample PDFs can be read.'
                : 'Checking document reader…'}{' '}
          Government and bank verification are simulated.
        </span>
      </div>
      <div className="notice sample-downloads">
        <span>
          Synthetic upload samples:{' '}
          {DOC_TYPES.map((type) => (
            <a key={type} href={`/samples/${type.toLowerCase()}.pdf`} download>
              {label(type)} PDF
            </a>
          ))}
          . Use “Use PDF sample details” to fill matching details, then select these files under
          Documents. Reusing these identifiers may trigger duplicate review.
        </span>
      </div>
      <div className="wizard-layout">
        <aside className="wizard-steps">
          {steps.map((s, i) => (
            <button
              key={s}
              className={i === step ? 'current' : i < step ? 'complete' : ''}
              onClick={() => setStep(i)}
            >
              <span>{i < step ? <Check size={16} /> : i + 1}</span>
              <div>
                {s}
                <small>
                  {
                    [
                      'Tell us about your business',
                      'PAN and GST registration',
                      'Your settlement account',
                      'Evidence for verification',
                      'Confirm and submit',
                    ][i]
                  }
                </small>
              </div>
            </button>
          ))}
          <div className="wizard-assurance">
            <ShieldCheck size={24} />
            <p>Your information is encrypted and only accessible to authorized reviewers.</p>
          </div>
        </aside>
        <section className="panel wizard-form">
          <div className="eyebrow">STEP {step + 1} OF 5</div>
          <h2>{steps[step]}</h2>
          <p className="muted">
            {step === 3
              ? 'Use synthetic files or enter the fields printed on each document.'
              : 'Please enter details as they appear on your official documents.'}
          </p>
          <ErrorBox error={error} />
          {step === 0 && (
            <div className="form-grid">
              <Field
                name="Legal business name"
                value={form.legal_name}
                onChange={(v) => change('legal_name', v)}
                required
              />
              <Field
                name="Trade name"
                value={form.trade_name ?? ''}
                onChange={(v) => change('trade_name', v)}
              />
              <label>
                Business type
                <select
                  value={form.business_type}
                  onChange={(e) => change('business_type', e.target.value)}
                >
                  {[
                    'PROPRIETORSHIP',
                    'PARTNERSHIP',
                    'LLP',
                    'PRIVATE_LIMITED',
                    'PUBLIC_LIMITED',
                  ].map((v) => (
                    <option key={v} value={v}>
                      {label(v)}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                name="Business category"
                value={form.business_category ?? ''}
                onChange={(v) => change('business_category', v)}
              />
              <Field
                name="Contact email"
                type="email"
                value={form.contact_email}
                onChange={(v) => change('contact_email', v)}
                required
              />
              <Field
                name="Phone"
                value={form.contact_phone ?? ''}
                onChange={(v) => change('contact_phone', v)}
              />
              <Field
                name="Address"
                value={form.address_line ?? ''}
                onChange={(v) => change('address_line', v)}
              />
              <Field name="City" value={form.city ?? ''} onChange={(v) => change('city', v)} />
              <Field name="State" value={form.state ?? ''} onChange={(v) => change('state', v)} />
              <Field
                name="Pincode"
                value={form.pincode ?? ''}
                onChange={(v) => change('pincode', v)}
              />
            </div>
          )}
          {step === 1 && (
            <div className="form-grid">
              <Field
                name="PAN"
                value={form.pan ?? ''}
                onChange={(v) => change('pan', v.toUpperCase())}
                required
                hint="10-character business PAN"
              />
              <Field
                name="GSTIN"
                value={form.gstin ?? ''}
                onChange={(v) => change('gstin', v.toUpperCase())}
                required
                hint="15-character GST registration number"
              />
            </div>
          )}
          {step === 2 && (
            <div className="form-grid">
              <Field
                name="Account number"
                value={bank.account_number}
                onChange={(v) => change('bank_account', { ...bank, account_number: v })}
                required
              />
              <Field
                name="IFSC"
                value={bank.ifsc}
                onChange={(v) => change('bank_account', { ...bank, ifsc: v.toUpperCase() })}
                required
              />
              <Field
                name="Account holder name"
                value={bank.account_holder_name}
                onChange={(v) => change('bank_account', { ...bank, account_holder_name: v })}
                required
              />
            </div>
          )}
          {step === 3 &&
            DOC_TYPES.map((type) => (
              <DocumentEditor
                key={type}
                type={type}
                value={docs[type]}
                onChange={(value) => setDocs((d) => ({ ...d, [type]: value }))}
              />
            ))}
          {step === 4 && (
            <>
              <div className="review-summary">
                <h3>{form.legal_name || 'Business name required'}</h3>
                <p>{form.contact_email}</p>
                <div className="key-values">
                  <span>
                    Business type<b>{label(form.business_type ?? 'NOT_SET')}</b>
                  </span>
                  <span>
                    PAN<b className="mono">{form.pan}</b>
                  </span>
                  <span>
                    GSTIN<b className="mono">{form.gstin}</b>
                  </span>
                  <span>
                    Bank account<b className="mono">{bank.account_number}</b>
                  </span>
                </div>
              </div>
              <div className="notice">
                <ShieldCheck size={20} />
                <span>
                  Submission starts document validation and four verification checks. You can follow
                  every step from your application tracker.
                </span>
              </div>
            </>
          )}
          <div className="wizard-actions">
            <button disabled={busy} onClick={() => save(false)}>
              Save draft
            </button>
            <div>
              {step > 0 && <button onClick={() => setStep(step - 1)}>Back</button>}
              {step < 4 ? (
                <button className="primary" onClick={() => setStep(step + 1)}>
                  Continue
                  <ArrowRight size={16} />
                </button>
              ) : (
                <button className="primary" disabled={busy} onClick={() => save(true)}>
                  {busy ? (
                    <Loader2 className="spin" size={17} />
                  ) : (
                    <>
                      Submit application
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function CheckCards({ checks, blockedReason }: { checks: any[]; blockedReason?: string }) {
  return (
    <div className="check-grid">
      {['PAN', 'GST', 'BANK', 'RISK'].map((type) => {
        const c = checks.find((c) => c.check_type === type),
          Icon = type === 'BANK' ? Landmark : type === 'RISK' ? ShieldCheck : FileText;
        const blocked = blockedReason && (!c || c.status === 'PENDING');
        return (
          <div className="check-card" key={type}>
            <div>
              <span className="check-icon">
                <Icon size={20} />
              </span>
              <Badge status={blocked ? 'BLOCKED' : (c?.status ?? 'PENDING')} />
            </div>
            <h3>
              {type === 'BANK'
                ? 'Bank account'
                : type === 'RISK'
                  ? 'Risk assessment'
                  : `${type} verification`}
            </h3>
            <p>
              {blocked
                ? blockedReason
                : c?.reason_code
                  ? label(c.reason_code)
                  : c?.blocked_by?.length
                    ? `Waiting for ${c.blocked_by.join(', ')}`
                    : c?.status === 'PASSED'
                      ? 'Verified successfully'
                      : c?.status === 'IN_PROGRESS'
                        ? 'Awaiting provider response'
                        : 'Ready when prerequisites pass'}
            </p>
            <small>
              {c?.attempts.length ?? 0} attempt{c?.attempts.length === 1 ? '' : 's'}
            </small>
          </div>
        );
      })}
    </div>
  );
}
function Detail({ user }: { user: User }) {
  const { id } = useParams();
  const [tab, setTab] = useState('Overview'),
    [action, setAction] = useState<string>(),
    [error, setError] = useState<unknown>();
  const ops = user.role === 'OPERATOR';
  const q = useQuery({
    queryKey: ['application', id],
    queryFn: () => api(`/applications/${id}`),
    refetchInterval: 2000,
  });
  const timeline = useQuery({
    queryKey: ['timeline', id],
    queryFn: () => api(`/applications/${id}/timeline`),
    refetchInterval: 2000,
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const a = q.data,
    open = a.exceptions.filter((e: any) => e.status === 'OPEN');
  const tabs = ['Overview', 'Fields & documents', 'Checks', 'Exceptions', 'Timeline'];
  const names: Record<string, string> = {
    APPROVE: 'Approve application',
    REJECT: 'Reject',
    REQUEST_INFO: 'Request information',
    RETRY_PROVISIONING: 'Retry provisioning',
    REPROCESS: 'Reprocess documents',
    CHANGE_BANK: 'Change bank details',
    EDIT: 'Update application',
  };
  const documentProblem = a.documents.some((d: any) =>
    ['FAILED', 'NEEDS_INFO'].includes(d.document_status),
  );
  const blockedReason = documentProblem
    ? 'Blocked until document issues are resolved.'
    : ['SUBMITTED', 'EXTRACTING'].includes(a.status)
      ? 'Waiting for document extraction and validation.'
      : a.status === 'NEEDS_INFO'
        ? 'Blocked until the requested information is provided.'
        : undefined;
  const stage = documentProblem
    ? 2
    : ['DRAFT', 'SUBMITTED', 'EXTRACTING', 'NEEDS_INFO'].includes(a.status)
      ? a.status === 'DRAFT'
        ? 0
        : a.status === 'SUBMITTED'
          ? 1
          : 2
      : a.status === 'VERIFYING'
        ? 3
        : ['IN_REVIEW', 'REJECTED'].includes(a.status)
          ? 4
          : 5;
  return (
    <>
      <Link className="back-link" to={ops ? '/ops/applications' : '/merchant/applications'}>
        <ArrowLeft size={15} />
        All applications
      </Link>
      <PageTitle
        eyebrow={a.reference}
        title={a.legal_name}
        description={`Submitted application · Updated ${date(a.status_changed_at)}`}
      >
        <Badge status={a.status} />
        <span className="live">
          <span />
          Live
        </span>
      </PageTitle>
      <ErrorBox error={error} />
      <div className="detail-actions">
        <span>
          <Clock3 size={15} />
          {duration((Date.now() - new Date(a.status_changed_at).getTime()) / 1000)} in current state
        </span>
        <div>
          {a.allowed_actions
            .filter((x: string) => !['UPLOAD', 'SUBMIT'].includes(x))
            .map((x: string) => (
              <button
                className={x === 'APPROVE' ? 'primary' : x === 'REJECT' ? 'danger-quiet' : ''}
                key={x}
                onClick={() => setAction(x)}
              >
                {names[x] ?? `Re-run ${x.split(':')[1]}`}
              </button>
            ))}
        </div>
      </div>
      {a.merchant && (
        <div className="activation-banner">
          <CheckCircle2 size={30} />
          <div>
            <h3>You’re ready to accept payments.</h3>
            <p>
              Merchant ID{' '}
              <strong className="mono" data-testid="merchant-id">
                {a.merchant.merchant_id}
              </strong>
            </p>
          </div>
          <span>{a.merchant.capabilities.join(' · ')}</span>
        </div>
      )}
      {a.status === 'PROVISIONING_FAILED' && (
        <div className="notice warning">
          <AlertCircle size={22} />
          <div>
            <b>Approved. Activation needs another attempt.</b>
            <p>
              The merchant system exhausted its retries. The approval remains valid; an operator can
              retry provisioning.
            </p>
          </div>
        </div>
      )}
      {a.info_requests
        .filter((r: any) => r.status === 'OPEN')
        .map((r: any) => (
          <div className="notice warning" key={r.id}>
            <AlertCircle size={23} />
            <div>
              <b>A little more information is needed</b>
              <ul>
                {r.items.map((i: any, n: number) => (
                  <li key={n}>{i.message}</li>
                ))}
              </ul>
              {!ops && (
                <button onClick={() => setAction('EDIT')}>
                  Update details & documents
                  <ArrowRight size={15} />
                </button>
              )}
            </div>
          </div>
        ))}
      {!ops && (
        <div className="tracker">
          {['Draft', 'Submitted', 'Documents', 'Verification', 'Decision', 'Activation'].map(
            (s, i) => (
              <div key={s} className={i <= stage ? 'done' : ''}>
                <span>
                  {i === 2 && documentProblem ? (
                    <AlertCircle size={15} />
                  ) : i < stage ? (
                    <Check size={15} />
                  ) : (
                    i + 1
                  )}
                </span>
                {s}
              </div>
            ),
          )}
        </div>
      )}
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'active' : ''}
            key={t}
            onClick={() => setTab(t)}
          >
            {t}
            {t === 'Exceptions' && open.length > 0 && <span className="count">{open.length}</span>}
          </button>
        ))}
      </div>
      {tab === 'Overview' && (
        <>
          <div className="section-heading">
            <h2>Document processing</h2>
          </div>
          <div className="document-grid">
            {DOC_TYPES.map((type) => {
              const d = a.documents.find((item: any) => item.doc_type === type);
              return (
                <div className="check-card" key={type} data-testid={`document-${type}`}>
                  <div>
                    <FileText size={20} />
                    <Badge status={d?.document_status ?? 'MISSING'} />
                  </div>
                  <h3>{label(type)}</h3>
                  <p>{d?.status_message ?? 'Upload this document to continue.'}</p>
                  {d?.detected_doc_type && <small>Detected: {label(d.detected_doc_type)}</small>}
                </div>
              );
            })}
          </div>
          <div className="section-heading">
            <h2>Verification progress</h2>
            <span className="muted">
              {a.checks.filter((c: any) => c.status === 'PASSED').length} of 4 checks passed
            </span>
          </div>
          <CheckCards checks={a.checks} blockedReason={blockedReason} />
          <div className="two-col">
            <section className="panel padded">
              <h2>Business at a glance</h2>
              <div className="key-values">
                <span>
                  Legal name<b>{a.form.legal_name}</b>
                </span>
                <span>
                  Business type<b>{label(a.form.business_type ?? 'NOT_SET')}</b>
                </span>
                <span>
                  Contact email<b>{a.form.contact_email}</b>
                </span>
                <span>
                  Location<b>{[a.form.city, a.form.state].filter(Boolean).join(', ') || '—'}</b>
                </span>
                <span>
                  PAN<b className="mono">{a.form.pan_masked || '—'}</b>
                </span>
                <span>
                  GSTIN<b className="mono">{a.form.gstin_masked || '—'}</b>
                </span>
                <span>
                  Account number<b className="mono">{a.form.bank_account_masked || '—'}</b>
                </span>
                <span>
                  IFSC<b className="mono">{a.form.bank_ifsc || '—'}</b>
                </span>
              </div>
            </section>
            <section className="panel padded">
              <h2>
                Attention required <span className="count">{open.length}</span>
              </h2>
              {open.length ? (
                open.map((e: any) => (
                  <div className="exception-mini" key={e.id}>
                    <span className="exception-symbol">
                      <AlertCircle size={17} />
                    </span>
                    <div>
                      <b>{label(e.type)}</b>
                      <p>
                        {e.details.reason_code
                          ? label(e.details.reason_code)
                          : (e.details.message ?? e.details.check_type ?? e.details.match_type)}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <Empty title="Nothing needs attention">
                  <p>We’ll surface anything that needs a decision here.</p>
                </Empty>
              )}
            </section>
          </div>
        </>
      )}
      {tab === 'Fields & documents' && (
        <>
          <div className="notice">
            <LockKeyhole size={18} />
            <span>
              Identifiers are masked. Extraction provides evidence; deterministic rules and
              providers decide.
            </span>
          </div>
          {a.documents.map((d: any) => (
            <section className="panel document-panel" key={d.id}>
              <div className="panel-title">
                <h2>
                  <FileText size={19} />
                  {label(d.doc_type)}
                  <Badge status={d.document_status} />
                </h2>
                <button onClick={() => viewDocument(a.id, d.id).catch(setError)}>
                  <ExternalLink size={15} />
                  View document
                </button>
              </div>
              <div className="document-meta">
                {d.extractor ?? d.source} extraction · Legibility: {d.legibility ?? 'Not assessed'}
                {d.extraction_model && ` · Model: ${d.extraction_model}`}
                {d.detected_doc_type && ` · Detected: ${label(d.detected_doc_type)}`}
                <p>{d.status_message}</p>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>FIELD</th>
                      <th>DECLARED VALUE</th>
                      <th>EXTRACTED VALUE</th>
                      <th>CONFIDENCE</th>
                      <th>VALIDATION</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.fields.map((f: any) => {
                      const declared: Record<string, string> = {
                        pan_number: a.form.pan_masked,
                        gstin: a.form.gstin_masked,
                        account_number: a.form.bank_account_masked,
                        ifsc: a.form.bank_ifsc,
                        name: a.form.legal_name,
                        legal_name: a.form.legal_name,
                        account_holder_name: a.form.bank_account_holder_name,
                        trade_name: a.form.trade_name,
                      };
                      return (
                        <tr key={f.field_name}>
                          <td>{label(f.field_name)}</td>
                          <td className="mono">{declared[f.field_name] ?? '—'}</td>
                          <td className="mono">{f.value_masked || 'Unreadable'}</td>
                          <td>
                            <div className="confidence">
                              <span style={{ width: `${f.confidence * 100}%` }} />
                            </div>
                            <small>{Math.round(f.confidence * 100)}%</small>
                          </td>
                          <td>
                            <Badge status={f.validation ?? 'PENDING'} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!d.fields.length && (
                <Empty
                  title={
                    d.extraction_status === 'FAILED' ? 'Extraction failed' : 'Extraction is pending'
                  }
                />
              )}
            </section>
          ))}
          <section className="panel padded">
            <h2>Validation findings</h2>
            {a.findings.map((f: any, i: number) => (
              <div className="finding" key={i}>
                {f.passed ? (
                  <CheckCircle2 size={16} className="success-text" />
                ) : (
                  <AlertCircle size={16} className="warning-text" />
                )}
                <code>{f.rule_code}</code>
                <span>{f.message}</span>
                <Badge status={f.passed ? 'PASSED' : f.severity} />
              </div>
            ))}
          </section>
        </>
      )}
      {tab === 'Checks' && (
        <>
          <CheckCards checks={a.checks} blockedReason={blockedReason} />
          {a.checks.map((c: any) => (
            <section className="panel padded attempts" key={c.check_type}>
              <h2>
                {c.check_type} attempts <span className="muted">Cycle {c.cycle}</span>
              </h2>
              {!c.attempts.length ? (
                <p className="muted">
                  Not dispatched.{' '}
                  {c.blocked_by.length ? `Waiting for ${c.blocked_by.join(', ')}` : ''}
                </p>
              ) : (
                c.attempts.map((at: any) => (
                  <div className="attempt" key={at.id}>
                    <div>
                      <b>Attempt {at.attempt_no}</b>
                      <Badge status={at.status} />
                      <span className="muted">{date(at.created_at)}</span>
                    </div>
                    <code>{at.id}</code>
                    {at.deadline_at && <small>Deadline {date(at.deadline_at)}</small>}
                    {at.callbacks.map((cb: any) => (
                      <div className="callback" key={cb.event_id}>
                        <ArrowRight size={14} />
                        <Badge status={cb.outcome} />
                        <span>
                          {cb.delivery_count} deliver{cb.delivery_count === 1 ? 'y' : 'ies'}
                        </span>
                        <code>{cb.event_id}</code>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </section>
          ))}
        </>
      )}
      {tab === 'Exceptions' && (
        <section className="panel padded">
          <h2>Exception history</h2>
          {!a.exceptions.length ? (
            <Empty title="No exceptions" />
          ) : (
            a.exceptions.map((e: any) => (
              <div className="exception-full" key={e.id}>
                <div>
                  <h3>{label(e.type)}</h3>
                  <Badge status={e.status} />
                </div>
                <p>
                  {e.details.message ??
                    label(
                      e.details.reason_code ??
                        e.details.check_type ??
                        e.details.match_type ??
                        'Review required',
                    )}
                </p>
                {e.details.reference && (
                  <Link to={`/ops/applications/${e.details.matched_application_id}`}>
                    Matching application {e.details.reference}
                    <ArrowUpRight size={14} />
                  </Link>
                )}
                {e.resolution_note && <blockquote>{e.resolution_note}</blockquote>}
                <small>
                  {date(e.raised_at)} ·{' '}
                  {e.reviewer_resolvable
                    ? 'Reviewer judgement'
                    : 'Requires a successful check or system recovery'}
                </small>
                {ops &&
                  e.status === 'OPEN' &&
                  e.reviewer_resolvable &&
                  a.status === 'IN_REVIEW' && (
                    <button onClick={() => setAction(`RESOLVE:${e.id}`)}>Resolve exception</button>
                  )}
              </div>
            ))
          )}
        </section>
      )}
      {tab === 'Timeline' && (
        <section className="panel padded">
          <h2>Every step, recorded</h2>
          <div className="timeline">
            {timeline.data?.items
              .slice()
              .reverse()
              .map((e: any) => (
                <div className="timeline-item" key={e.id}>
                  <span className={`timeline-dot ${e.actor_type === 'OPERATOR' ? 'human' : ''}`}>
                    {e.actor_type === 'OPERATOR' ? (
                      <ShieldCheck size={15} />
                    ) : (
                      <Activity size={15} />
                    )}
                  </span>
                  <div>
                    <div>
                      <b>{label(e.event_type)}</b>
                      <span className="muted">{date(e.created_at)}</span>
                    </div>
                    <p>
                      {e.from_status && (
                        <>
                          {label(e.from_status)} <ArrowRight size={12} /> {label(e.to_status)}
                        </>
                      )}
                      {e.data.note ?? e.data.reason_code ?? e.data.check_type ?? ''}
                    </p>
                    <small>
                      {label(e.actor_type)}
                      {e.data.attempt_id ? ` · Attempt ${e.data.attempt_id.slice(0, 8)}` : ''}
                    </small>
                  </div>
                </div>
              ))}
          </div>
          <ErrorBox error={timeline.error} />
        </section>
      )}
      {action &&
        (action === 'EDIT' ? (
          <EditDialog application={a} onClose={() => setAction(undefined)} />
        ) : action === 'CHANGE_BANK' ? (
          <BankDialog application={a} onClose={() => setAction(undefined)} />
        ) : (
          <ActionDialog application={a} action={action} onClose={() => setAction(undefined)} />
        ))}
    </>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function ActionDialog({
  application: a,
  action,
  onClose,
}: {
  application: any;
  action: string;
  onClose: () => void;
}) {
  const [note, setNote] = useState(''),
    [reason, setReason] = useState('BUSINESS_REQUIREMENTS_NOT_MET'),
    [resolution, setResolution] = useState('ACCEPTED'),
    [target, setTarget] = useState('GST_CERTIFICATE'),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const title = action.startsWith('RESOLVE')
    ? 'Resolve exception'
    : action.startsWith('RERUN')
      ? `Re-run ${action.split(':')[1]} check`
      : label(action);
  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let path =
        action === 'RETRY_PROVISIONING'
          ? 'provisioning/retry'
          : action === 'REPROCESS'
            ? 'reprocess'
            : action.toLowerCase().replaceAll('_', '-');
      const body: any = { note };
      if (action.startsWith('RESOLVE:')) {
        path = `exceptions/${action.split(':')[1]}/resolve`;
        body.resolution = resolution;
      }
      if (action.startsWith('RERUN_CHECK:')) path = `checks/${action.split(':')[1]}/rerun`;
      if (action === 'REJECT') body.reason_code = reason;
      if (action === 'REQUEST_INFO')
        body.items = [
          {
            code: 'OPERATOR_REQUEST',
            target_type: DOC_TYPES.includes(target as DocType) ? 'DOCUMENT' : 'FIELD',
            target,
            message,
          },
        ];
      await api(`/applications/${a.id}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      await client.invalidateQueries();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={confirm}>
        <p className="muted">
          {a.reference} · {a.legal_name}
        </p>
        <ErrorBox error={error} />
        {action === 'REQUEST_INFO' && (
          <>
            <label>
              Requested document or field
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {[...DOC_TYPES, 'pan', 'gstin', 'legal_name', 'account_number'].map((v) => (
                  <option key={v} value={v}>
                    {label(v)}
                  </option>
                ))}
              </select>
            </label>
            <Field name="Request to the merchant" value={message} onChange={setMessage} required />
          </>
        )}
        {action === 'REJECT' && (
          <label>
            Rejection reason
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {[
                'BUSINESS_REQUIREMENTS_NOT_MET',
                'INVALID_DOCUMENTS',
                'VERIFICATION_FAILED',
                'DUPLICATE_APPLICATION',
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        )}
        {action.startsWith('RESOLVE') && (
          <label>
            Resolution
            <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
              <option value="ACCEPTED">Evidence accepted</option>
              <option value="FALSE_POSITIVE">False positive</option>
            </select>
          </label>
        )}
        <label>
          Decision note
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            minLength={10}
            maxLength={1000}
            required
            placeholder="Explain the reason for this action (at least 10 characters)."
          />
        </label>
        <div className="notice">
          <FileText size={17} />
          <span>Your decision and note will be added to the audit trail.</span>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className={action === 'REJECT' ? 'danger' : 'primary'} disabled={busy}>
            {busy ? 'Saving…' : title}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function BankDialog({ application: a, onClose }: { application: any; onClose: () => void }) {
  const [account, setAccount] = useState(''),
    [ifsc, setIfsc] = useState(a.form.bank_ifsc ?? ''),
    [holder, setHolder] = useState(a.form.bank_account_holder_name ?? ''),
    [file, setFile] = useState<File>(),
    [structured, setStructured] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let body: BodyInit;
      if (structured)
        body = JSON.stringify({
          account_number: account,
          ifsc,
          account_holder_name: holder,
          bank_proof: {
            account_number: account,
            ifsc,
            account_holder_name: holder,
            bank_name: 'Synthetic Demo Bank',
          },
        });
      else {
        const f = new FormData();
        f.append('account_number', account);
        f.append('ifsc', ifsc);
        f.append('account_holder_name', holder);
        if (file) f.append('bank_proof', file);
        body = f;
      }
      await api(`/applications/${a.id}/bank-account`, { method: 'PUT', body });
      await client.invalidateQueries();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Change bank details" onClose={onClose}>
      <form onSubmit={save}>
        <div className="notice">
          <RefreshCw size={18} />
          <span>
            Bank and risk verification will run again. PAN and GST results remain valid when their
            inputs are unchanged.
          </span>
        </div>
        <ErrorBox error={error} />
        <Field name="New account number" value={account} onChange={setAccount} required />
        <Field name="IFSC" value={ifsc} onChange={(v) => setIfsc(v.toUpperCase())} required />
        <Field name="Account holder name" value={holder} onChange={setHolder} required />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={structured}
            onChange={(e) => setStructured(e.target.checked)}
          />
          Submit matching structured bank proof (synthetic demo)
        </label>
        {!structured && (
          <label>
            Replacement bank proof
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              onChange={(e) => setFile(e.target.files?.[0])}
            />
          </label>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Updating…' : 'Update & verify'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function EditDialog({ application: a, onClose }: { application: any; onClose: () => void }) {
  const [form, setForm] = useState<Record<string, string>>({
    legal_name: a.form.legal_name,
    contact_email: a.form.contact_email,
    business_type: a.form.business_type ?? 'PRIVATE_LIMITED',
    trade_name: a.form.trade_name ?? '',
    business_category: a.form.business_category ?? '',
    address_line: a.form.address_line ?? '',
    city: a.form.city ?? '',
    state: a.form.state ?? '',
    pincode: a.form.pincode ?? '',
    pan: '',
    gstin: '',
    account_number: '',
    ifsc: a.form.bank_ifsc ?? '',
    account_holder_name: a.form.bank_account_holder_name ?? '',
  });
  const [docs, setDocs] = useState<Partial<Record<DocType, DocumentInput>>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { account_number, ifsc, account_holder_name, pan, gstin, ...rest } = form;
      const patch: any = Object.fromEntries(Object.entries(rest).filter(([, v]) => v));
      if (pan) patch.pan = pan.toUpperCase();
      if (gstin) patch.gstin = gstin.toUpperCase();
      if (account_number)
        patch.bank_account = { account_number, ifsc: ifsc.toUpperCase(), account_holder_name };
      await api(`/applications/${a.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      for (const type of DOC_TYPES) if (docs[type]) await sendDocument(a.id, type, docs[type]!);
      await api(`/applications/${a.id}/submit`, { method: 'POST' });
      await client.invalidateQueries();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Update application" onClose={onClose} wide>
      <form onSubmit={save}>
        <div className="notice">
          <LockKeyhole size={17} />
          <span>
            Leave PAN, GSTIN and account number blank to keep the current values. Replace any
            evidence that needs correction.
          </span>
        </div>
        <ErrorBox error={error} />
        <div className="form-grid">
          {Object.entries(form).map(([key, value]) =>
            key === 'business_type' ? (
              <label key={key}>
                Business type
                <select
                  value={value}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                >
                  {[
                    'PROPRIETORSHIP',
                    'PARTNERSHIP',
                    'LLP',
                    'PRIVATE_LIMITED',
                    'PUBLIC_LIMITED',
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            ) : (
              <Field
                key={key}
                name={label(key)}
                value={value}
                onChange={(v) => setForm((f) => ({ ...f, [key]: v }))}
              />
            ),
          )}
        </div>
        <h3>Replace documents</h3>
        {DOC_TYPES.map((type) => (
          <div key={type}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!!docs[type]}
                onChange={(e) =>
                  setDocs((d) => ({
                    ...d,
                    [type]: e.target.checked ? { mode: 'file', fields: {} } : undefined,
                  }))
                }
              />
              Replace {label(type)}
            </label>
            {docs[type] && (
              <DocumentEditor
                type={type}
                value={docs[type]!}
                onChange={(v) => setDocs((d) => ({ ...d, [type]: v }))}
              />
            )}
          </div>
        ))}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Submitting…' : 'Save & resubmit'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ReviewQueue() {
  const q = useQuery({
    queryKey: ['review'],
    queryFn: () => api('/review-queue'),
    refetchInterval: 2000,
  });
  return (
    <>
      <PageTitle
        eyebrow="HUMAN JUDGEMENT"
        title="Review queue"
        description="The cases that need your expertise, ordered by waiting time."
      >
        <span className="live">
          <span />
          Live updates
        </span>
      </PageTitle>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loading />
      ) : !q.data?.items.length ? (
        <section className="panel">
          <Empty title="The queue is clear">
            <p>No applications are waiting for review.</p>
          </Empty>
        </section>
      ) : (
        <div className="review-cards">
          {q.data.items.map((r: any) => (
            <Link
              className="review-card"
              key={r.application.id}
              to={`/ops/applications/${r.application.id}`}
            >
              <div className="review-card-top">
                <span className="business-icon">
                  <Building2 size={20} />
                </span>
                <span className="mono muted">{r.application.reference}</span>
                <ArrowUpRight size={20} />
              </div>
              <h2>{r.application.legal_name}</h2>
              <div className="review-reasons">
                {r.open_exceptions.map((e: any) => (
                  <span key={e.id}>
                    {label(e.type)}
                    {e.details.check_type ? ` · ${e.details.check_type}` : ''}
                  </span>
                ))}
              </div>
              <div className="review-card-bottom">
                <Badge status="IN_REVIEW" />
                <span>
                  <Clock3 size={14} />
                  Waiting {duration(r.waiting_seconds)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
function Metrics() {
  const [window, setWindow] = useState('24h');
  const q = useQuery({
    queryKey: ['metrics', window],
    queryFn: () => api(`/metrics/summary?window=${window}`),
    refetchInterval: 5000,
  });
  const m = q.data;
  return (
    <>
      <PageTitle
        eyebrow="OPERATIONAL HEALTH"
        title="Every journey, in perspective."
        description="Measure automation, identify friction, and keep applications moving."
      >
        <select
          aria-label="Metrics period"
          value={window}
          onChange={(e) => setWindow(e.target.value)}
        >
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
        </select>
      </PageTitle>
      <ErrorBox error={q.error} />
      {!m ? (
        <Loading />
      ) : (
        <>
          <div className="stats">
            <Stat
              title="Straight-through rate"
              value={`${Math.round(m.straight_through_rate * 100)}%`}
              icon={Activity}
              note="Automatic approvals / all decisions"
            />
            <Stat
              title="Exception rate"
              value={`${Math.round(m.exception_rate * 100)}%`}
              icon={AlertCircle}
              note="Submitted applications with exceptions"
            />
            <Stat
              title="Review queue"
              value={m.review_queue.size}
              icon={ListChecks}
              note={`Oldest case: ${duration(m.review_queue.oldest_waiting_seconds)}`}
            />
            <Stat
              title="Dead jobs"
              value={m.dead_jobs}
              icon={Inbox}
              note="Retries exhausted in this window"
            />
          </div>
          <div className="two-col">
            <section className="panel padded">
              <h2>Applications by status</h2>
              <div className="bar-chart">
                {Object.entries(m.counts_by_status).map(([s, n]) => (
                  <div key={s}>
                    <span>{label(s)}</span>
                    <div>
                      <i
                        style={{
                          width: `${(Number(n) / Math.max(1, ...Object.values(m.counts_by_status).map(Number))) * 100}%`,
                        }}
                      />
                    </div>
                    <b>{String(n)}</b>
                  </div>
                ))}
              </div>
            </section>
            <section className="panel padded">
              <h2>Time in state</h2>
              <table>
                <thead>
                  <tr>
                    <th>STATE</th>
                    <th>AVERAGE</th>
                    <th>MEDIAN</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(m.time_in_state_seconds).map(([s, t]: [string, any]) => (
                    <tr key={s}>
                      <td>{label(s)}</td>
                      <td>{duration(t.avg)}</td>
                      <td>{duration(t.p50)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="fine-print">
                Completed state intervals, calculated from the audit trail.
              </p>
            </section>
            <section className="panel padded">
              <h2>Check outcomes</h2>
              <table>
                <thead>
                  <tr>
                    <th>PROVIDER</th>
                    <th>OUTCOME</th>
                    <th>CHECKS</th>
                  </tr>
                </thead>
                <tbody>
                  {m.checks.map((c: any) => (
                    <tr key={`${c.check_type}:${c.status}`}>
                      <td>{c.check_type}</td>
                      <td>
                        <Badge status={c.status} />
                      </td>
                      <td>{c.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="panel padded">
              <h2>Callback reliability</h2>
              <table>
                <thead>
                  <tr>
                    <th>OUTCOME</th>
                    <th>EVENTS</th>
                  </tr>
                </thead>
                <tbody>
                  {m.callbacks.map((c: any) => (
                    <tr key={c.outcome}>
                      <td>
                        <Badge status={c.outcome} />
                      </td>
                      <td>{c.count}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>Duplicate deliveries ignored</td>
                    <td>{m.duplicate_deliveries}</td>
                  </tr>
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </>
  );
}
function DeadLetters() {
  const q = useQuery({
    queryKey: ['dead'],
    queryFn: () => api('/dead-letters'),
    refetchInterval: 3000,
  });
  return (
    <>
      <PageTitle
        eyebrow="RECOVERY WORKSPACE"
        title="Dead letters"
        description="Exhausted jobs and unmatched callbacks stay visible until they’re understood."
      />
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loading />
      ) : (
        <>
          <section className="panel">
            <div className="panel-title">
              <h2>
                Exhausted jobs <span className="count">{q.data?.jobs.length ?? 0}</span>
              </h2>
            </div>
            {!q.data?.jobs.length ? (
              <Empty title="No exhausted jobs" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>JOB</th>
                      <th>ATTEMPTS</th>
                      <th>LAST ERROR</th>
                      <th>FINISHED</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.jobs.map((j: any) => (
                      <tr key={j.id}>
                        <td>{label(j.type)}</td>
                        <td>{j.attempts}</td>
                        <td>{j.last_error}</td>
                        <td>{date(j.finished_at)}</td>
                        <td>
                          <Link to={`/ops/applications/${j.application_id}`}>
                            Open application
                            <ArrowUpRight size={14} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="panel spaced">
            <div className="panel-title">
              <h2>Unmatched callbacks</h2>
            </div>
            {!q.data?.webhook_events.length ? (
              <Empty title="All callbacks are accounted for" />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>PROVIDER</th>
                    <th>EVENT</th>
                    <th>RECEIVED</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.webhook_events.map((e: any) => (
                    <tr key={e.id}>
                      <td>{e.provider}</td>
                      <td className="mono">{e.event_id}</td>
                      <td>{date(e.first_received_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </>
  );
}
function Simulator() {
  const q = useQuery({
    queryKey: ['scenarios'],
    queryFn: () => api('/simulator/scenarios'),
    refetchInterval: 2000,
  });
  const apps = useQuery({
    queryKey: ['simulator-apps'],
    queryFn: () => api('/applications?page_size=100'),
  });
  const [target, setTarget] = useState('gst'),
    [behavior, setBehavior] = useState('FAIL'),
    [appId, setAppId] = useState(''),
    [delay, setDelay] = useState(2000),
    [times, setTimes] = useState(1),
    [band, setBand] = useState('MEDIUM'),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/simulator/scenarios', {
        method: 'PUT',
        body: JSON.stringify({
          target,
          behavior,
          ...(appId ? { application_id: appId } : {}),
          delay_ms: delay,
          times,
          band,
          reason_code: target === 'gst' ? 'GSTIN_CANCELLED' : 'VERIFICATION_FAILED',
          repeats: 3,
        }),
      });
      await q.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="CONTROLLED FAILURE, VISIBLE RECOVERY"
        title="Provider simulator"
        description="Configure a provider response, then watch the real workflow handle it."
      />
      <div className="notice">
        <FlaskConical size={20} />
        <span>
          Demo tooling. Rules apply to future requests. Existing requests retain their original
          response.
        </span>
      </div>
      <div className="two-col">
        <form className="panel padded" onSubmit={save}>
          <h2>Configure a scenario</h2>
          <ErrorBox error={error} />
          <div className="form-grid">
            <label>
              Provider
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {['pan', 'gst', 'bank', 'risk', 'merchant-core'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Behavior
              <select value={behavior} onChange={(e) => setBehavior(e.target.value)}>
                {[
                  'SUCCESS',
                  'FAIL',
                  'NO_CALLBACK',
                  'LATE_CALLBACK',
                  'DUPLICATE_CALLBACK',
                  'HTTP_503',
                  'RISK_BAND',
                ].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Callback delay (ms)
              <input
                type="number"
                min={0}
                max={120000}
                value={delay}
                onChange={(e) => setDelay(Number(e.target.value))}
              />
            </label>
            <label>
              Matching requests
              <input
                type="number"
                min={1}
                max={100}
                value={times}
                onChange={(e) => setTimes(Number(e.target.value))}
              />
            </label>
          </div>
          <label>
            Application
            <select value={appId} onChange={(e) => setAppId(e.target.value)}>
              <option value="">All applications</option>
              {apps.data?.items.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.reference} · {a.legal_name}
                </option>
              ))}
            </select>
          </label>
          {behavior === 'RISK_BAND' && (
            <label>
              Risk band
              <select value={band} onChange={(e) => setBand(e.target.value)}>
                {['LOW', 'MEDIUM', 'HIGH'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          )}
          <button className="primary" disabled={busy}>
            <Plus size={16} />
            Add scenario rule
          </button>
        </form>
        <section className="panel padded">
          <div className="panel-title compact">
            <h2>Scenario rules</h2>
            <button
              onClick={async () => {
                try {
                  await api('/simulator/scenarios', { method: 'DELETE' });
                  await q.refetch();
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Reset all
            </button>
          </div>
          <ErrorBox error={q.error} />
          {!q.data?.items.length ? (
            <Empty title="All providers respond normally">
              <p>Default: success with a two-second delay.</p>
            </Empty>
          ) : (
            q.data.items.map((s: any) => (
              <div className="scenario-rule" key={s.id}>
                <div>
                  <b>{s.rule.target.toUpperCase()}</b>
                  <Badge status={s.remaining > 0 ? 'OPEN' : 'COMPLETED'} />
                </div>
                <h3>{label(s.rule.behavior)}</h3>
                <p>
                  {s.remaining} requests remaining · {s.rule.delay_ms} ms delay
                </p>
                <small>
                  {s.rule.application_id
                    ? `Application ${s.rule.application_id.slice(0, 8)}`
                    : 'Applies to all applications'}
                </small>
              </div>
            ))
          )}
        </section>
      </div>
      <div className="scenario-guide">
        <h3>Six failures. One resilient workflow.</h3>
        <p>
          GST failure · Duplicate callback · Late callback · Bank change · Provisioning outage ·
          Unreadable evidence
        </p>
      </div>
    </>
  );
}
function App() {
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/ops/*" element={<Shell />} />
          <Route path="/merchant/*" element={<Shell />} />
          <Route
            path="*"
            element={
              <Navigate
                to={
                  session()?.user.role === 'OPERATOR'
                    ? '/ops/applications'
                    : session()
                      ? '/merchant/applications'
                      : '/login'
                }
                replace
              />
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
