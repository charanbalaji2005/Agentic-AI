import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { MongoServerError } from "mongodb";
import { users } from "@/lib/mongodb";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  let body: { name?: string; email?: string; password?: string; acceptTerms?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const name = body.name?.trim() ?? "";
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";

  if (name.length < 2 || name.length > 80) return NextResponse.json({ error: "Enter your name (2–80 characters)." }, { status: 400 });
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  if (password.length < 8 || password.length > 128) return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  if (!body.acceptTerms) return NextResponse.json({ error: "You must accept the Terms and Privacy Policy." }, { status: 400 });

  try {
    const col = await users();
    const existing = await col.findOne({ email }, { projection: { passwordHash: 1 } });
    if (existing) {
      const msg = existing.passwordHash
        ? "An account with this email already exists. Sign in instead."
        : "This email is registered with Google. Use “Continue with Google”.";
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    const now = new Date();
    await col.insertOne({
      name, email, passwordHash: await bcrypt.hash(password, 12),
      providers: ["credentials"], acceptedTermsAt: now, createdAt: now,
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
    }
    console.error("register failed", err);
    return NextResponse.json({ error: "Could not create your account. Please try again." }, { status: 500 });
  }
}
