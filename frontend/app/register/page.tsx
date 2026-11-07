"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Check, Eye, EyeOff, Lock, Mail, User } from "lucide-react";
import { AuthLayout, Divider, FormError, GoogleIcon } from "@/components/auth/auth-layout";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function strength(pw: string) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}
const STRENGTH = ["Too short", "Weak", "Fair", "Good", "Strong"];

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<"form" | "google" | null>(null);

  const score = useMemo(() => (password.length < 8 ? 0 : strength(password)), [password]);
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError("Enter your name.");
    if (!EMAIL_RE.test(email.trim())) return setError("Enter a valid email address.");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords don’t match.");
    if (!accept) return setError("Please accept the Terms and Privacy Policy.");

    setLoading("form");
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, acceptTerms: accept }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not create your account.");
        setLoading(null);
        return;
      }
      // Sign straight in with the new credentials.
      const login = await signIn("credentials", { email, password, redirect: false });
      if (login && !login.error) {
        router.replace("/");
        router.refresh();
      } else {
        router.replace(`/login?registered=1&email=${encodeURIComponent(email)}`);
      }
    } catch {
      setError("Network error. Please try again.");
      setLoading(null);
    }
  };

  const google = () => {
    if (!accept) return setError("Please accept the Terms and Privacy Policy to continue.");
    setError(null);
    setLoading("google");
    signIn("google", { callbackUrl: "/" });
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Ask across your documents, the web and your tools"
      footer={<>Already have an account? <Link href="/login" className="font-medium text-accent hover:underline">Sign in</Link></>}
    >
      <FormError message={error} />

      <form onSubmit={submit} className="space-y-4" noValidate>
        <label className="block">
          <Label>Full name</Label>
          <Input autoComplete="name" required icon={<User />} placeholder="Ada Lovelace"
                 value={name} onChange={(e) => setName(e.target.value)} className="h-10" />
        </label>
        <label className="block">
          <Label>Email</Label>
          <Input type="email" autoComplete="email" required icon={<Mail />} placeholder="you@example.com"
                 value={email} onChange={(e) => setEmail(e.target.value)} className="h-10" />
        </label>
        <label className="block">
          <Label hint="8+ characters">Password</Label>
          <div className="relative">
            <Input type={show ? "text" : "password"} autoComplete="new-password" required icon={<Lock />}
                   placeholder="Create a password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10 pr-10" />
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}
                    className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted hover:text-ink">
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {password && (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex flex-1 gap-1">
                {[1, 2, 3, 4].map((i) => (
                  <span key={i} className={cn("h-1 flex-1 rounded-full transition-colors",
                    i <= score ? (score <= 1 ? "bg-danger" : score === 2 ? "bg-warn" : "bg-ok") : "bg-line")} />
                ))}
              </div>
              <span className="w-16 text-right text-[11.5px] text-muted">{STRENGTH[score]}</span>
            </div>
          )}
        </label>
        <label className="block">
          <Label>Confirm password</Label>
          <Input type={show ? "text" : "password"} autoComplete="new-password" required icon={<Lock />}
                 placeholder="Repeat your password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                 className={cn("h-10", mismatch && "border-danger/60 focus:border-danger/60 focus:ring-danger/15")}
                 aria-invalid={mismatch} />
          {mismatch && <span className="mt-1 block text-[12px] text-danger">Passwords don’t match.</span>}
        </label>

        <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-snug text-ink/85">
          <span className="relative mt-0.5 grid size-4 shrink-0 place-items-center">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)}
                   className="peer size-4 cursor-pointer appearance-none rounded border border-line bg-surface checked:border-accent checked:bg-accent focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/20" />
            <Check className="pointer-events-none absolute size-3 text-on-accent opacity-0 peer-checked:opacity-100" strokeWidth={3} />
          </span>
          <span>
            I agree to the <Link href="/terms" target="_blank" className="font-medium text-accent hover:underline">Terms &amp; Conditions</Link> and{" "}
            <Link href="/privacy" target="_blank" className="font-medium text-accent hover:underline">Privacy Policy</Link>.
          </span>
        </label>

        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading === "form"} disabled={loading !== null}>
          Create account
        </Button>
      </form>

      <Divider label="or" />

      <Button type="button" variant="secondary" size="lg" className="w-full" onClick={google}
              loading={loading === "google"} disabled={loading !== null}>
        {loading !== "google" && <GoogleIcon className="size-[18px]" />}
        Sign up with Google
      </Button>
    </AuthLayout>
  );
}
