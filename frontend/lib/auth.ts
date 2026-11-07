import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { users } from "@/lib/mongodb";

export const authOptions: NextAuthOptions = {
  debug: process.env.NODE_ENV === "development",
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/login", error: "/login" },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
    CredentialsProvider({
      name: "Email",
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password;
        if (!email || !password) return null;
        const col = await users();
        const user = await col.findOne({ email });
        if (!user?.passwordHash) return null; // unknown email, or a Google-only account
        if (!(await bcrypt.compare(password, user.passwordHash))) return null;
        await col.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
        return { id: user._id.toString(), email: user.email, name: user.name, image: user.image ?? null };
      },
    }),
  ],
  callbacks: {
    /** Google sign-ins create (or link to) a user document keyed by email. */
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return true;
      const email = user.email?.toLowerCase();
      if (!email || (profile as { email_verified?: boolean } | undefined)?.email_verified === false) return false;
      const now = new Date();
      try {
        await (await users()).updateOne(
          { email },
          {
            $setOnInsert: { email, createdAt: now, acceptedTermsAt: now },
            $set: { name: user.name ?? email, image: user.image ?? null, lastLoginAt: now },
            $addToSet: { providers: "google" },
          },
          { upsert: true },
        );
      } catch (err) {
        console.error("Failed to sync user to MongoDB:", err);
        // Do not block authentication if MongoDB connection fails or is not yet configured
      }
      return true;
    },
    async jwt({ token, user, account }) {
      // On first sign-in, pin the token to our Mongo user id (Google's `user.id` is its own sub).
      if (user && account) {
        try {
          const doc = await (await users()).findOne({ email: (user.email ?? "").toLowerCase() }, { projection: { _id: 1 } });
          if (doc) token.uid = doc._id.toString();
        } catch (err) {
          console.error("MongoDB error in jwt callback:", err);
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.uid) (session.user as { id?: string }).id = token.uid as string;
      return session;
    },
  },
};
