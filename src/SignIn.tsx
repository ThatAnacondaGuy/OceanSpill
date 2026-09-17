import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { Seal } from './components/Seal';
import { ApiError, signIn as apiSignIn, type Account } from './data/api';

/**
 * The sign-in screen used when the site runs against the server. Accounts are created by an
 * administrator: there is no self-registration, and the screen never hints at which half of a
 * wrong email-and-password pair was wrong.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (account: Account) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (needsCode) codeRef.current?.focus();
  }, [needsCode]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await apiSignIn(email.trim(), password, code.trim() || undefined));
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      if (apiError?.mfaRequired) {
        setNeedsCode(true);
        setError(code ? apiError.message : null);
        setCode('');
      } else {
        setError(apiError?.message ?? 'The server could not be reached. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f0f4f8] flex flex-col">
      <div className="flex h-1 flex-shrink-0" aria-hidden>
        <span className="flex-1 bg-[#FF9933]" />
        <span className="flex-1 bg-white" />
        <span className="flex-1 bg-[#138808]" />
      </div>
      <div className="bg-[#0b2a55] text-slate-200 text-[0.71875rem]">
        <div className="px-3 sm:px-5 h-8 flex items-center gap-2">
          <span lang="hi" className="font-hindi whitespace-nowrap">समुद्री प्रदूषण निगरानी</span>
          <span className="text-slate-400">|</span>
          <span className="truncate">Maritime Pollution Surveillance</span>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
            <div className="px-6 pt-6 pb-4 flex items-center gap-3 border-b border-gray-200">
              <Seal size={48} />
              <div className="min-w-0">
                <p lang="hi" className="font-hindi text-[0.8125rem] text-gray-700 leading-snug">
                  समुद्री तेल रिसाव जाँच एवं पोत अभिनिर्धारण प्रणाली
                </p>
                <h1 className="text-lg font-bold text-[#0b2a55] tracking-wide uppercase leading-tight">OceanWatch</h1>
              </div>
            </div>

            <form onSubmit={submit} className="px-6 py-5 space-y-4">
              <div>
                <h2 className="font-semibold text-gray-900">Sign in</h2>
                <p className="text-sm text-gray-600 mt-0.5">Use the official account issued to you.</p>
              </div>

              {error && (
                <div role="alert" className="flex gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <label className="block">
                <span className="block text-[0.8125rem] font-semibold text-gray-700 mb-1">Official email</span>
                <input
                  type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus
                  autoComplete="username" disabled={needsCode}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-[#0b2a55] focus:outline-none focus:ring-1 focus:ring-[#0b2a55] disabled:bg-gray-50 disabled:text-gray-500"
                />
              </label>

              <label className="block">
                <span className="block text-[0.8125rem] font-semibold text-gray-700 mb-1">Password</span>
                <input
                  type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
                  autoComplete="current-password" disabled={needsCode}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-[#0b2a55] focus:outline-none focus:ring-1 focus:ring-[#0b2a55] disabled:bg-gray-50 disabled:text-gray-500"
                />
              </label>

              {needsCode && (
                <label className="block">
                  <span className="block text-[0.8125rem] font-semibold text-gray-700 mb-1">Code from your authenticator app</span>
                  <input
                    ref={codeRef} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    inputMode="numeric" autoComplete="one-time-code" maxLength={6} required
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono tracking-[0.3em] focus:border-[#0b2a55] focus:outline-none focus:ring-1 focus:ring-[#0b2a55]"
                  />
                  <button type="button" onClick={() => { setNeedsCode(false); setCode(''); setError(null); }}
                    className="mt-2 text-[0.75rem] font-semibold text-[#0b2a55] hover:underline">
                    Use a different account
                  </button>
                </label>
              )}

              <button
                type="submit" disabled={busy}
                className="w-full rounded bg-[#0b2a55] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#123a70] disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in…</> : <><Lock className="w-4 h-4" /> Sign in</>}
              </button>

              <p className="text-[0.75rem] text-gray-500 leading-normal">
                Accounts are issued by the system administrator. Five wrong attempts lock an account for 15 minutes;
                every attempt is recorded in the audit trail.
              </p>
            </form>
          </div>

          <p className="mt-4 flex items-start gap-2 text-[0.75rem] text-gray-500 leading-normal">
            <ShieldCheck className="w-4 h-4 mt-px flex-shrink-0 text-gray-400" />
            <span>Authorised use only. What you can see and change depends on your role and clearance level.</span>
          </p>
        </div>
      </div>
    </div>
  );
}
