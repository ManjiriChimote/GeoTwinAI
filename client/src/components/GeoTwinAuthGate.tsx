import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, Fingerprint, LockKeyhole, UserRoundPlus, X } from "lucide-react";
import { apiJson, GEO_TWIN_AUTH_EXPIRED_EVENT, setGeoTwinCsrfToken, type GeoTwinAccount } from "@/lib/geotwin-api";

const Home = lazy(() => import("@/pages/Home"));

type AuthMode = "login" | "signup";
type LegalTab = "terms" | "privacy";

export default function GeoTwinAuthGate() {
  const [account, setAccount] = useState<GeoTwinAccount | null>(null);
  const [checking, setChecking] = useState(true);
  const [serviceError, setServiceError] = useState("");
  const [authError, setAuthError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<AuthMode>("login");
  const [legalTab, setLegalTab] = useState<LegalTab>("terms");
  const [legalOpen, setLegalOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const checkSession = async () => {
    setChecking(true);
    setServiceError("");
    try {
      const { csrfToken } = await apiJson<{ csrfToken: string }>("/api/geotwin/auth/csrf");
      setGeoTwinCsrfToken(csrfToken);
      const result = await apiJson<{ user: GeoTwinAccount | null }>("/api/geotwin/auth/me");
      setAccount(result.user);
      setChecking(false);
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : "The account service is temporarily unavailable.");
      setChecking(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    const onExpired = () => {
      if (!mounted) return;
      setAccount(null);
      setMode("login");
      setNotice("Your session ended. Sign in again to continue.");
      setAuthError("");
    };
    window.addEventListener(GEO_TWIN_AUTH_EXPIRED_EVENT, onExpired);
    void checkSession();
    return () => {
      mounted = false;
      window.removeEventListener(GEO_TWIN_AUTH_EXPIRED_EVENT, onExpired);
    };
  }, []);

  useEffect(() => {
    if (!legalOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setLegalOpen(false); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", closeOnEscape); };
  }, [legalOpen]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError("");
    setNotice("");
    if (mode === "signup" && password !== passwordConfirm) {
      setAuthError("The passwords do not match.");
      return;
    }
    if (mode === "signup" && !acceptedTerms) {
      setAuthError("Accept the Terms & Conditions to create an account.");
      return;
    }
    setBusy(true);
    try {
      const endpoint = mode === "signup" ? "/api/geotwin/auth/register" : "/api/geotwin/auth/login";
      const result = await apiJson<{ user: GeoTwinAccount }>(endpoint, {
        method: "POST",
        body: JSON.stringify(mode === "signup" ? { name, email, password, acceptedTerms } : { email, password }),
      });
      setAccount(result.user);
      setPassword("");
      setPasswordConfirm("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "We could not sign you in. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    try { await apiJson<{ success: boolean }>("/api/geotwin/auth/logout", { method: "POST", body: JSON.stringify({}) }); }
    catch { /* Clear the local workspace even if the session already expired. */ }
    setAccount(null);
    setMode("login");
    setNotice("You have signed out.");
  };

  if (checking) return <main className="auth-surface" aria-live="polite"><section className="auth-card auth-card-loading"><AuthBrand/><span className="eyebrow">GEOTWINAI / PRIVATE WORKSPACE</span><div className="auth-progress-line"/><p>Checking your account session…</p></section></main>;

  if (serviceError) return <main className="auth-surface"><section className="auth-card"><AuthBrand/><div className="auth-divider"/><span className="eyebrow">ACCOUNT SERVICE</span><h1>We’ll be<br/><em>back shortly.</em></h1><p className="auth-copy">GeoTwinAI could not reach its persistent account service.</p><p className="auth-error" role="alert">{serviceError}</p><button type="button" className="auth-submit" onClick={() => void checkSession()}>Retry <ArrowRight size={15}/></button><AuthFooter/></section></main>;

  if (account) return <Suspense fallback={<main className="auth-surface" aria-live="polite"><section className="auth-card auth-card-loading"><AuthBrand/><span className="eyebrow">GEOTWINAI / PRIVATE WORKSPACE</span><div className="auth-progress-line"/><p>Opening the city workspace…</p></section></main>}><Home accountName={account.name} accountEmail={account.email} accountId={account.accountId} onLogout={signOut}/></Suspense>;

  return <main className="auth-surface">
    <section className="auth-card auth-card-form">
      <AuthBrand/>
      <div className="auth-divider"/>
      <span className="eyebrow">A PHYSICAL DIGITAL TWIN</span>
      <h1>{mode === "login" ? <>See the city<br/><em>with evidence.</em></> : <>Make room for<br/><em>good decisions.</em></>}</h1>
      <p className="auth-copy">{mode === "login" ? "Sign in to explore Nagpur’s source-backed maps, analysis and reports." : "Create an account to explore the shared Nagpur data workspace."}</p>

      <div className="auth-tabs" role="tablist" aria-label="Account access">
        <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "is-active" : ""} onClick={() => { setMode("login"); setAuthError(""); setNotice(""); }}>Sign in</button>
        <button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "is-active" : ""} onClick={() => { setMode("signup"); setAuthError(""); setNotice(""); }}>Create account</button>
      </div>

      {notice && <p className="auth-notice" role="status">{notice}</p>}
      <form className="auth-form" onSubmit={submit}>
        {mode === "signup" && <label className="auth-field"><span>Full name</span><input name="name" autoComplete="name" maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="Your name" required minLength={2}/></label>}
        <label className="auth-field"><span>Email address</span><input name="email" type="email" autoComplete="email" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" required/></label>
        <label className="auth-field"><span>Password</span><span className="auth-password-wrap"><input name="password" type={showPassword ? "text" : "password"} autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={mode === "signup" ? 12 : undefined} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} placeholder={mode === "signup" ? "At least 12 characters" : "Enter your password"} required/><button type="button" className="auth-password-toggle" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff size={16}/> : <Eye size={16}/>}</button></span></label>
        {mode === "signup" && <label className="auth-field"><span>Confirm password</span><input name="passwordConfirm" type={showPassword ? "text" : "password"} autoComplete="new-password" maxLength={128} value={passwordConfirm} onChange={event => setPasswordConfirm(event.target.value)} placeholder="Enter the same password again" required/></label>}
        {mode === "signup" && <div className="auth-terms-check"><input id="auth-terms-accepted" type="checkbox" checked={acceptedTerms} onChange={event => setAcceptedTerms(event.target.checked)} required/><div><label htmlFor="auth-terms-accepted">I agree to the</label> <button type="button" className="auth-inline-link" onClick={() => { setLegalTab("terms"); setLegalOpen(true); }}>Terms &amp; Conditions</button> <label htmlFor="auth-terms-accepted">and acknowledge the</label> <button type="button" className="auth-inline-link" onClick={() => { setLegalTab("privacy"); setLegalOpen(true); }}>Privacy Notice</button>.</div></div>}
        {authError && <p className="auth-error" role="alert">{authError}</p>}
        <button type="submit" className="auth-submit" disabled={busy}>{busy ? <><span className="auth-spinner"/>Please wait…</> : <>{mode === "login" ? "Sign in" : "Create account"}{mode === "login" ? <ArrowRight size={15}/> : <UserRoundPlus size={15}/>}</>}</button>
      </form>

      {mode === "login" ? <p className="auth-switch-note">New to GeoTwinAI? <button type="button" className="auth-inline-link" onClick={() => { setMode("signup"); setAuthError(""); setNotice(""); }}>Create an account</button></p> : <p className="auth-password-note">Use 12 or more characters. Email verification and password-reset email are not configured.</p>}
      <div className="auth-private-note"><LockKeyhole size={15}/><p><strong>Private project workspace</strong><br/>Accounts can explore and report. Shared dataset changes stay locked until the project owner is explicitly bound in protected settings.</p></div>
      <AuthFooter/>
    </section>
    {legalOpen && <div className="auth-legal-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setLegalOpen(false); }}><section className="auth-legal-dialog" role="dialog" aria-modal="true" aria-labelledby="legal-title"><header><div><span className="eyebrow">GEOTWINAI / ACCOUNT TERMS</span><h2 id="legal-title">{legalTab === "terms" ? "Terms & Conditions" : "Privacy Notice"}</h2></div><button type="button" className="icon-btn" aria-label="Close legal information" onClick={() => setLegalOpen(false)}><X size={18}/></button></header><nav className="auth-legal-tabs" aria-label="Legal documents"><button type="button" className={legalTab === "terms" ? "is-active" : ""} onClick={() => setLegalTab("terms")}>Terms</button><button type="button" className={legalTab === "privacy" ? "is-active" : ""} onClick={() => setLegalTab("privacy")}>Privacy</button></nav>{legalTab === "terms" ? <div className="auth-legal-copy"><p><strong>Effective 15 October 2026 · Version 2026-10-15-v1</strong></p><h3>Purpose</h3><p>GeoTwinAI is an exploratory GIS and planning-support workspace for the Nagpur study area. It is provided to help inspect supplied spatial records and compare project-defined analytical regions.</p><h3>Evidence and limitations</h3><p>Maps, counts, indicators and assistant responses depend on the available source records. The study area is not necessarily an official administrative boundary; source completeness, coordinate reference systems, dates and positional accuracy may be uncertain. Lower feature counts alone do not establish unmet need.</p><p>Do not use GeoTwinAI as the sole basis for legal, engineering, safety, emergency, financial or statutory decisions. Verify material conclusions against current authoritative sources and qualified local expertise.</p><h3>Accounts and use</h3><p>Keep your password private and use the workspace only with data you are authorized to access. Do not attempt to bypass access controls, disrupt the service, upload unlawful content, or submit sensitive personal information to the assistant.</p><p>Only the account bound as project owner in protected settings may change shared datasets. Other registered accounts are read-only for shared data.</p><h3>Service and changes</h3><p>The service and its analytical outputs are provided without a guarantee of uninterrupted availability, completeness, fitness for a particular purpose or decision outcome. These terms may be updated; a material change requires acceptance of the current version on a later account registration flow.</p><p>OpenStreetMap basemap tiles are subject to the <a href="https://operations.osmfoundation.org/policies/tiles/" target="_blank" rel="noopener noreferrer">OpenStreetMap tile usage policy</a>; map attribution is shown on the map.</p></div> : <div className="auth-legal-copy"><p><strong>Effective 15 October 2026 · Version 2026-10-15-v1</strong></p><h3>Information stored</h3><p>GeoTwinAI stores your name, email address, a salted password hash, account/session metadata and the timestamp/version of the terms you accepted. Plaintext passwords are not stored. Session tokens are stored only as hashes and expire automatically.</p><h3>Workspace data</h3><p>Shared GIS datasets are visible to signed-in accounts. Assistant conversation history is associated with your account so another account cannot load it by guessing a conversation identifier. Do not enter sensitive personal information into Geo or upload data you are not permitted to share.</p><h3>Account security</h3><p>Use a unique, long password and sign out on shared devices. Email verification and automatic password-reset emails are not configured in this build. The project owner controls account/data configuration and shared dataset changes.</p></div>}<footer><span>Review the current version before accepting.</span><button type="button" className="secondary-btn" onClick={() => setLegalOpen(false)}>Close</button></footer></section></div>}
  </main>;
}

function AuthBrand() {
  return <header className="auth-brand"><img className="logo-emblem" src="/geotwin-emblem.png" alt=""/><img className="logo-wordmark" src="/geotwin-wordmark.png" alt="GeoTwinAI — The Living Digital Twin of Nagpur"/></header>;
}

function AuthFooter() {
  return <footer className="auth-foot"><span>OBSERVE · EXPLORE · UNDERSTAND</span><span>WGS84 / NAGPUR</span></footer>;
}
