import { MongoClient, type Db } from "mongodb";

/**
 * One MongoClient per server process. In dev, Next.js hot-reloads modules, so the
 * client is cached on globalThis to avoid opening a new connection pool on every edit.
 */
const uri = process.env.MONGODB_URI;

declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

function clientPromise(): Promise<MongoClient> {
  if (!uri || uri.includes("<cluster>") || uri.includes("cluster0.abcde")) {
    throw new Error("MONGODB_URI is not set to a valid MongoDB Atlas cluster host. Update MONGODB_URI in frontend/.env.local.");
  }
  if (!global._mongoClientPromise) {
    global._mongoClientPromise = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 }).connect().then(async (client) => {
      await ensureIndexes(client.db());
      return client;
    }).catch((err) => {
      global._mongoClientPromise = undefined; // let the next request retry
      throw err;
    });
  }
  return global._mongoClientPromise;
}

async function ensureIndexes(db: Db) {
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
}

/** The database named in MONGODB_URI (the path segment after the host). */
export async function getDb(): Promise<Db> {
  return (await clientPromise()).db();
}

export type UserDoc = {
  email: string;
  name: string;
  image?: string | null;
  passwordHash?: string;          // absent for Google-only accounts
  providers: ("credentials" | "google")[];
  acceptedTermsAt?: Date;
  createdAt: Date;
  lastLoginAt?: Date;
};

export async function users() {
  return (await getDb()).collection<UserDoc>("users");
}
