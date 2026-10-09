import { useState } from "react";
import { ArrowRight, Fingerprint, LockKeyhole } from "lucide-react";
import { startLogin } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";
import Home from "@/pages/Home";

export default function GeoTwinAuthGate() {
  const { loading, user, logout } = useAuth();
  const [signInError, setSignInError] = useState("");

  if (loading) return <main className="auth-surface" aria-live="polite"><section className="auth-card auth-card-loading"><img src="/geotwin-mark.svg" alt=""/><span className="eyebrow">GEOTWINAI / PRIVATE WORKSPACE</span><div className="auth-progress-line"/><p>Verifying your project session…</p></section></main>;

  if (!user) return <main className="auth-surface"><section className="auth-card">
    <header className="auth-brand"><img src="/geotwin-mark.svg" alt=""/><div><strong>GeoTwin<span>AI</span></strong><small>THE LIVING MODEL OF NAGPUR</small></div></header>
    <div className="auth-divider"/>
    <span className="eyebrow">A PHYSICAL DIGITAL TWIN</span>
    <h1>See the city<br/><em>with evidence.</em></h1>
    <p className="auth-copy">A considered workspace for exploring Nagpur’s mapped features, comparing source-labeled regions and checking what each dataset can—and cannot—tell you.</p>
    <button className="auth-login-button" onClick={() => { setSignInError(""); try { startLogin(); } catch { setSignInError("The Manus sign-in service is unavailable right now. Please retry in a moment."); } }}><Fingerprint size={17}/><span>Continue with Manus</span><ArrowRight size={15}/></button>
    {signInError && <p className="auth-error" role="alert">{signInError}</p>}
    <div className="auth-private-note"><LockKeyhole size={15}/><p><strong>Private project workspace</strong><br/>Sign-in is required. Only the project owner can change shared datasets; signed-in collaborators can explore and create reports.</p></div>
    <footer className="auth-foot"><span>OBSERVE · EXPLORE · UNDERSTAND</span><span>WGS84 / NAGPUR</span></footer>
  </section></main>;

  return <Home accountName={user.name || user.email || "Manus collaborator"} accountEmail={user.email || ""} accountOpenId={user.openId || ""} onLogout={logout}/>;
}
