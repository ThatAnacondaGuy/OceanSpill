import { useState } from 'react';
import { KeyRound, Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { useStore } from '../store/store';
import { changePassword, enableMfa, startMfaSetup } from '../data/api';
import { setUserPassword, resetUserMfa } from '../data/server';
import { Button, Field, InfoBanner, Modal, TextInput } from './ui';

/** Your own password and second factor. Only shown when the site runs against a server. */
export function MyAccount() {
  const { currentUser, notify } = useStore();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [enrolling, setEnrolling] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');

  const savePassword = async () => {
    if (next !== repeat) {
      notify({ kind: 'error', title: 'Passwords do not match' });
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent(''); setNext(''); setRepeat('');
      notify({ kind: 'success', title: 'Password changed', body: 'Your other sessions have been signed out.' });
    } catch (e) {
      notify({ kind: 'error', title: 'Password not changed', body: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const beginMfa = async () => {
    try {
      setEnrolling(await startMfaSetup());
    } catch (e) {
      notify({ kind: 'error', title: 'Could not start enrolment', body: e instanceof Error ? e.message : undefined });
    }
  };

  const finishMfa = async () => {
    setBusy(true);
    try {
      await enableMfa(code);
      setEnrolling(null);
      setCode('');
      notify({ kind: 'success', title: 'Two-factor sign-in is on', body: 'You will be asked for a code at each sign-in.' });
    } catch (e) {
      notify({ kind: 'error', title: 'Code not accepted', body: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="Current password"><TextInput type="password" value={current} onChange={setCurrent} /></Field>
        <Field label="New password" hint="At least 12 characters, mixing three of: lower case, upper case, digits, symbols.">
          <TextInput type="password" value={next} onChange={setNext} />
        </Field>
        <Field label="Repeat new password"><TextInput type="password" value={repeat} onChange={setRepeat} /></Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy || !current || next.length < 12} onClick={() => void savePassword()}
          icon={busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}>
          Change password
        </Button>
        {currentUser.mfa ? (
          <span className="text-[0.75rem] text-emerald-700 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" /> Two-factor sign-in is on for this account.
          </span>
        ) : (
          <Button onClick={() => void beginMfa()} icon={<Smartphone className="w-3 h-3" />}>Set up two-factor sign-in</Button>
        )}
      </div>

      <Modal open={Boolean(enrolling)} onClose={() => setEnrolling(null)} title="Set up two-factor sign-in"
        subtitle="Add this account to an authenticator app, then enter the code it shows."
        footer={<>
          <Button onClick={() => setEnrolling(null)}>Cancel</Button>
          <Button variant="primary" disabled={busy || code.length < 6} onClick={() => void finishMfa()}>Turn it on</Button>
        </>}>
        <div className="space-y-4">
          <Field label="Setup key" hint="Type this into the app if it cannot scan a code.">
            <code className="block break-all rounded border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-[0.8125rem]">{enrolling?.secret}</code>
          </Field>
          <Field label="Code from the app">
            <TextInput value={code} onChange={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} placeholder="000000" />
          </Field>
          <InfoBanner tone="amber">
            Keep the setup key somewhere safe. Without the app and without the key, an administrator has to reset
            the second factor before you can sign in again.
          </InfoBanner>
        </div>
      </Modal>
    </div>
  );
}

/** Setting another account's password, for an administrator handing over credentials in person. */
export function SetPasswordModal({ userId, userName, onClose }: { userId: string | null; userName: string; onClose: () => void }) {
  const { notify } = useStore();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      await setUserPassword(userId, password);
      setPassword('');
      notify({ kind: 'success', title: 'Password set', body: `${userName} can sign in with it once. Any open sessions were ended.` });
      onClose();
    } catch (e) {
      notify({ kind: 'error', title: 'Password not set', body: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={Boolean(userId)} onClose={onClose} title={`Set a password for ${userName}`}
      subtitle="Give it to the account holder directly, and ask them to change it after signing in."
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || password.length < 12} onClick={() => void save()}>Set password</Button>
      </>}>
      <div className="space-y-4">
        <Field label="New password" hint="At least 12 characters, mixing three of: lower case, upper case, digits, symbols.">
          <TextInput type="password" value={password} onChange={setPassword} />
        </Field>
        <InfoBanner tone="amber">
          Setting a password ends every session that account has open, and the change is recorded in the audit trail
          against your name.
        </InfoBanner>
      </div>
    </Modal>
  );
}

export { resetUserMfa };
