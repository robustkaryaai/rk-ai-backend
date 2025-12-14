import { Client, Databases, Query, ID } from "node-appwrite";
import dotenv from "dotenv";

dotenv.config(); // ✅ THIS IS CRITICAL

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)     // ✅ MUST be full URL
  .setProject(process.env.APPWRITE_PROJECT_ID)    // ✅ Project ID
  .setKey(process.env.APPWRITE_API_KEY);          // ✅ THIS WAS MISSING

export const db = new Databases(client);

export async function getUserPlanBySlug(slug) {
  const res = await db.listDocuments(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    [Query.equal("slug", Number(slug))] // ✅ integer slug
  );

  if (!res.documents.length) {
    throw new Error("Invalid slug");
  }

  return res.documents[0];
}

export async function doesDeviceExist(slug) {
  const res = await db.listDocuments(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    [Query.equal("slug", Number(slug))]
  );

  return res.documents.length > 0;
}
export async function ensureDeviceBySlug(slug) {
  const res = await db.listDocuments(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    [Query.equal("slug", Number(slug))]
  );

  // 🟢 If exists, we're done
  if (res.documents.length > 0) {
    return true;
  }

  // 🔴 If not, create device
  await db.createDocument(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    ID.unique(),
    {
      slug: Number(slug),               // 9 digit number
      subscription: "false",
      "subscription-tier": 0,
      name_of_device: "RK AI",
      storage_limit_mb: 500,
      storageUsing: "supabase"
    }
  );

  return true;
}
