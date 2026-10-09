import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, LoaderCircle, Map, MessageCircle, Plus, Send, Sparkles, X } from "lucide-react";
import { apiJson, type GeoAction, type Page } from "@/lib/geotwin-api";

type Message = { role: "user" | "assistant"; content: string; context?: { action?: GeoAction; aiUsed?: boolean }; createdAt?: string };
type Props = { onAction: (action: GeoAction) => void; activeRegion: string };
const suggestions = [
  "Summarize the available infrastructure in Central Nagpur.",
  "Show hospitals on the map.",
  "Compare schools across the five regions.",
  "Which areas may need further infrastructure assessment?",
  "Check the quality of my uploaded datasets.",
  "Explain the current development-priority results.",
];

function getConversationId() {
  const key = "geotwinai-conversation-id";
  let value = sessionStorage.getItem(key);
  if (!value) { value = crypto.randomUUID(); sessionStorage.setItem(key, value); }
  return value;
}

export default function GeoAssistant({ onAction, activeRegion }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState("");
  const [retryPrompt, setRetryPrompt] = useState("");
  const [aiConfigured, setAiConfigured] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [conversationId, setConversationId] = useState(getConversationId);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void apiJson<{ messages: Message[] }>(`/api/geotwin/chat/${encodeURIComponent(conversationId)}`)
      .then(data => { if (!cancelled) setMessages(data.messages); })
      .catch(() => { if (!cancelled) setError("Chat history is temporarily unavailable; a new question can still be tried."); });
    void apiJson<{ aiConfigured?: boolean }>("/api/geotwin/status")
      .then(data => { if (!cancelled) setAiConfigured(Boolean(data.aiConfigured)); })
      .catch(() => { if (!cancelled) setAiConfigured(false); });
    return () => { cancelled = true; };
  }, [open, conversationId, historyVersion]);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, busy, open]);

  const send = async (event?: FormEvent, text?: string) => {
    event?.preventDefault();
    const prompt = (text ?? question).trim();
    if (!prompt || busy) return;
    setQuestion(""); setBusy(true); setIsTyping(true); setError(""); setRetryPrompt("");
    setMessages(items => [...items, { role: "user", content: prompt }]);
    try {
      const response = await apiJson<{ answer: string; action: GeoAction; aiUsed: boolean; mode: string }>("/api/geotwin/chat", { method: "POST", body: JSON.stringify({ question: prompt, conversationId, region: activeRegion }) });
      setMessages(items => [...items, { role: "assistant", content: response.answer, context: { action: response.action, aiUsed: response.aiUsed } }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The question could not be answered.");
      setRetryPrompt(prompt); setQuestion(prompt);
      setMessages(items => items.filter((_, index) => index !== items.length - 1));
    } finally { setBusy(false); setIsTyping(false); }
  };

  const startNew = () => {
    const nextId = crypto.randomUUID();
    sessionStorage.setItem("geotwinai-conversation-id", nextId);
    setConversationId(nextId); setMessages([]); setQuestion(""); setError(""); setRetryPrompt("");
  };
  const runAction = (action?: GeoAction) => { if (action) { onAction(action); setOpen(false); } };
  const retry = () => {
    setError("");
    if (retryPrompt) void send(undefined, retryPrompt);
    else setHistoryVersion(version => version + 1);
  };

  return <>
    {!open && <button className="assistant-launcher" onClick={() => setOpen(true)} aria-label="Ask Geo, your planning assistant"><span className="launcher-orbit"><img src="/manus-storage/async-images/aWboXnSIkzL4bmsqiWGTqo/image-1.webp" alt="" /></span><span className="launcher-label"><strong>Ask Geo</strong><small>Planning assistant</small></span><span className="launcher-arrow"><MessageCircle size={17} /></span></button>}
    {open && <section className="assistant-window" aria-label="Geo Planning Assistant"><header className="assistant-header"><span className="assistant-avatar"><img src="/manus-storage/async-images/aWboXnSIkzL4bmsqiWGTqo/image-1.webp" alt="" /></span><div className="assistant-heading"><strong>Geo</strong><span>Planning assistant · Nagpur data</span></div><span className="assistant-live"><i />{aiConfigured ? "Managed AI · grounded" : "Local data-query mode"}</span><button className="icon-btn assistant-close" aria-label="New conversation" title="Start a new conversation" onClick={startNew}><Plus size={15} /></button><button className="icon-btn assistant-close" aria-label="Close Geo assistant" onClick={() => setOpen(false)}><X size={17} /></button></header>
      <div className="assistant-body" aria-live="polite">
        {!messages.length && <div className="assistant-welcome"><span className="geo-welcome-art"><img src="/manus-storage/async-images/aWboXnSIkzL4bmsqiWGTqo/image-1.webp" alt="Geo, a friendly Earth companion" /></span><span className="eyebrow">A CLEAR VIEW OF WHAT THE DATA SAYS</span><h3>Where shall we look?</h3><p>I work from the records on this map. I’ll tell you when the evidence is thin, too.</p>{!aiConfigured&&<p className="assistant-mode-note">Managed AI is not configured for this project. Safe, deterministic database answers remain available.</p>}<div className="suggestions">{suggestions.map(item => <button onClick={() => void send(undefined,item)} key={item}><span>{item}</span><ArrowRight size={14} /></button>)}</div></div>}
        {messages.map((message,index) => <div key={`${index}-${message.role}`} className={`message message-${message.role}`}><div className="message-avatar">{message.role === "assistant" ? <img src="/manus-storage/async-images/aWboXnSIkzL4bmsqiWGTqo/image-1.webp" alt="" /> : <span>You</span>}</div><div className="message-content"><div className="message-meta">{message.role === "assistant" ? message.context?.aiUsed ? "GEO · MANAGED AI · DATABASE-GROUNDED" : "GEO · LOCAL DATABASE ANSWER" : "YOU"}</div><div className="message-bubble">{message.content}</div>{message.role === "assistant" && message.context?.action && <button className="assistant-action" onClick={() => runAction(message.context?.action)}>{message.context.action.type === "layer" ? <><Map size={14} />View {message.context.action.category} layer</> : <><ArrowRight size={14} />Open {message.context.action.section}</>}</button>}</div></div>)}
        {isTyping && <div className="message message-assistant"><div className="message-avatar"><img src="/manus-storage/async-images/aWboXnSIkzL4bmsqiWGTqo/image-1.webp" alt="" /></div><div className="message-content"><div className="message-meta">GEO · CHECKING THE RECORDS</div><div className="message-bubble assistant-typing"><i /><i /><i /></div></div></div>}
        {error && <div className="assistant-error">{error}<button onClick={retry}>Retry</button></div>}
        <div ref={messagesEnd} />
      </div>
      <form className="assistant-composer" onSubmit={e => void send(e)}><textarea value={question} onChange={e=>setQuestion(e.target.value)} placeholder="Ask about a place or dataset…" rows={1} maxLength={1500} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void send();}}} disabled={busy} /><button type="submit" aria-label="Send question" disabled={!question.trim() || busy}>{busy?<LoaderCircle size={16} className="spin"/>:<Send size={16}/>}</button></form>
      <footer className="assistant-footnote"><Sparkles size={12} />{aiConfigured ? "Managed AI interprets verified aggregates; no model-generated SQL is executed." : "Local data-query mode · answers use active database records, not official planning advice."}</footer>
    </section>}
  </>;
}
