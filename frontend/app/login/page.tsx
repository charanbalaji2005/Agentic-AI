"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Eye, EyeOff, Lock, Mail } from "lucide-react";
import { AuthLayout, Divider, FormError, GoogleIcon } from "@/components/auth/auth-layout";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

const ERRORS: Record<string, string> = {
  CredentialsSignin: "Incorrect email or password.",
  AccessDenied: "Access denied. Your Google email is not permitted or unverified.",
  OAuthSignin: "Could not initiate Google sign-in. Check your Google OAuth Client ID and secret.",
  OAuthCallback: "Google sign-in callback failed. Verify the Authorized redirect URI in Google Cloud Console.",
  OAuthCreateAccount: "Could not create user account from Google profile.",
  EmailCreateAccount: "Could not create user account.",
  Callback: "Sign-in failed. Please try again.",
  OAuthAccountNotLinked: "This email is already associated with another login method.",
  Configuration: "Authentication configuration error. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
  Default: "Something went wrong. Please try again.",
};

/** Only allow redirects back into this app. */
function safeCallback(url: string | null) {
  if (!url) return "/";
  try {
    const u = new URL(url, window.location.origin);
    return u.origin === window.location.origin ? u.pathname + u.search : "/";
  } catch {
    return "/";
  }
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const callbackUrl = () => safeCallback(params.get("callbackUrl"));
  const initialError = params.get("error");
  const justRegistered = params.get("registered") === "1";

  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(initialError ? ERRORS[initialError] ?? ERRORS.Default : null);
  const [loading, setLoading] = useState<"credentials" | "google" | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading("credentials");
    const res = await signIn("credentials", { email, password, redirect: false });
    if (!res || res.error) {
      setError(ERRORS[res?.error ?? ""] ?? ERRORS.CredentialsSignin);
      setLoading(null);
      return;
    }
    router.replace(callbackUrl());
    router.refresh();
  };

  const google = () => {
    setError(null);
    setLoading("google");
    signIn("google", { callbackUrl: callbackUrl() });
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to continue to Agentic RAG"
      footer={<>Don&apos;t have an account? <Link href="/register" className="font-medium text-accent hover:underline">Create one</Link></>}
    >
      {justRegistered && !error && (
        <p className="mb-4 rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-[13px] text-ok">Account created. Sign in to continue.</p>
      )}
      <FormError message={error} />

      <Button type="button" variant="secondary" size="lg" className="w-full" onClick={google}
              loading={loading === "google"} disabled={loading !== null}>
        {loading !== "google" && <GoogleIcon className="size-[18px]" />}
        Continue with Google
      </Button>

      <Divider label="or" />

      <form onSubmit={submit} className="space-y-4" noValidate>
        <label className="block">
          <Label>Email</Label>
          <Input type="email" autoComplete="email" required icon={<Mail />} placeholder="you@example.com"
                 value={email} onChange={(e) => setEmail(e.target.value)} className="h-10" />
        </label>
        <label className="block">
          <Label>Password</Label>
          <div className="relative">
            <Input type={show ? "text" : "password"} autoComplete="current-password" required icon={<Lock />}
                   placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10 pr-10" />
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}
                    className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted hover:text-ink">
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </label>
        <Button type="submit" variant="primary" size="lg" className="w-full"
                loading={loading === "credentials"} disabled={loading !== null || !email || !password}>
          Sign in
        </Button>
      </form>

      <p className="mt-5 text-center text-[12px] leading-relaxed text-muted">
        By continuing you agree to our <Link href="/terms" className="underline hover:text-ink">Terms</Link> and{" "}
        <Link href="/privacy" className="underline hover:text-ink">Privacy Policy</Link>.
      </p>
    </AuthLayout>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
