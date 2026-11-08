import fs from "fs";
import os from "os";
import path from "path";
import { MongoClient, type Db } from "mongodb";

const uri = process.env.MONGODB_URI;

declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

export type UserDoc = {
  email: string;
  name: string;
  image?: string | null;
  passwordHash?: string; // absent for Google-only accounts
  providers: ("credentials" | "google")[];
  acceptedTermsAt?: Date;
  createdAt: Date;
  lastLoginAt?: Date;
};

// -----------------------------------------------------------------------------
// Fallback Local File Storage (used when MONGODB_URI is unconfigured or offline)
// -----------------------------------------------------------------------------
function getFallbackFilePath(): string {
  const primary = path.join(process.cwd(), "data", "users_auth.json");
  try {
    const dir = path.dirname(primary);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return primary;
  } catch {
    return path.join(os.tmpdir(), "users_auth.json");
  }
}

function readFallbackUsers(): Record<string, UserDoc> {
  const filePath = getFallbackFilePath();
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function writeFallbackUsers(data: Record<string, UserDoc>) {
  const filePath = getFallbackFilePath();
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write fallback users to", filePath, err);
  }
}

const fallbackCollection = {
  async findOne(query: { email?: string; _id?: any }) {
    const all = readFallbackUsers();
    const email = (query.email ?? "").toLowerCase();
    const u = all[email];
    if (!u) return null;
    return { ...u, _id: { toString: () => u.email } };
  },
  async insertOne(doc: UserDoc) {
    const all = readFallbackUsers();
    const email = doc.email.toLowerCase();
    if (all[email]) {
      const err = new Error("Duplicate email");
      (err as any).code = 11000;
      throw err;
    }
    all[email] = { ...doc, email };
    writeFallbackUsers(all);
    return { insertedId: email };
  },
  async updateOne(filter: { email?: string; _id?: any }, update: any, options?: { upsert?: boolean }) {
    const all = readFallbackUsers();
    const email = (filter.email ?? "").toLowerCase();
    const existing = all[email];
    if (!existing) {
      if (options?.upsert) {
        const setOnInsert = update.$setOnInsert ?? {};
        const set = update.$set ?? {};
        const prov = update.$addToSet?.providers;
        const providers: ("credentials" | "google")[] = prov ? [prov] : ["google"];
        all[email] = {
          email,
          name: set.name ?? setOnInsert.name ?? email,
          image: set.image ?? null,
          providers,
          createdAt: setOnInsert.createdAt ?? new Date(),
          lastLoginAt: set.lastLoginAt ?? new Date(),
        };
        writeFallbackUsers(all);
      }
      return { modifiedCount: 0, upsertedCount: options?.upsert ? 1 : 0 };
    }
    if (update.$set) Object.assign(existing, update.$set);
    if (update.$addToSet?.providers && !existing.providers.includes(update.$addToSet.providers)) {
      existing.providers.push(update.$addToSet.providers);
    }
    writeFallbackUsers(all);
    return { modifiedCount: 1, upsertedCount: 0 };
  },
};

// -----------------------------------------------------------------------------
// MongoDB Atlas Connection Pool
// -----------------------------------------------------------------------------
function isPlaceholderUri(str?: string): boolean {
  if (!str) return true;
  return str.includes("<cluster>") || str.includes("cluster0.abcde") || !str.startsWith("mongodb");
}

function clientPromise(): Promise<MongoClient> {
  if (isPlaceholderUri(uri)) {
    throw new Error("MONGODB_URI is not set to a valid cluster host.");
  }
  if (!global._mongoClientPromise) {
    global._mongoClientPromise = new MongoClient(uri!, { serverSelectionTimeoutMS: 4000 })
      .connect()
      .then(async (client) => {
        await ensureIndexes(client.db());
        return client;
      })
      .catch((err) => {
        global._mongoClientPromise = undefined;
        throw err;
      });
  }
  return global._mongoClientPromise;
}

async function ensureIndexes(db: Db) {
  try {
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
  } catch (err) {
    console.warn("Could not create mongo index:", err);
  }
}

export async function getDb(): Promise<Db> {
  return (await clientPromise()).db();
}

/**
 * Returns the MongoDB `users` collection, or automatically falls back to a safe
 * local user store if MongoDB Atlas is not yet configured or temporarily offline.
 */
export async function users() {
  if (isPlaceholderUri(uri)) {
    return fallbackCollection as any;
  }
  try {
    return (await getDb()).collection<UserDoc>("users");
  } catch (err) {
    console.warn("MongoDB unavailable, using local user store fallback:", err);
    return fallbackCollection as any;
  }
}
